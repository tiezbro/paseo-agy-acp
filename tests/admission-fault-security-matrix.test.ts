import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AcpOutboxDeliveryBridge, type OutboxDeliveryMessage } from "../src/agy/acp/outbox-delivery.js";
import { ActiveSessionRegistry, type ActiveConnectorIdentity } from "../src/agy/acp/session/active-registry.js";
import { ActiveSessionTurnBinding } from "../src/agy/acp/session/active-turn-binding.js";
import {
  AdmissionController,
  type AdmissionControllerFaultInjection,
  type AdmissionLease,
  type AdmissionPolicy,
  type EnqueueDelivery,
  type VerifiedLinuxProcessRecord
} from "../src/admission/controller.js";
import {
  deriveAdmissionKeyBundle,
  zeroAdmissionKeyBundle,
  type AdmissionKeyBundle
} from "../src/admission/key-derivation.js";
import { ACP_OUTBOX_CAPABILITY, ACP_OUTBOX_CAPABILITY_VERSION } from "../src/admission/outbox-protocol.js";
import { AgyPromptFreeDispatchBoundary } from "../src/agy/dispatch-boundary.js";
import { probeExactAgyBinaryVersion } from "../src/agy/launch-spec.js";
import { runPromptFreePtyCanary } from "../src/agy/prompt-free-canary.js";
import {
  startAgyPromptFreeProcess,
  type AgyPromptFreeProcessChild
} from "../src/agy/prompt-free-process.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerScript = path.join(repositoryRoot, "tests/helpers/admission-fault-worker.mjs");
const compiler = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
const stateDirs: string[] = [];
const openControllers = new Set<AdmissionController>();
let workerBuildDir = "";
let workerControllerModule = "";

const OWNER_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

beforeAll(() => {
  workerBuildDir = mkdtempSync(path.join(repositoryRoot, ".tmp-admission-fault-build-"));
  execFileSync(
    process.execPath,
    [
      compiler,
      "--ignoreConfig",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--rootDir",
      "src",
      "--outDir",
      workerBuildDir,
      "src/admission/controller.ts"
    ],
    { cwd: repositoryRoot, stdio: "pipe" }
  );
  workerControllerModule = path.join(workerBuildDir, "admission/controller.js");
});

