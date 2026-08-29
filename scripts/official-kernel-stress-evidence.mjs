#!/usr/bin/env node

import Database from "better-sqlite3";
import path from "node:path";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "queue_timeout", "recovery_required"]);
const ACTIVE_STATES = new Set(["active"]);
const START_STATES = new Set(["admitted", "starting", "dispatch_intent"]);

class EvidenceError extends Error {
  constructor(kind) {
    super(kind);
    this.name = "EvidenceError";
    this.kind = kind;
  }
}

function integer(value, minimum) {
  if (!/^(?:0|[1-9]\d*)$/.test(value ?? "")) throw new EvidenceError("invalid_arguments");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new EvidenceError("invalid_arguments");
  return parsed;
}

function parseArguments(argv) {
  const values = new Map();
  const names = new Set([
    "database",
    "expected-runs",
    "max-active-turns",
    "max-concurrent-starts",
    "min-start-interval-ms"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || !names.has(token.slice(2))) throw new EvidenceError("invalid_arguments");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(token.slice(2))) {
      throw new EvidenceError("invalid_arguments");
    }
    values.set(token.slice(2), value);
    index += 1;
  }
  for (const name of names) {
    if (!values.has(name)) throw new EvidenceError("invalid_arguments");
  }
  const database = values.get("database");
  if (typeof database !== "string" || !path.isAbsolute(database)) throw new EvidenceError("invalid_arguments");
  return {
    database: path.resolve(database),
    expectedRuns: integer(values.get("expected-runs"), 1),
    maxActiveTurns: integer(values.get("max-active-turns"), 1),
    maxConcurrentStarts: integer(values.get("max-concurrent-starts"), 1),
    minStartIntervalMs: integer(values.get("min-start-interval-ms"), 2_000)
  };
}

function numberValue(row, key) {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceError("invalid_evidence");
  }
  return value;
}

function stateCount(rows, state) {
  const row = rows.find((candidate) => candidate.state === state);
  return row === undefined ? 0 : numberValue(row, "count");
}

function eventHighWater(events, states) {
  let current = 0;
  let maximum = 0;
  for (const event of events) {
    if (states.has(event.from_state)) current -= 1;
    if (states.has(event.to_state)) current += 1;
    if (current < 0) throw new EvidenceError("invalid_evidence");
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function queueHighWater(events) {
  return eventHighWater(events, new Set(["queued"]));
}

function minStartGap(events) {
  const starts = events.map((event) => numberValue(event, "occurred_at"));
  if (starts.length < 2) return null;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < starts.length; index += 1) {
    minimum = Math.min(minimum, starts[index] - starts[index - 1]);
  }
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new EvidenceError("invalid_evidence");
  return minimum;
}

function startHistoryIsConsistent(startHistory, startEvents) {
  const durableStartTimes = new Set(startEvents.map((event) => numberValue(event, "occurred_at")));
  return startHistory.every((row) => durableStartTimes.has(numberValue(row, "started_at")));
}

function inspect(options) {
  const database = new Database(options.database, { readonly: true, fileMustExist: true });
  try {
    const policy = database.prepare(
      `SELECT max_active_turns, max_concurrent_starts, min_start_interval_ms
       FROM policy_state WHERE id = 1`
    ).get();
    if (
      numberValue(policy, "max_active_turns") !== options.maxActiveTurns ||
      numberValue(policy, "max_concurrent_starts") !== options.maxConcurrentStarts ||
      numberValue(policy, "min_start_interval_ms") !== options.minStartIntervalMs
    ) {
      throw new EvidenceError("policy_mismatch");
    }

    const stateRows = database.prepare(
      "SELECT state, COUNT(*) AS count FROM turn_requests GROUP BY state ORDER BY state"
    ).all();
    const events = database.prepare(
      "SELECT event_seq, kind, from_state, to_state, occurred_at FROM events ORDER BY event_seq ASC"
    ).all();
    // markStarting prunes this table, so it can corroborate only current-window rows.
    const startHistory = database.prepare("SELECT started_at FROM start_history ORDER BY started_at ASC").all();
    const startEvents = database.prepare(
      `SELECT event_seq, occurred_at
       FROM events
       WHERE kind = 'request_starting'
         AND from_state = 'admitted'
         AND to_state = 'starting'
       ORDER BY occurred_at ASC, event_seq ASC`
    ).all();
    const leases = numberValue(database.prepare("SELECT COUNT(*) AS count FROM leases").get(), "count");
    const payloads = numberValue(database.prepare("SELECT COUNT(*) AS count FROM turn_payloads").get(), "count");

    const requestCount = stateRows.reduce((total, row) => total + numberValue(row, "count"), 0);
    const nonterminal = stateRows.reduce(
      (total, row) => total + (TERMINAL_STATES.has(row.state) ? 0 : numberValue(row, "count")),
      0
    );
    const maxActiveObserved = eventHighWater(events, ACTIVE_STATES);
    const maxStartsObserved = eventHighWater(events, START_STATES);
    const maxQueuedObserved = queueHighWater(events);
    const startEventsObserved = startEvents.length;
    const observedStartGapMs = minStartGap(startEvents);
    const startHistoryConsistent = startHistoryIsConsistent(startHistory, startEvents);
    const enqueued = events.filter((event) => event.kind === "request_enqueued").length;
    const admitted = events.filter((event) => event.kind === "request_admitted").length;

    if (requestCount < options.expectedRuns || enqueued < options.expectedRuns || admitted < options.expectedRuns) {
      throw new EvidenceError("incomplete_runs");
    }
    if (maxActiveObserved > options.maxActiveTurns || maxStartsObserved > options.maxConcurrentStarts) {
      throw new EvidenceError("configured_bound_exceeded");
    }
    if (maxQueuedObserved < 1) throw new EvidenceError("queue_progress_missing");
    if (startEventsObserved < options.expectedRuns) throw new EvidenceError("start_evidence_missing");
    if (options.expectedRuns >= 2 && observedStartGapMs === null) throw new EvidenceError("start_evidence_missing");
    if (observedStartGapMs !== null && observedStartGapMs < options.minStartIntervalMs) {
      throw new EvidenceError("start_interval_violated");
    }
    if (!startHistoryConsistent) throw new EvidenceError("invalid_evidence");
    if (leases !== 0 || payloads !== 0 || nonterminal !== 0) throw new EvidenceError("resource_release_missing");

    return {
      ok: true,
      policy: {
        maxActiveTurns: options.maxActiveTurns,
        maxConcurrentStarts: options.maxConcurrentStarts,
        minStartIntervalMs: options.minStartIntervalMs
      },
      runs: { expected: options.expectedRuns, observed: requestCount, enqueued, admitted },
      bounds: {
        maxActiveObserved,
        maxStartsObserved,
        startEventsObserved,
        minStartGapMs: observedStartGapMs,
        startHistoryObserved: startHistory.length,
        startHistoryConsistent
      },
      queue: { maxQueuedObserved, progressed: admitted > 0 },
      release: { leases, payloads, nonterminal }
    };
  } finally {
    database.close();
  }
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(inspect(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    const failure = error instanceof EvidenceError ? error.kind : "invalid_evidence";
    process.stdout.write(`${JSON.stringify({ ok: false, failure })}\n`);
    process.exitCode = 1;
  }
}

main();
