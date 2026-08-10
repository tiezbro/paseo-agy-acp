// Strict SQLite-only provider evidence for the v2.0 admission integration.
//
// This module never discovers a conversation by scanning a directory. A caller
// must bind one exact conversation ID first; the directory reader then opens
// only `<bound-id>.db`. Snapshot readers are injected so the admission seam can
// be tested without a provider process and can fail closed on any uncertainty.

import { ConversationDb } from "./database.js";
import type { StepRow } from "./types.js";
import type { OfficialTerminalObservation, OfficialTerminalStatus } from "../../admission/terminal-evidence.js";

type MaybePromise<T> = T | Promise<T>;

const SAFE_SIGNALS = new Set([
  "UNAVAILABLE",
  "MODEL_CAPACITY_EXHAUSTED",
  "QUOTA_EXHAUSTED",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED"
]);
const SNAPSHOT_FIELDS = new Set(["conversationId", "cursor", "latest", "backgroundTasks"]);
const ROW_FIELDS = new Set(["cursor", "kind", "status", "httpStatus", "code", "reason"]);
const PROVIDER_RESPONSE_FIELDS = new Set(["error"]);
const PROVIDER_ERROR_FIELDS = new Set(["code", "status", "details"]);
const PROVIDER_DETAIL_FIELDS = new Set(["reason"]);

export interface SqliteProviderSnapshotReader {
  /** Reads evidence for the exact caller-bound conversation ID, or no evidence. */
  readonly readSnapshot: (conversationId: string) => MaybePromise<SqliteProviderSnapshot | null>;
}

/** The safe projection a reader may expose; it contains no SQLite payload text. */
export interface SqliteProviderSnapshot {
  readonly conversationId: string;
  readonly cursor: number;
  readonly latest: SqliteProviderCursorRow;
  readonly backgroundTasks: "settled" | "active";
}

/** The cursor-bearing latest record used for activity or terminal evidence. */
export interface SqliteProviderCursorRow {
  readonly cursor: number;
  readonly kind: "activity" | "terminal";
  readonly status: "ACTIVE" | OfficialTerminalStatus;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly reason?: string;
}

export interface SqliteProviderObserverOptions {
  readonly reader: SqliteProviderSnapshotReader;
  /** Injectable clock keeps observations deterministic without accepting source timestamps. */
  readonly now?: () => number;
}

export interface SqliteProviderDirectoryOptions {
  readonly now?: () => number;
}

/** A deliberately small, non-payload-bearing SQLite activity record. */
export interface SqliteProviderActivity {
  readonly source: "sqlite_reconciliation";
  readonly conversationId: string;
  readonly cursor: number;
  readonly observedAt: number;
  readonly status: "ACTIVE";
}

export type SqliteProviderActivityObservation =
  | Readonly<{ status: "observed"; activity: SqliteProviderActivity }>
  | Readonly<{ status: "unobserved" }>;

/**
 * Bound before any SQLite access. `observeTerminal` returns `null` rather than
 * an ambiguous terminal, and emits one observed terminal at most once.
 */
export interface BoundSqliteProviderObserver {
  observeActivity(): Promise<SqliteProviderActivityObservation>;
  observeTerminal(): Promise<OfficialTerminalObservation | null>;
}

/**
 * A strict source adapter intended for later SQLite-primary dispatcher wiring.
 * It does not own a provider process, lifecycle, or terminal delivery.
 */
export class SqliteProviderObserver {
  readonly #reader: SqliteProviderSnapshotReader;
  readonly #now: () => number;

  constructor(options: SqliteProviderObserverOptions) {
    this.#reader = options.reader;
    this.#now = options.now ?? Date.now;
  }