afterEach(() => {
  for (const controller of openControllers) {
    try {
      controller.close();
    } catch {}
  }
  openControllers.clear();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

afterAll(() => {
  if (workerBuildDir) rmSync(workerBuildDir, { recursive: true, force: true });
});

describe("v2 admission transaction and dispatch fault matrix", () => {
  it("rolls back identity plus dispatch_intent on an injected transaction fault and reopens at starting", () => {
    const databasePath = newDatabasePath("transaction-reopen");
    let injected = 0;
    const first = controller(databasePath, {
      afterProcessIdentityPersisted() {
        injected += 1;
        throw new Error("sensitive provider text must not escape this injected crash");
      }
    });
    const lease = enqueueStarting(first, "transaction-reopen-request");
    const record = processRecord(lease, 8101, "100001");

    expect(first.recordProcessIdentity(record)).toEqual({
      status: "not_recorded",
      reason: "transaction_fault"
    });
    expect(injected).toBe(1);
    closeController(first);

    const reopened = controller(databasePath);
    expect(reopened.getRequest(lease.requestId)?.state).toBe("starting");
    expect(identityCount(databasePath, lease.leaseId)).toBe(0);
    expect(reopened.recordProcessIdentity(record)).toEqual({ status: "recorded", idempotent: false });
    expect(reopened.commitDispatchIntent(record)).toEqual({ status: "committed", idempotent: true });
    expect(reopened.getRequest(lease.requestId)?.state).toBe("dispatch_intent");
  });

  it("never writes before identity persistence and treats every post-identity uncertainty as ambiguous", () => {
    const cases = [
      {
        name: "identity persistence rejected",
        persist: { status: "not_recorded" as const },
        recheck: { generationMatches: true, ownerMatches: true, cancelled: false },
        commit: { status: "committed" as const },
        write: { status: "accepted" as const },
        expected: { state: "blocked", reason: "process_identity_unrecorded", writeAttempts: 0 }
      },
      {
        name: "cancelled after identity",
        persist: { status: "recorded" as const },
        recheck: { generationMatches: true, ownerMatches: true, cancelled: true },
        commit: { status: "committed" as const },
        write: { status: "accepted" as const },
        expected: { state: "dispatch_ambiguous", writeAttempts: 0 }
      },
      {
        name: "intent replay unconfirmed",
        persist: { status: "recorded" as const },
        recheck: { generationMatches: true, ownerMatches: true, cancelled: false },
        commit: { status: "not_committed" as const },
        write: { status: "accepted" as const },
        expected: { state: "dispatch_ambiguous", writeAttempts: 0 }
      },
      {
        name: "stdin result ambiguous",
        persist: { status: "recorded" as const },
        recheck: { generationMatches: true, ownerMatches: true, cancelled: false },
        commit: { status: "committed" as const },
        write: { status: "ambiguous" as const },
        expected: { state: "dispatch_ambiguous", writeAttempts: 1 }
      }
    ];

    for (const fault of cases) {
      let spawns = 0;
      let writes = 0;
      const boundary = new AgyPromptFreeDispatchBoundary(
        "business prompt stays request scoped",
        { requestId: "request-1", leaseId: "lease-1", generation: 1, ownerInstanceId: "owner-1" },
        {
          spawnPromptFree: () => {
            spawns += 1;
            return {
              process: { pid: 9001 },
              identity: { pid: 9001, startToken: fault.name },
              promptChannel: "stdin" as const,
              writeInitialPrompt: () => {
                writes += 1;
                return fault.write;
              }
            };
          },
          persistProcessIdentity: () => fault.persist,
          recheckCancellation: () => fault.recheck,
          commitDispatchIntent: () => fault.commit
        }
      );

      const result = boundary.run();
      expect(result, fault.name).toMatchObject(fault.expected);
      expect(boundary.run(), `${fault.name}: replay`).toBe(result);
      expect(spawns, fault.name).toBe(1);
      expect(writes, fault.name).toBe(fault.expected.writeAttempts);
    }
  });

  it("repeatedly classifies a competing durable identity as conflicting_intent without half commits", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const databasePath = newDatabasePath(`multiprocess-fence-${attempt}`);
      const privatePayload = `RACE-PROMPT-SENTINEL-${attempt}`;
      const admission = controller(databasePath);
      const lease = enqueueStarting(admission, `multiprocess-request-${attempt}`, privatePayload);
      const leftRecord = processRecord(lease, 8_201 + attempt * 2, String(200_001 + attempt * 2));
      const rightRecord = processRecord(lease, 8_202 + attempt * 2, String(200_002 + attempt * 2));
      const left = startFaultWorker(
        databasePath,
        lease,
        leftRecord.processIdentity.child.pid,
        leftRecord.processIdentity.child.startTimeTicks
      );
      const right = startFaultWorker(
        databasePath,
        lease,
        rightRecord.processIdentity.child.pid,
        rightRecord.processIdentity.child.startTimeTicks
      );

      await Promise.all([left.ready, right.ready]);
      left.child.stdin.end("go\n");
      right.child.stdin.end("go\n");
      const [leftResult, rightResult] = await Promise.all([left.done, right.done]);
      const results = [leftResult, rightResult];

      expect(results.filter((result) => result.status === "recorded")).toEqual([
        { status: "recorded", idempotent: false }
      ]);
      expect(results.filter((result) => result.status === "not_recorded")).toEqual([
        { status: "not_recorded", reason: "conflicting_intent" }
      ]);
      const winnerRecord = leftResult.status === "recorded" ? leftRecord : rightRecord;
      const loserRecord = leftResult.status === "not_recorded" ? leftRecord : rightRecord;
      expect(admission.recordProcessIdentity(winnerRecord)).toEqual({ status: "recorded", idempotent: true });
      expect(admission.commitDispatchIntent(winnerRecord)).toEqual({ status: "committed", idempotent: true });
      expect(admission.recordProcessIdentity(loserRecord)).toEqual({
        status: "not_recorded",
        reason: "conflicting_intent"
      });
      expect(admission.getRequest(lease.requestId)?.state).toBe("dispatch_intent");
      const events = admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 });
      expect(events.filter((event) => event.kind === "request_dispatch_intent")).toHaveLength(1);
      expect(JSON.stringify({ results, events })).not.toContain(privatePayload);
      expect(JSON.stringify(results)).not.toMatch(/SQLITE|busy|locked/i);

      const db = new Database(databasePath, { readonly: true });
      expect(
        db
          .prepare(
            `SELECT request.state AS requestState, lease.phase AS leasePhase,
                    identity.child_pid AS childPid, identity.child_start_time_ticks AS childStartTimeTicks
             FROM turn_requests AS request
             JOIN leases AS lease ON lease.request_id = request.request_id
             JOIN lease_process_identities AS identity ON identity.lease_id = lease.lease_id
             WHERE request.request_id = ?`
          )
          .get(lease.requestId)
      ).toEqual({
        requestState: "dispatch_intent",
        leasePhase: "dispatch_intent",
        childPid: winnerRecord.processIdentity.child.pid,
        childStartTimeTicks: winnerRecord.processIdentity.child.startTimeTicks
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM lease_process_identities WHERE lease_id = ?").get(lease.leaseId)).toEqual({
        count: 1
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'request_dispatch_intent'").get()).toEqual({
        count: 1
      });
      db.close();
      closeController(admission);
    }
  });
});

describe("v2 terminal, outbox, ACK, and capacity crash matrix", () => {
  it("atomically rolls back terminal plus outbox on a delivery fault", () => {
    const databasePath = newDatabasePath("terminal-rollback");
    const admission = controller(databasePath);
    const lease = enqueueActive(admission, "terminal-rollback-request");

    expect(() =>
      admission.markProviderTerminal(
        lease,
        1_010,
        terminalObservations(),
        terminalDelivery("different-request", "terminal-rollback-event", 1_010, "private terminal payload")
      )
    ).toThrow();

    expect(admission.getRequest(lease.requestId)?.state).toBe("active");
    const db = new Database(databasePath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT phase, terminal_outcome AS terminalOutcome FROM leases WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      phase: "active",
      terminalOutcome: null
    });
    db.close();
  });

  it("recovers provider capacity at durable terminal, then finalizes release without losing the outbox", () => {
    const databasePath = newDatabasePath("terminal-release");
    const first = controller(databasePath);
    const firstLease = enqueueActive(first, "first-request");
    first.enqueueWithPayload(request("second-request", 1_011), "second private prompt", 61_011);
    first.markProviderTerminal(
      firstLease,
      1_010,
      terminalObservations(),
      terminalDelivery(firstLease.requestId, "terminal-first", 1_010, "private terminal payload")
    );
    closeController(first);

    const afterTerminalCrash = controller(databasePath);
    const secondLease = afterTerminalCrash.admitRequest("second-request", 1_012, OWNER_INSTANCE_ID);
    expect(secondLease?.requestId).toBe("second-request");
    afterTerminalCrash.release(firstLease, 1_013);
    expect(afterTerminalCrash.getRequest(firstLease.requestId)?.state).toBe("completed");
    expect(afterTerminalCrash.getRequest(secondLease!.requestId)?.state).toBe("admitted");
    const delivery = afterTerminalCrash.claimPendingDeliveryAtomically({
      eventId: "terminal-first",
      ownerInstanceId: "delivery-worker",
      now: 1_014,
      leaseMs: 100
    });
    expect(delivery).toMatchObject({ eventId: "terminal-first", requestId: "first-request" });
  });

  it("settles an exact ACK after notify and restart without notifying or dispatching again", async () => {
    const databasePath = newDatabasePath("notify-ack-restart");
    const first = controller(databasePath);
    first.enqueue(request("notify-request", 1_000));
    first.enqueueDelivery(terminalDelivery("notify-request", "notify-event", 1_001, "private notify payload"));
    let sent: OutboxDeliveryMessage | undefined;
    const initialSender = async (message: OutboxDeliveryMessage) => {
      sent = message;
    };
    const firstBridge = new AcpOutboxDeliveryBridge({
      admission: first,
      ownerInstanceId: "delivery-worker",
      sender: initialSender,
      claimLeaseMs: 100
    });

    await expect(firstBridge.deliver("notify-event", 1_002)).resolves.toMatchObject({ status: "awaiting_ack" });
    const ack = {
      v: ACP_OUTBOX_CAPABILITY_VERSION,
      sessionId: sent!.sessionId,
      eventId: sent!.metadata.eventId,
      claimGeneration: sent!.metadata.claimGeneration,
      claimToken: sent!.metadata.claimToken
    };
    firstBridge.close();
    closeController(first);

    const reopened = controller(databasePath);
    let restartNotifies = 0;
    const restartedBridge = new AcpOutboxDeliveryBridge({
      admission: reopened,
      ownerInstanceId: "delivery-worker",
      sender: async () => {
        restartNotifies += 1;
      }
    });
    expect(restartedBridge.acknowledge(ack, 1_003)).toEqual(ack);
    expect(restartNotifies).toBe(0);
    expect(outboxState(databasePath, "notify-event")).toEqual({ outbox: "delivered", lease: "delivered" });
  });

  it("fails a crashed pre-notify claim closed after lease expiry without exposing or replaying payload", () => {
    const databasePath = newDatabasePath("pre-notify-crash");
    const first = controller(databasePath);
    first.enqueue(request("pre-notify-request", 1_000));
    first.enqueueDelivery(terminalDelivery("pre-notify-request", "pre-notify-event", 1_001, "private pre-notify payload"));
    const claim = first.claimPendingDeliveryAtomically({
      eventId: "pre-notify-event",
      ownerInstanceId: "crashed-worker",
      now: 1_002,
      leaseMs: 10
    });
    expect(claim).not.toBeNull();
    closeController(first);

    const reopened = controller(databasePath);
    const swept = reopened.sweepExpiredDeliveryClaims(1_012);
    expect(swept).toEqual([
      { eventId: "pre-notify-event", requestId: "pre-notify-request", claimGeneration: 1, reason: "lease_expired" }
    ]);
    expect(JSON.stringify(swept)).not.toContain("private pre-notify payload");
    const db = new Database(databasePath, { readonly: true });
    expect(db.prepare("SELECT state, nonce, ciphertext, auth_tag FROM delivery_outbox WHERE event_id = ?").get("pre-notify-event")).toEqual({
      state: "recovery_required",
      nonce: null,
      ciphertext: null,
      auth_tag: null
    });
    db.close();
  });

  it("rolls back the provider-terminal/outbox midpoint fault without durable residue or payload leakage", () => {
    const privatePayload = "matrix-terminal-fault-payload-must-not-leak";
    let hookCalls = 0;
    const databasePath = newDatabasePath("terminal-outbox-midpoint-fault");
    const admission = controller(databasePath, {
      afterProviderTerminalOutboxPersisted() {
        hookCalls += 1;
        if (hookCalls === 1) throw new Error(privatePayload);
      }
    });
    const lease = enqueueActive(admission, "terminal-outbox-midpoint-request");
    const delivery = terminalDelivery(lease.requestId, "terminal-outbox-midpoint-event", 1_010, privatePayload);
    const beforeEvents = admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 });

    let failure = "";
    try {
      admission.markProviderTerminal(lease, 1_010, terminalObservations(), delivery);
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    expect(failure).toBe("AdmissionControllerInjectedFaultError: admission transaction fault injection");
    expect(failure).not.toContain(privatePayload);
    expect(hookCalls).toBe(1);
    expect(admission.getRequest(lease.requestId)?.state).toBe("active");
    expect(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 })).toEqual(beforeEvents);
    expect(admission.listRecoverableOutboxClaims()).toEqual([]);
    const rolledBack = new Database(databasePath, { readonly: true });
    expect(rolledBack.prepare("SELECT phase, terminal_outcome FROM leases WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      phase: "active",
      terminal_outcome: null
    });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get()).toEqual({ count: 0 });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM delivery_claim_leases").get()).toEqual({ count: 0 });
    rolledBack.close();

    admission.markProviderTerminal(lease, 1_010, terminalObservations(), delivery);
    expect(hookCalls).toBe(2);
    const retried = new Database(databasePath, { readonly: true });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get()).toEqual({ count: 1 });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'delivery_enqueued'").get()).toEqual({ count: 1 });
    retried.close();
  });

  it("rolls back ACK settlement between outbox and claim lease without durable residue or payload leakage", () => {
    const privatePayload = "matrix-ack-fault-payload-must-not-leak";
    let hookCalls = 0;
    const databasePath = newDatabasePath("ack-settlement-midpoint-fault");
    const admission = controller(databasePath, {
      afterDeliveryOutboxSettled() {
        hookCalls += 1;
        if (hookCalls === 1) throw new Error(privatePayload);
      }
    });
    const input = request("ack-settlement-midpoint-request", 1_000);
    const event = terminalDelivery(input.requestId, "ack-settlement-midpoint-event", 1_001, privatePayload);
    admission.enqueue(input);
    admission.enqueueDelivery(event);
    const claim = admission.claimPendingDeliveryAtomically({
      eventId: event.eventId,
      ownerInstanceId: "delivery-worker",
      now: 1_002,
      leaseMs: 100
    })!;
    const beforeEvents = admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 });

    let failure = "";
    try {
      admission.acknowledgeDelivery({
        v: ACP_OUTBOX_CAPABILITY_VERSION,
        sessionId: claim.sessionId,
        eventId: claim.eventId,
        claimGeneration: claim.claimGeneration,
        claimToken: claim.claimToken
      }, 1_003);
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    expect(failure).toBe("AdmissionControllerInjectedFaultError: admission transaction fault injection");
    expect(failure).not.toContain(privatePayload);
    expect(hookCalls).toBe(1);
    expect(admission.getRequest(input.requestId)?.state).toBe("queued");
    expect(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 })).toEqual(beforeEvents);
    expect(admission.listRecoverableOutboxClaims()).toEqual([
      expect.objectContaining({ eventId: event.eventId, state: "claimed" })
    ]);
    const rolledBack = new Database(databasePath, { readonly: true });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM leases").get()).toEqual({ count: 0 });
    expect(rolledBack.prepare("SELECT state, settled_at FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "claimed",
      settled_at: null
    });
    expect(
      rolledBack.prepare("SELECT state, settled_at FROM delivery_claim_leases WHERE event_id = ?").get(event.eventId)
    ).toEqual({ state: "claimed", settled_at: null });
    rolledBack.close();

    admission.acknowledgeDelivery({
      v: ACP_OUTBOX_CAPABILITY_VERSION,
      sessionId: claim.sessionId,
      eventId: claim.eventId,
      claimGeneration: claim.claimGeneration,
      claimToken: claim.claimToken
    }, 1_003);
    expect(hookCalls).toBe(2);
    const retried = new Database(databasePath, { readonly: true });
    expect(retried.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "delivered"
    });
    expect(retried.prepare("SELECT state FROM delivery_claim_leases WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "delivered"
    });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'delivery_delivered'").get()).toEqual({ count: 1 });
    retried.close();
  });
});