  bind(conversationId: string): BoundSqliteProviderObserver {
    requireConversationId(conversationId);
    return new BoundObserver(this.#reader, this.#now, conversationId);
  }
}

export function createSqliteProviderObserver(options: SqliteProviderObserverOptions): SqliteProviderObserver {
  return new SqliteProviderObserver(options);
}

/**
 * Build the real read-only SQLite reader. It opens only the bound conversation
 * path; it never falls back to another database in the directory.
 */
export function createSqliteProviderObserverForDirectory(
  directory: string,
  options: SqliteProviderDirectoryOptions = {}
): SqliteProviderObserver {
  return createSqliteProviderObserver({
    reader: createSqliteProviderSnapshotReader(directory),
    now: options.now
  });
}

/** Exposed separately so every source reader can be substituted in a test. */
export function createSqliteProviderSnapshotReader(directory: string): SqliteProviderSnapshotReader {
  requireDirectory(directory);
  return Object.freeze({
    readSnapshot(conversationId: string): SqliteProviderSnapshot | null {
      return readSnapshotFromSqlite(directory, conversationId);
    }
  });
}

class BoundObserver implements BoundSqliteProviderObserver {
  readonly #reader: SqliteProviderSnapshotReader;
  readonly #now: () => number;
  readonly #conversationId: string;
  #terminalIssued = false;
  #terminalReadInProgress = false;

  constructor(reader: SqliteProviderSnapshotReader, now: () => number, conversationId: string) {
    this.#reader = reader;
    this.#now = now;
    this.#conversationId = conversationId;
  }