describe("v2 cursor restart and sensitive-data matrix", () => {
  it("restores a bound cursor after restart while the matching dispatch is still pre-active", () => {
    const databasePath = newDatabasePath("cursor-before-active");
    const admission = controller(databasePath);
    const lease = enqueueStarting(admission, "cursor-before-active-request");
    expect(admission.recordProcessIdentity(processRecord(lease, 8301, "300001"))).toEqual({
      status: "recorded",
      idempotent: false
    });
    const registry = new ActiveSessionRegistry(databasePath);
    const binding = ActiveSessionTurnBinding.register(registry, {
      agentId: "agent-cursor",
      sessionId: "session-cursor-before-active-request",
      requestId: lease.requestId,
      conversationId: null,
      cursor: -1,
      connectorIdentity: connectorIdentity()
    });
    binding.advance({ conversationId: "conversation-cursor", cursor: 12 });
    registry.close();
    closeController(admission);

    const reopenedAdmission = controller(databasePath);
    const reopenedRegistry = new ActiveSessionRegistry(databasePath);
    expect(reopenedAdmission.getRequest(lease.requestId)?.state).toBe("dispatch_intent");
    expect(reopenedRegistry.listInFlight()).toEqual([
      expect.objectContaining({
        requestId: lease.requestId,
        conversationId: "conversation-cursor",
        cursor: 12,
        terminalState: null
      })
    ]);
    expect(reopenedAdmission.listRecoverableDispatches()).toEqual([
      expect.objectContaining({ requestId: lease.requestId, phase: "dispatch_intent" })
    ]);
    reopenedRegistry.close();
  });

  it("keeps prompt, reasoning, headers, tokens, master key, and subkeys out of durable and diagnostic surfaces", async () => {
    const stateDir = newStateDir("sensitive-matrix");
    const databasePath = path.join(stateDir, "runtime.sqlite");
    const fakeBinaryPath = path.join(stateDir, "fake-agy");
    writeFileSync(fakeBinaryPath, "#!/bin/sh\nprintf '%s\\n' 'agy version 9.8.7.6'\n", "utf8");
    chmodSync(fakeBinaryPath, 0o700);
    const verifiedBinary = probeExactAgyBinaryVersion({ executable: fakeBinaryPath, cwd: stateDir });
    const masterKey = Buffer.from("MASTER-KEY-MUST-NOT-LEAK-1234567", "utf8");
    expect(masterKey).toHaveLength(32);
    const keys = deriveAdmissionKeyBundle(masterKey);
    const secretValues = [
      "PROMPT-SENTINEL-5f86277a",
      "REASONING-SENTINEL-8a0d9b31",
      "Authorization: Bearer TOKEN-SENTINEL-fd423b90"
    ];
    const privatePayload = secretValues.join("\n");
    const admission = controller(databasePath, undefined, keys);
    admission.enqueueWithPayload(request("sensitive-request", 1_000), privatePayload, 61_000);
    admission.enqueueDelivery(
      terminalDelivery("sensitive-request", "sensitive-event", 1_001, `${privatePayload}\nOUTBOX-SENTINEL-c59cdb3f`)
    );

    let launchSeen: unknown;
    const child = new FakePromptFreeChild();
    const promptFree = startAgyPromptFreeProcess({
      verifiedAgyBinary: verifiedBinary,
      argv: [fakeBinaryPath, "--print", "--output-format", "stream-json"],
      environment: { SAFE_ENV: "kept" },
      cwd: stateDir,
      processTitle: "agy-acp:prompt-free-print",
      temporaryFilePath: path.join(stateDir, "prompt-free.tmp"),
      launcherDiagnostics: ["transport=stdin", "launcher=repository-owned"],
      businessPrompt: privatePayload,
      start: (launch) => {
        launchSeen = launch;
        return child;
      }
    });
    const writeResult = promptFree.writeBusinessPrompt();
    child.emit("error", new Error(`${privatePayload}\nprovider-controlled-error`));
    const exitResult = await promptFree.exit;
    expect(child.stdinText).toBe(privatePayload);

    let conflictError = "";
    try {
      admission.persistPayload("sensitive-request", `${privatePayload}\nconflict`, 1_002, 61_002);
    } catch (error) {
      conflictError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const canary = runPromptFreePtyCanary({
      businessPrompt: privatePayload,
      verifiedAgyBinary: verifiedBinary,
      agyVersion: verifiedBinary.version,
      launcherFingerprint: verifiedBinary.launcherFingerprint,
      canaryKey: keys.startupCanary,
      fakeChild: () => ({ exitCode: 0 }),
      now: () => 1_003
    });

    const jsonSurface = JSON.stringify({
      launchSeen,
      writeResult,
      exitResult,
      request: admission.getRequest("sensitive-request"),
      recovery: admission.listRecoverableDispatches(),
      canary,
      conflictError
    });
    const prohibitedText = [
      ...secretValues,
      "OUTBOX-SENTINEL-c59cdb3f",
      masterKey.toString("utf8"),
      masterKey.toString("hex"),
      masterKey.toString("base64"),
      ...keyTextRepresentations(keys)
    ];
    for (const forbidden of prohibitedText) expect(jsonSurface).not.toContain(forbidden);

    const launchJson = JSON.stringify(launchSeen);
    for (const forbidden of secretValues) expect(launchJson).not.toContain(forbidden);
    expect(conflictError).toBe("PayloadConflictError: request already has a different durable payload");
    expect(conflictError).not.toContain("sensitive-request");

    const sqliteArtifacts = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    expect(sqliteArtifacts.every(existsSync)).toBe(true);
    for (const artifactPath of sqliteArtifacts) {
      const artifact = readFileSync(artifactPath);
      for (const forbidden of [
        ...secretValues,
        "OUTBOX-SENTINEL-c59cdb3f",
        masterKey.toString("utf8")
      ]) {
        expect(artifact.includes(Buffer.from(forbidden, "utf8")), `${path.basename(artifactPath)} contains ${forbidden}`).toBe(false);
      }
      expect(artifact.includes(masterKey), `${path.basename(artifactPath)} contains master key`).toBe(false);
      for (const subkey of Object.values(keys)) {
        expect(artifact.includes(subkey), `${path.basename(artifactPath)} contains a derived subkey`).toBe(false);
      }
    }

    closeController(admission);
    zeroAdmissionKeyBundle(keys);
    masterKey.fill(0);
  });

  it.todo("BLOCKED: scan a successful fresh-PTY canary certificate for key leakage; production fresh-PTY certification has no accepted launcher source yet");

  it("replays a stable payload-free sanitized transition journal after restart without leaking secrets or keys", () => {
    const stateDir = newStateDir("sanitized-events-restart");
    const databasePath = path.join(stateDir, "runtime.sqlite");
    const masterKey = Buffer.from("EVENT-MASTER-KEY-NO-LEAK-1234567", "utf8");
    expect(masterKey).toHaveLength(32);
    const keys = deriveAdmissionKeyBundle(masterKey);
    const identifiers = {
      requestId: "EVENT-REQUEST-SENTINEL-91e701",
      sessionId: "EVENT-SESSION-SENTINEL-3706d3",
      parentId: "EVENT-PARENT-SENTINEL-c68fb4",
      fingerprint: "EVENT-FINGERPRINT-SENTINEL-171087",
      provider: "EVENT-PROVIDER-SENTINEL-f296f0",
      model: "EVENT-MODEL-SENTINEL-0fb56f"
    };
    const sensitive = [
      "EVENT-PROMPT-SENTINEL-b5a05e",
      "EVENT-REASONING-SENTINEL-f61277",
      "Authorization: Bearer EVENT-HEADER-SENTINEL-e8548a",
      "EVENT-TOKEN-SENTINEL-6bc658"
    ];
    const first = controller(databasePath, undefined, keys);
    first.enqueueWithPayload(
      {
        ...identifiers,
        now: 1_000
      },
      sensitive.join("\n"),
      61_000
    );
    const lease = first.admitRequest(identifiers.requestId, 1_001, OWNER_INSTANCE_ID);
    if (lease === null) throw new Error("sanitized event request was not admitted");
    first.markStarting(lease, 1_002);
    expect(first.recordProcessIdentity(processRecord(lease, 8_401, "500001"))).toEqual({
      status: "recorded",
      idempotent: false
    });
    first.markActive(lease, 1_004);
    first.markProviderTerminal(
      lease,
      1_010,
      terminalObservations(),
      terminalDelivery(
        identifiers.requestId,
        "sanitized-terminal-event",
        1_010,
        [...sensitive].reverse().join("\n")
      )
    );
    first.release(lease, 1_011);

    const beforeRestart = first.readSanitizedEvents({ afterEventSeq: 0, limit: 100 });
    expect(beforeRestart.map((event) => [event.kind, event.fromState, event.toState])).toEqual([
      ["request_enqueued", "absent", "queued"],
      ["request_admitted", "queued", "admitted"],
      ["request_starting", "admitted", "starting"],
      ["request_dispatch_intent", "starting", "dispatch_intent"],
      ["request_active", "dispatch_intent", "active"],
      ["delivery_enqueued", "absent", "pending"],
      ["request_provider_terminal", "active", "provider_terminal"],
      ["request_released", "provider_terminal", "completed"]
    ]);
    expect(new Set(beforeRestart.map((event) => event.correlationHmac)).size).toBe(1);
    for (const event of beforeRestart) {
      expect(Object.keys(event)).toEqual([
        "eventSeq",
        "kind",
        "fromState",
        "toState",
        "occurredAt",
        "correlationHmac"
      ]);
      expect(event.correlationHmac).toMatch(/^[0-9a-f]{64}$/);
    }
    closeController(first);

    const reopened = controller(databasePath, undefined, keys);
    const afterRestart = reopened.readSanitizedEvents({ afterEventSeq: 0, limit: 100 });
    expect(afterRestart).toEqual(beforeRestart);
    const publicJson = JSON.stringify(afterRestart);
    const allPrivateText = [
      ...Object.values(identifiers),
      ...sensitive,
      masterKey.toString("utf8"),
      masterKey.toString("hex"),
      masterKey.toString("base64"),
      ...keyTextRepresentations(keys)
    ];
    for (const forbidden of allPrivateText) expect(publicJson).not.toContain(forbidden);

    const raw = new Database(databasePath, { readonly: true });
    const eventColumns = (raw.pragma("table_info('events')") as Array<{ name: string }>).map((column) => column.name);
    const eventRows = raw
      .prepare("SELECT event_seq, kind, from_state, to_state, occurred_at, correlation_hmac FROM events ORDER BY event_seq")
      .all();
    raw.close();
    expect(eventColumns).toEqual(["event_seq", "kind", "from_state", "to_state", "occurred_at", "correlation_hmac"]);
    const durableEventJson = JSON.stringify(eventRows);
    for (const forbidden of allPrivateText) expect(durableEventJson).not.toContain(forbidden);

    const sqliteArtifacts = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    expect(sqliteArtifacts.every(existsSync)).toBe(true);
    for (const artifactPath of sqliteArtifacts) {
      const artifact = readFileSync(artifactPath);
      // Request/session/provider/model are intentionally durable in turn_requests;
      // the journal schema and selected rows above prove they never enter events.
      for (const forbidden of sensitive) {
        expect(artifact.includes(Buffer.from(forbidden, "utf8")), `${path.basename(artifactPath)} contains ${forbidden}`).toBe(false);
      }
      expect(artifact.includes(masterKey), `${path.basename(artifactPath)} contains master key`).toBe(false);
      for (const subkey of Object.values(keys)) {
        expect(artifact.includes(subkey), `${path.basename(artifactPath)} contains a derived subkey`).toBe(false);
      }
    }

    closeController(reopened);
    zeroAdmissionKeyBundle(keys);
    masterKey.fill(0);
  });
});

function controller(
  databasePath: string,
  faultInjection?: AdmissionControllerFaultInjection,
  keyBundle?: AdmissionKeyBundle
): AdmissionController {
  const admission = new AdmissionController({
    databasePath,
    policy: POLICY,
    encryptionKey: keyBundle?.encryption ?? Buffer.alloc(32, 31),
    contentFingerprintKey: keyBundle?.contentFingerprint ?? Buffer.alloc(32, 32),
    claimTokenKey: keyBundle?.claimToken ?? Buffer.alloc(32, 33),
    faultInjection
  });
  openControllers.add(admission);
  return admission;
}

function closeController(admission: AdmissionController): void {
  admission.close();
  openControllers.delete(admission);
}

function newStateDir(label: string): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), `paseo-agy-${label}-`));
  stateDirs.push(stateDir);
  return stateDir;
}

function newDatabasePath(label: string): string {
  return path.join(newStateDir(label), "runtime.sqlite");
}

function request(requestId: string, now: number) {
  return {
    requestId,
    sessionId: `session-${requestId}`,
    parentId: "parent-agent",
    fingerprint: `fingerprint-${requestId}`,
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now
  };
}

function enqueueStarting(admission: AdmissionController, requestId: string, payload = `prompt:${requestId}`): AdmissionLease {
  admission.enqueueWithPayload(request(requestId, 1_000), payload, 61_000);
  const lease = admission.admitRequest(requestId, 1_001, OWNER_INSTANCE_ID);
  if (lease === null) throw new Error("test request was not admitted");
  admission.markStarting(lease, 1_002);
  return lease;
}

function enqueueActive(admission: AdmissionController, requestId: string): AdmissionLease {
  const lease = enqueueStarting(admission, requestId);
  const childPid = 8_000 + (requestId.length % 1_000);
  expect(admission.recordProcessIdentity(processRecord(lease, childPid, String(400_000 + requestId.length)))).toEqual({
    status: "recorded",
    idempotent: false
  });
  admission.markActive(lease, 1_004);
  return lease;
}

function processRecord(lease: AdmissionLease, childPid: number, childStartTimeTicks: string): VerifiedLinuxProcessRecord {
  return {
    ...lease,
    processIdentity: {
      connector: connectorIdentity(),
      child: {
        bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        pid: childPid,
        startTimeTicks: childStartTimeTicks,
        pidNamespaceInode: 4026533001,
        ppid: 7001,
        pgrp: childPid,
        session: childPid
      }
    },
    promptChannel: "stdin"
  };
}