  async observeActivity(): Promise<SqliteProviderActivityObservation> {
    const snapshot = await readValidatedSnapshot(this.#reader, this.#conversationId);
    if (
      snapshot === null ||
      snapshot.conversationId !== this.#conversationId ||
      snapshot.latest.kind !== "activity" ||
      snapshot.latest.status !== "ACTIVE"
    ) {
      return unobservedActivity();
    }

    const observedAt = readObservedAt(this.#now);
    if (observedAt === null) return unobservedActivity();

    return Object.freeze({
      status: "observed" as const,
      activity: Object.freeze({
        source: "sqlite_reconciliation" as const,
        conversationId: this.#conversationId,
        cursor: snapshot.cursor,
        observedAt,
        status: "ACTIVE" as const
      })
    });
  }

  async observeTerminal(): Promise<OfficialTerminalObservation | null> {
    if (this.#terminalIssued || this.#terminalReadInProgress) return null;
    this.#terminalReadInProgress = true;

    try {
      const snapshot = await readValidatedSnapshot(this.#reader, this.#conversationId);
      if (
        snapshot === null ||
        snapshot.conversationId !== this.#conversationId ||
        snapshot.backgroundTasks !== "settled" ||
        snapshot.latest.kind !== "terminal"
      ) {
        return null;
      }

      const observedAt = readObservedAt(this.#now);
      if (observedAt === null) return null;

      const observation = toOfficialTerminal(this.#conversationId, observedAt, snapshot.latest);
      if (observation === null) return null;

      this.#terminalIssued = true;
      return observation;
    } catch {
      return null;
    } finally {
      this.#terminalReadInProgress = false;
    }
  }
}

async function readValidatedSnapshot(
  reader: unknown,
  conversationId: string
): Promise<SqliteProviderSnapshot | null> {
  try {
    if (!isPlainRecord(reader)) return null;
    const readSnapshot = reader.readSnapshot;
    if (typeof readSnapshot !== "function") return null;
    const source = await readSnapshot.call(reader, conversationId);
    return parseSnapshot(source);
  } catch {
    return null;
  }
}

function parseSnapshot(value: unknown): SqliteProviderSnapshot | null {
  const fields = exactRecord(value, SNAPSHOT_FIELDS, ["conversationId", "cursor", "latest", "backgroundTasks"]);
  if (fields === null) return null;

  const conversationId = readConversationId(fields.conversationId);
  const cursor = readCursor(fields.cursor);
  const latest = parseProviderRow(fields.latest);
  const backgroundTasks = fields.backgroundTasks;
  if (
    conversationId === null ||
    cursor === null ||
    latest === null ||
    latest.cursor !== cursor ||
    (backgroundTasks !== "settled" && backgroundTasks !== "active")
  ) {
    return null;
  }

  return Object.freeze({ conversationId, cursor, latest, backgroundTasks });
}

function parseProviderRow(value: unknown): SqliteProviderCursorRow | null {
  const fields = exactRecord(value, ROW_FIELDS, ["cursor", "kind", "status"]);
  if (fields === null) return null;

  const cursor = readCursor(fields.cursor);
  if (cursor === null || (fields.kind !== "activity" && fields.kind !== "terminal")) return null;

  const httpStatus = readOptionalHttpStatus(fields, "httpStatus");
  const code = readOptionalSignal(fields, "code");
  const reason = readOptionalSignal(fields, "reason");
  if (httpStatus === null || code === null || reason === null) return null;

  if (fields.kind === "activity") {
    if (fields.status !== "ACTIVE" || httpStatus !== undefined || code !== undefined || reason !== undefined) {
      return null;
    }
    return Object.freeze({ cursor, kind: "activity" as const, status: "ACTIVE" as const });
  }

  if (!isOfficialTerminalStatus(fields.status)) return null;
  if (fields.status !== "ERROR") {
    if (httpStatus !== undefined || code !== undefined || reason !== undefined) return null;
    return Object.freeze({ cursor, kind: "terminal" as const, status: fields.status });
  }

  if (!hasSafeFailureSemantics(httpStatus, code, reason)) return null;
  return Object.freeze({
    cursor,
    kind: "terminal" as const,
    status: "ERROR" as const,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason })
  });
}

function toOfficialTerminal(
  conversationId: string,
  observedAt: number,
  row: SqliteProviderCursorRow
): OfficialTerminalObservation | null {
  if (row.kind !== "terminal" || !isOfficialTerminalStatus(row.status)) return null;
  if (row.status !== "ERROR") {
    return Object.freeze({
      source: "sqlite_reconciliation" as const,
      conversationId,
      observedAt,
      status: row.status
    });
  }

  if (!hasSafeFailureSemantics(row.httpStatus, row.code, row.reason)) return null;
  return Object.freeze({
    source: "sqlite_reconciliation" as const,
    conversationId,
    observedAt,
    status: "ERROR" as const,
    ...(row.httpStatus === undefined ? {} : { httpStatus: row.httpStatus }),
    ...(row.code === undefined ? {} : { code: row.code }),
    ...(row.reason === undefined ? {} : { reason: row.reason })
  });
}

function hasSafeFailureSemantics(
  httpStatus: number | undefined,
  code: string | undefined,
  reason: string | undefined
): boolean {
  const signals = [code, reason].filter((value): value is string => value !== undefined);
  const hasCapacity = signals.some((value) => value === "UNAVAILABLE" || value === "MODEL_CAPACITY_EXHAUSTED");
  const hasQuota = signals.includes("QUOTA_EXHAUSTED");

  // Capacity and quota signals become meaningful only with their official
  // paired HTTP statuses. Contradictory source rows are not evidence.
  if (hasCapacity && httpStatus !== 503) return false;
  if (hasQuota && httpStatus !== 429) return false;
  if (hasCapacity && hasQuota) return false;
  return true;
}

function readSnapshotFromSqlite(directory: string, conversationId: string): SqliteProviderSnapshot | null {
  if (readConversationId(conversationId) === null) return null;

  let db: ConversationDb | null = null;
  try {
    db = ConversationDb.open(directory, conversationId);
    if (db === null) return null;

    const rows = db.readAfter(-1);
    if (rows.hasDecodeError) return null;
    return snapshotFromRows(conversationId, rows);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A failed close cannot turn an unavailable read into evidence.
    }
  }
}

function snapshotFromRows(conversationId: string, rows: readonly StepRow[]): SqliteProviderSnapshot | null {
  if (!areOrderedRows(rows) || rows.length === 0) return null;
  const latest = rows.at(-1)!;
  const backgroundTasks = hasUnfinishedBackgroundTasks(rows) ? "active" : "settled";

  if (latest.status === 1 || latest.status === 2) {
    return Object.freeze({
      conversationId,
      cursor: latest.idx,
      latest: Object.freeze({ cursor: latest.idx, kind: "activity" as const, status: "ACTIVE" as const }),
      backgroundTasks
    });
  }

  const terminal = terminalRowFromRows(rows, backgroundTasks);
  if (terminal === null) return null;
  return Object.freeze({ conversationId, cursor: latest.idx, latest: terminal, backgroundTasks });
}

function areOrderedRows(rows: readonly StepRow[]): boolean {
  let previous = -1;
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !Number.isSafeInteger(row.idx) ||
      row.idx < 0 ||
      row.idx <= previous ||
      !Number.isSafeInteger(row.stepType) ||
      !Number.isSafeInteger(row.status)
    ) {
      return false;
    }
    previous = row.idx;
  }
  return true;
}

function hasUnfinishedBackgroundTasks(rows: readonly StepRow[]): boolean {
  const taskStates = new Map<string, boolean>();
  for (const row of rows) {
    const task = row.task;
    if (task === undefined || task === null) continue;
    const taskId = task.taskId;
    if (!isSafeIdentifier(taskId)) return true;
    if (!taskStates.has(taskId)) taskStates.set(taskId, false);

    if (
      row.stepType === 21 &&
      isTerminalStepStatus(row.status) &&
      typeof row.stepPayload.commandResult?.exitCode === "number" &&
      Number.isFinite(row.stepPayload.commandResult.exitCode)
    ) {
      taskStates.set(taskId, true);
    }
  }
  return [...taskStates.values()].some((completed) => !completed);
}

function terminalRowFromRows(
  rows: readonly StepRow[],
  backgroundTasks: "settled" | "active"
): SqliteProviderCursorRow | null {
  const latest = rows.at(-1)!;
  // The streaming implementation treats a terminal step as insufficient while
  // background work remains. Require the final stop-hook marker as well, so an
  // intermediate completed tool row cannot be synthesized into success.
  if (
    backgroundTasks !== "settled" ||
    latest.stepType !== 101 ||
    !isTerminalStepStatus(latest.status) ||
    rows.some((row) => !isTerminalStepStatus(row.status))
  ) {
    return null;
  }

  const preceding = rows.length > 1 ? rows[rows.length - 2] : undefined;
  const providerErrorRow = latest.stepPayload.modelProviderError !== undefined
    ? latest
    : preceding?.stepPayload.modelProviderError !== undefined
      ? preceding
      : undefined;
  if (providerErrorRow !== undefined) {
    if (!isTerminalStepStatus(providerErrorRow.status)) return null;
    const providerTerminal = terminalRowFromProviderError(providerErrorRow);
    return providerTerminal === null
      ? null
      : Object.freeze({ ...providerTerminal, cursor: latest.idx });
  }

  // A completed stop-hook is structured end-of-turn evidence. Cancellation
  // and failure statuses lack a precise official provider terminal state here,
  // so they remain unobserved rather than being coerced into success.
  return latest.status === 3
    ? Object.freeze({ cursor: latest.idx, kind: "terminal" as const, status: "SUCCESS" as const })
    : null;
}

function terminalRowFromProviderError(row: StepRow): SqliteProviderCursorRow | null {
  const providerError = row.stepPayload.modelProviderError;
  if (providerError === undefined) return null;
  const parsed = parseProviderResponse(providerError.responseJson);
  if (parsed === null) return null;

  if (parsed.status === "CANCELED" || parsed.status === "INTERRUPTED") {
    if (parsed.httpStatus !== undefined || parsed.code !== undefined || parsed.reason !== undefined) return null;
    return Object.freeze({ cursor: row.idx, kind: "terminal" as const, status: parsed.status });
  }
  if (!hasSafeFailureSemantics(parsed.httpStatus, parsed.code, parsed.reason)) return null;

  return Object.freeze({
    cursor: row.idx,
    kind: "terminal" as const,
    status: "ERROR" as const,
    ...(parsed.httpStatus === undefined ? {} : { httpStatus: parsed.httpStatus }),
    ...(parsed.code === undefined ? {} : { code: parsed.code }),
    ...(parsed.reason === undefined ? {} : { reason: parsed.reason })
  });
}

interface ParsedProviderResponse {
  readonly status: "ERROR" | "CANCELED" | "INTERRUPTED";
  readonly httpStatus?: number;
  readonly code?: string;
  readonly reason?: string;
}

function parseProviderResponse(value: unknown): ParsedProviderResponse | null {
  if (typeof value !== "string" || value.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  const envelope = exactRecord(decoded, PROVIDER_RESPONSE_FIELDS, ["error"]);
  if (envelope === null) return null;
  const error = exactRecord(envelope.error, PROVIDER_ERROR_FIELDS, []);
  if (error === null) return null;

  const httpStatus = readOptionalHttpStatus(error, "code");
  if (httpStatus === null) return null;
  const status = error.status;
  if (status !== undefined && typeof status !== "string") return null;
  const reason = readProviderReason(error.details);
  if (reason === null) return null;
  if (status === undefined && httpStatus === undefined && reason === undefined) return null;

  if (status === "CANCELED" || status === "CANCELLED") {
    return Object.freeze({ status: "CANCELED" as const, ...(httpStatus === undefined ? {} : { httpStatus }), ...(reason === undefined ? {} : { reason }) });
  }
  if (status === "INTERRUPTED") {
    return Object.freeze({ status: "INTERRUPTED" as const, ...(httpStatus === undefined ? {} : { httpStatus }), ...(reason === undefined ? {} : { reason }) });
  }

  const code = typeof status === "string" && SAFE_SIGNALS.has(status) ? status : undefined;
  return Object.freeze({
    status: "ERROR" as const,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason })
  });
}

function readProviderReason(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1) return null;
  if (value.length === 0) return undefined;
  const detail = exactRecord(value[0], PROVIDER_DETAIL_FIELDS, ["reason"]);
  if (detail === null || typeof detail.reason !== "string" || !SAFE_SIGNALS.has(detail.reason)) return null;
  return detail.reason;
}