function connectorIdentity(): ActiveConnectorIdentity {
  return {
    ownerInstanceId: OWNER_INSTANCE_ID,
    createdAt: "2026-08-10T00:00:00.000Z",
    bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pid: 7001,
    startTimeTicks: "900001",
    pidNamespaceInode: 4026533001,
    ppid: 7000,
    pgrp: 7001,
    session: 7001
  };
}

function terminalObservations() {
  return {
    streamJson: {
      source: "stream_json" as const,
      conversationId: "conversation-terminal",
      observedAt: 1_008,
      status: "SUCCESS" as const
    },
    sqliteReconciliation: {
      source: "sqlite_reconciliation" as const,
      conversationId: "conversation-terminal",
      observedAt: 1_009,
      status: "SUCCESS" as const
    }
  };
}

function terminalDelivery(
  requestId: string,
  eventId: string,
  now: number,
  payload: string
): EnqueueDelivery {
  return {
    eventId,
    requestId,
    fingerprint: `fingerprint-${eventId}`,
    payload,
    sequence: 1,
    now,
    expiresAt: now + 60_000,
    protocol: ACP_OUTBOX_CAPABILITY
  };
}

function identityCount(databasePath: string, leaseId: string): number {
  const db = new Database(databasePath, { readonly: true });
  const row = db.prepare("SELECT COUNT(*) AS count FROM lease_process_identities WHERE lease_id = ?").get(leaseId) as {
    count: number;
  };
  db.close();
  return row.count;
}

function outboxState(databasePath: string, eventId: string): { outbox: string; lease: string } {
  const db = new Database(databasePath, { readonly: true });
  const row = db
    .prepare(
      `SELECT outbox.state AS outbox, lease.state AS lease
       FROM delivery_outbox AS outbox
       JOIN delivery_claim_leases AS lease ON lease.event_id = outbox.event_id
       WHERE outbox.event_id = ?`
    )
    .get(eventId) as { outbox: string; lease: string };
  db.close();
  return row;
}

interface WorkerResult {
  status: "recorded" | "not_recorded";
  reason?: string;
  idempotent?: boolean;
}

function startFaultWorker(
  databasePath: string,
  lease: AdmissionLease,
  childPid: number,
  childStartTimeTicks: string
): { child: ChildProcessWithoutNullStreams; ready: Promise<void>; done: Promise<WorkerResult> } {
  const child = spawn(
    process.execPath,
    [
      workerScript,
      workerControllerModule,
      databasePath,
      lease.requestId,
      lease.leaseId,
      String(lease.generation),
      lease.ownerInstanceId,
      String(childPid),
      childStartTimeTicks
    ],
    { cwd: repositoryRoot, stdio: "pipe" }
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) readyResolve();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => readyReject(error));
  const done = new Promise<WorkerResult>((resolve, reject) => {
    child.once("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`admission fault worker failed (${code}): ${stderr}`);
        readyReject(error);
        reject(error);
        return;
      }
      const lines = stdout.trim().split("\n");
      try {
        resolve(JSON.parse(lines.at(-1) ?? "") as WorkerResult);
      } catch (error) {
        reject(error);
      }
    });
  });
  return { child, ready, done };
}

function keyTextRepresentations(keys: AdmissionKeyBundle): string[] {
  return Object.values(keys).flatMap((key) => [key.toString("hex"), key.toString("base64")]);
}

class FakePromptFreeChild extends EventEmitter implements AgyPromptFreeProcessChild {
  readonly stdout = new PassThrough();
  readonly stdin: { write(data: string): boolean; end(): void };
  exitCode: number | null = null;
  stdinText = "";

  constructor() {
    super();
    this.stdin = {
      write: (data) => {
        this.stdinText += data;
        return true;
      },
      end: () => undefined
    };
  }

  kill(): boolean {
    return true;
  }
}