function exactRecord(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  requiredFields: readonly string[]
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowedFields.has(key))) return null;
    for (const field of requiredFields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) return null;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readConversationId(value: unknown): string | null {
  return isSafeIdentifier(value) ? value : null;
}

function requireConversationId(value: unknown): asserts value is string {
  if (readConversationId(value) === null) throw new Error("SQLite provider observer conversation ID is invalid");
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\u0000") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function requireDirectory(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new Error("SQLite provider observer directory is invalid");
  }
}

function readCursor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readObservedAt(now: () => number): number | null {
  try {
    const value = now();
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function readOptionalHttpStatus(
  fields: Record<string, unknown>,
  field: string
): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(fields, field)) return undefined;
  const value = fields[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function readOptionalSignal(
  fields: Record<string, unknown>,
  field: string
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(fields, field)) return undefined;
  const value = fields[field];
  return typeof value === "string" && SAFE_SIGNALS.has(value) ? value : null;
}

function isTerminalStepStatus(status: number): boolean {
  return status === 3 || status === 6 || status === 7;
}

function isOfficialTerminalStatus(value: unknown): value is OfficialTerminalStatus {
  return value === "SUCCESS" || value === "ERROR" || value === "CANCELED" || value === "INTERRUPTED";
}

function unobservedActivity(): SqliteProviderActivityObservation {
  return Object.freeze({ status: "unobserved" as const });
}
