import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionConflictError,
  AdmissionController,
  DeliveryClaimFenceError,
  DeliveryConflictError,
  LeaseFenceError,
  PayloadConflictError,
  RecoverableOutboxClaimInventoryError,
  DURABLE_DELIVERY_PROTOCOL,
  type AdmissionControllerFaultInjection,
  type AdmissionPolicy,
  type ConfirmedProviderTerminal
} from "../Admission Controller/controller.js";
import type { EnqueueDelivery } from "../Admission Controller/controller.js";
import type { OutboxAck } from "../ACP Connector/admission/outbox-protocol.js";
import { SchemaIntegrityError } from "../Admission Controller/schema.js";

const stateDirs: string[] = [];
const DEFAULT_POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const LINUX_OWNER_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

interface LinuxProcessRecord {
  requestId: string;
  leaseId: string;
  generation: number;
  ownerInstanceId: string;
  processIdentity: {
    connector: {
      ownerInstanceId: string;
      createdAt: string;
      bootId: string;
      pid: number;
      startTimeTicks: string;
      pidNamespaceInode: number;
      ppid: number;
      pgrp: number;
      session: number;
    };
    child: {
      bootId: string;
      pid: number;
      startTimeTicks: string;
      pidNamespaceInode: number;
      ppid: number;
      pgrp: number;
      session: number;
    };
  };
  promptChannel: "stdin" | "pty";
}

interface ControllerTestKeys {
  encryptionKey?: Buffer;
  contentFingerprintKey?: Buffer;
  claimTokenKey?: Buffer;
}

function controller(
  policy: Partial<AdmissionPolicy> = {},
  keys: Buffer | ControllerTestKeys = {},
  faultInjection?: AdmissionControllerFaultInjection
) {
  const overrides = Buffer.isBuffer(keys) ? { encryptionKey: keys } : keys;
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-"));
  stateDirs.push(stateDir);
  return new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: {
      ...DEFAULT_POLICY,
      ...policy
    },
    encryptionKey: overrides.encryptionKey ?? Buffer.alloc(32, 1),
    contentFingerprintKey: overrides.contentFingerprintKey ?? Buffer.alloc(32, 2),
    claimTokenKey: overrides.claimTokenKey ?? Buffer.alloc(32, 3),
    faultInjection
  });
}

function reopenController(databasePath: string, policy: AdmissionPolicy): AdmissionController {
  return new AdmissionController({
    databasePath,
    policy,
    encryptionKey: Buffer.alloc(32, 1),
    contentFingerprintKey: Buffer.alloc(32, 2),
    claimTokenKey: Buffer.alloc(32, 3)
  });
}

function request(overrides: Partial<Parameters<AdmissionController["enqueue"]>[0]> = {}) {
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    sessionId: overrides.sessionId ?? "session-a",
    parentId: overrides.parentId ?? "parent-a",
    fingerprint: overrides.fingerprint ?? "fingerprint-a",
    provider: overrides.provider ?? "antigravity",
    model: overrides.model ?? "claude-opus-4-6-thinking",
    now: overrides.now ?? 1_000
  };
}

function enqueueReady(
  admission: AdmissionController,
  input: Parameters<AdmissionController["enqueue"]>[0],
  plaintext = `prompt:${input.requestId}`
) {
  return admission.enqueueWithPayload(input, plaintext, input.now + 60_000);
}

function terminalObservations(
  status: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED" = "SUCCESS"
): ConfirmedProviderTerminal {
  return {
    outcome: status === "SUCCESS" ? "completed" : status === "ERROR" ? "failed" : "cancelled",
    conversationId: "conversation-1",
    status,
    streamObservedAt: 1_500,
    sqliteObservedAt: 1_501,
    failure: status === "ERROR"
      ? { category: "unknown", httpStatus: undefined, code: undefined, reason: undefined }
      : null
  };
}

function delivery(requestId: string, overrides: Partial<EnqueueDelivery> = {}): EnqueueDelivery {
  return {
    eventId: overrides.eventId ?? `event-${requestId}`,
    requestId,
    fingerprint: overrides.fingerprint ?? `delivery-fingerprint-${requestId}`,
    payload: overrides.payload ?? `delivery:${requestId}`,
    sequence: overrides.sequence ?? 0,
    now: overrides.now ?? 1_000,
    expiresAt: overrides.expiresAt ?? 61_000,
    protocol: overrides.protocol ?? DURABLE_DELIVERY_PROTOCOL
  };
}

function acknowledgement(
  claim: {
    eventId: string;
    sessionId: string;
    claimGeneration: number;
    claimToken: string;
  }
): OutboxAck {
  return {
    v: 1,
    eventId: claim.eventId,
    sessionId: claim.sessionId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken
  };
}

function linuxProcessRecord(
  lease: { requestId: string; leaseId: string; generation: number; ownerInstanceId: string },
  overrides: Partial<LinuxProcessRecord> = {}
): LinuxProcessRecord {
  const connector = {
    ownerInstanceId: lease.ownerInstanceId,
    createdAt: "2026-08-09T00:00:00.000Z",
    bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
    pid: 3711,
    startTimeTicks: "1234567890123",
    pidNamespaceInode: 4026531836,
    ppid: 1,
    pgrp: 3711,
    session: 3711
  };
  const child = {
    bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
    pid: 4182,
    startTimeTicks: "1234567890999",
    pidNamespaceInode: 4026531836,
    ppid: 3711,
    pgrp: 4182,
    session: 3711
  };

  return {
    requestId: lease.requestId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    ownerInstanceId: lease.ownerInstanceId,
    processIdentity: { connector, child },
    promptChannel: "stdin",
    ...overrides
  };
}

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("AdmissionController", () => {
  it("uses independent content and claim keys instead of encryption-key fallback", () => {
    const encryptionKey = Buffer.alloc(32, 41);
    const contentKeyA = Buffer.alloc(32, 42);
    const contentKeyB = Buffer.alloc(32, 43);
    const claimKeyA = Buffer.alloc(32, 44);
    const claimKeyB = Buffer.alloc(32, 45);
    const contentA = controller({}, { encryptionKey, contentFingerprintKey: contentKeyA, claimTokenKey: claimKeyA });
    const contentB = controller({}, {
      encryptionKey: Buffer.from(encryptionKey),
      contentFingerprintKey: contentKeyB,
      claimTokenKey: Buffer.from(claimKeyA)
    });
    const contentRequest = request({ requestId: "key-separated-content", now: 1_000 });

    contentA.enqueueWithPayload(contentRequest, "same business payload", 61_000);
    contentB.enqueueWithPayload(contentRequest, "same business payload", 61_000);
    const contentDbA = new Database(contentA.databasePath, { readonly: true });
    const contentDbB = new Database(contentB.databasePath, { readonly: true });
    const fingerprintA = contentDbA
      .prepare("SELECT content_fingerprint FROM turn_payloads WHERE request_id = ?")
      .get(contentRequest.requestId) as { content_fingerprint: string };
    const fingerprintB = contentDbB
      .prepare("SELECT content_fingerprint FROM turn_payloads WHERE request_id = ?")
      .get(contentRequest.requestId) as { content_fingerprint: string };
    contentDbA.close();
    contentDbB.close();
    expect(fingerprintA.content_fingerprint).not.toBe(fingerprintB.content_fingerprint);

    const claimA = controller({}, { encryptionKey, contentFingerprintKey: contentKeyA, claimTokenKey: claimKeyA });
    const claimB = controller({}, {
      encryptionKey: Buffer.from(encryptionKey),
      contentFingerprintKey: Buffer.from(contentKeyA),
      claimTokenKey: claimKeyB
    });
    for (const admission of [claimA, claimB]) {
      admission.enqueue(request({ requestId: "key-separated-claim", now: 1_000 }));
      admission.enqueueDelivery(delivery("key-separated-claim", { eventId: "key-separated-event", now: 1_001 }));
    }
    const claimFenceA = claimA.claimPendingDelivery("key-separated-event", "delivery-worker", 1_002)!;
    const claimFenceB = claimB.claimPendingDelivery("key-separated-event", "delivery-worker", 1_002)!;
    expect(claimFenceA.claimToken).not.toBe(claimFenceB.claimToken);

    const databasePath = claimA.databasePath;
    const policy = claimA.policy;
    claimA.close();
    const foreignClaimKey = new AdmissionController({
      databasePath,
      policy,
      encryptionKey: Buffer.from(encryptionKey),
      contentFingerprintKey: Buffer.from(contentKeyA),
      claimTokenKey: Buffer.from(claimKeyB)
    });
    expect(() => foreignClaimKey.markDeliveryRecoveryRequired(claimFenceA, 1_003)).toThrow(DeliveryClaimFenceError);
    expect(() => foreignClaimKey.acknowledgeDelivery(acknowledgement(claimFenceA), 1_003)).toThrow(DeliveryClaimFenceError);
    foreignClaimKey.close();
    claimB.close();
    contentA.close();
    contentB.close();
  });

  it("validates and copies every supplied purpose key independently", () => {
    expect(() => controller({}, { encryptionKey: Buffer.alloc(31, 41) })).toThrow(/encryption key must be exactly 32 bytes/);
    expect(() => controller({}, { contentFingerprintKey: Buffer.alloc(31, 42) })).toThrow(
      /content fingerprint key must be exactly 32 bytes/
    );
    expect(() => controller({}, { claimTokenKey: Buffer.alloc(31, 43) })).toThrow(
      /claim token key must be exactly 32 bytes/
    );

    const encryptionKey = Buffer.alloc(32, 51);
    const contentFingerprintKey = Buffer.alloc(32, 52);
    const claimTokenKey = Buffer.alloc(32, 53);
    const admission = controller({}, { encryptionKey, contentFingerprintKey, claimTokenKey });
    admission.close();

    expect(encryptionKey).toEqual(Buffer.alloc(32, 51));
    expect(contentFingerprintKey).toEqual(Buffer.alloc(32, 52));
    expect(claimTokenKey).toEqual(Buffer.alloc(32, 53));
  });

  it("fails closed only when an operation requires a missing purpose key", () => {
    const queueDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-keys-"));
    stateDirs.push(queueDir);
    const queueOnly = new AdmissionController({ databasePath: path.join(queueDir, "runtime.sqlite"), policy: DEFAULT_POLICY });
    expect(() => queueOnly.enqueue(request({ requestId: "queue-without-keys", now: 1_000 }))).toThrow(
      /event correlation requires a content fingerprint key/
    );
    expect(queueOnly.getRequest("queue-without-keys")).toBeNull();
    expect(queueOnly.readSanitizedEvents({ afterEventSeq: 0, limit: 10 })).toEqual([]);
    queueOnly.close();

    const contentDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-keys-"));
    stateDirs.push(contentDir);
    const missingContent = new AdmissionController({
      databasePath: path.join(contentDir, "runtime.sqlite"),
      policy: DEFAULT_POLICY,
      encryptionKey: Buffer.alloc(32, 51),
      claimTokenKey: Buffer.alloc(32, 53)
    });
    const contentRequest = request({ requestId: "missing-content-key", now: 1_000 });
    expect(() => missingContent.enqueueWithPayload(contentRequest, "payload", 61_000)).toThrow(/content fingerprint key/);
    expect(missingContent.getRequest(contentRequest.requestId)).toBeNull();
    missingContent.close();

    const claimDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-keys-"));
    stateDirs.push(claimDir);
    const missingClaim = new AdmissionController({
      databasePath: path.join(claimDir, "runtime.sqlite"),
      policy: DEFAULT_POLICY,
      encryptionKey: Buffer.alloc(32, 61),
      contentFingerprintKey: Buffer.alloc(32, 62)
    });
    missingClaim.enqueue(request({ requestId: "missing-claim-key", now: 1_000 }));
    missingClaim.enqueueDelivery(delivery("missing-claim-key", { eventId: "missing-claim-event", now: 1_001 }));
    expect(() => missingClaim.claimPendingDelivery("missing-claim-event", "delivery-worker", 1_002)).toThrow(/claim token key/);
    const missingClaimDb = new Database(missingClaim.databasePath, { readonly: true });
    expect(missingClaimDb.prepare("SELECT state FROM delivery_outbox WHERE event_id = 'missing-claim-event'").get()).toEqual({
      state: "pending"
    });
    missingClaimDb.close();
    missingClaim.close();

    const acknowledgementDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-keys-"));
    stateDirs.push(acknowledgementDir);
    const encryptionKey = Buffer.alloc(32, 71);
    const contentFingerprintKey = Buffer.alloc(32, 72);
    const claimTokenKey = Buffer.alloc(32, 73);
    const claimedController = new AdmissionController({
      databasePath: path.join(acknowledgementDir, "runtime.sqlite"),
      policy: DEFAULT_POLICY,
      encryptionKey,
      contentFingerprintKey,
      claimTokenKey
    });
    claimedController.enqueue(request({ requestId: "missing-claim-ack", now: 1_000 }));
    claimedController.enqueueDelivery(
      delivery("missing-claim-ack", { eventId: "missing-claim-ack-event", now: 1_001 })
    );
    const claim = claimedController.claimPendingDelivery("missing-claim-ack-event", "delivery-worker", 1_002)!;
    claimedController.close();

    const missingClaimForAcknowledgement = new AdmissionController({
      databasePath: path.join(acknowledgementDir, "runtime.sqlite"),
      policy: DEFAULT_POLICY,
      encryptionKey: Buffer.from(encryptionKey),
      contentFingerprintKey: Buffer.from(contentFingerprintKey)
    });
    expect(() => missingClaimForAcknowledgement.acknowledgeDelivery(acknowledgement(claim), 1_003)).toThrow(
      /claim token key/
    );
    const missingClaimAckDb = new Database(missingClaimForAcknowledgement.databasePath, { readonly: true });
    expect(missingClaimAckDb.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get(claim.eventId)).toEqual({
      state: "claimed"
    });
    missingClaimAckDb.close();
    missingClaimForAcknowledgement.close();
  });

  it("journals the complete request and outbox lifecycle with one purpose-separated opaque correlation", () => {
    const contentFingerprintKey = Buffer.alloc(32, 82);
    const admission = controller({}, { contentFingerprintKey });
    const input = request({
      requestId: "journal-request-private",
      sessionId: "journal-session-private",
      parentId: "journal-parent-private",
      fingerprint: "journal-fingerprint-private",
      provider: "antigravity-private",
      model: "model-private",
      now: 1_000
    });
    enqueueReady(admission, input, "prompt-private");
    expect(enqueueReady(admission, input, "prompt-private")).toEqual({ requestId: input.requestId, existed: true });
    const lease = admission.admitNext(1_001, "journal-owner")!;
    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);
    admission.markActive(lease, 1_004);
    admission.markProviderTerminal(
      lease,
      1_005,
      terminalObservations(),
      delivery(input.requestId, { eventId: "journal-delivery-private", payload: "result-private", now: 1_005 })
    );
    admission.release(lease, 1_006);

    const firstPage = admission.readSanitizedEvents({ afterEventSeq: 0, limit: 3 });
    const secondPage = admission.readSanitizedEvents({ afterEventSeq: firstPage.at(-1)!.eventSeq, limit: 20 });
    const events = [...firstPage, ...secondPage];
    expect(events.map(({ kind, fromState, toState, occurredAt }) => ({ kind, fromState, toState, occurredAt }))).toEqual([
      { kind: "request_enqueued", fromState: "absent", toState: "queued", occurredAt: 1_000 },
      { kind: "request_admitted", fromState: "queued", toState: "admitted", occurredAt: 1_001 },
      { kind: "request_starting", fromState: "admitted", toState: "starting", occurredAt: 1_002 },
      { kind: "request_dispatch_intent", fromState: "starting", toState: "dispatch_intent", occurredAt: 1_003 },
      { kind: "request_active", fromState: "dispatch_intent", toState: "active", occurredAt: 1_004 },
      { kind: "delivery_enqueued", fromState: "absent", toState: "pending", occurredAt: 1_005 },
      { kind: "request_provider_terminal", fromState: "active", toState: "provider_terminal", occurredAt: 1_005 },
      { kind: "request_released", fromState: "provider_terminal", toState: "completed", occurredAt: 1_006 }
    ]);
    expect(new Set(events.map((event) => event.correlationHmac)).size).toBe(1);
    const expectedCorrelation = createHmac("sha256", contentFingerprintKey)
      .update(JSON.stringify(["paseo-agy-acp", "admission-event-correlation", 1]), "utf8")
      .update(Buffer.from([0]))
      .update(input.requestId, "utf8")
      .digest("hex");
    expect(events[0]?.correlationHmac).toBe(expectedCorrelation);
    const plainRequestHash = createHash("sha256").update(input.requestId, "utf8").digest("hex");
    expect(JSON.stringify(events)).not.toContain(plainRequestHash);
    expect(JSON.stringify(events)).not.toMatch(
      /journal-request-private|journal-session-private|journal-parent-private|journal-fingerprint-private|antigravity-private|model-private|prompt-private|result-private/
    );

    const raw = new Database(admission.databasePath, { readonly: true });
    const payloadFingerprint = raw
      .prepare("SELECT content_fingerprint FROM turn_payloads WHERE request_id = ?")
      .get(input.requestId) as { content_fingerprint: string };
    raw.close();
    expect(events[0]?.correlationHmac).not.toBe(payloadFingerprint.content_fingerprint);
  });

  it("requires an exact identifier-free read shape and fails closed for tampered journal rows", () => {
    const admission = controller();
    admission.enqueue(request({ requestId: "journal-shape", now: 1_000 }));

    for (const invalid of [
      null,
      {},
      { afterEventSeq: 0, limit: 10, requestId: "journal-shape" },
      { afterEventSeq: -1, limit: 10 },
      { afterEventSeq: 0, limit: 0 },
      { afterEventSeq: 0, limit: 1_001 }
    ]) {
      expect(() => admission.readSanitizedEvents(invalid)).toThrow();
    }

    const raw = new Database(admission.databasePath);
    raw.prepare("UPDATE events SET kind = 'raw_error_detail' WHERE event_seq = 1").run();
    raw.close();
    expect(() => admission.readSanitizedEvents({ afterEventSeq: 0, limit: 10 })).toThrow(
      /non-allowlisted transition/
    );
  });

  it("rolls back request and lease state when the journal insert faults", () => {
    const admission = controller();
    const raw = new Database(admission.databasePath);
    raw.exec(`
      CREATE TRIGGER fail_event_insert BEFORE INSERT ON events
      BEGIN
        SELECT RAISE(ABORT, 'simulated journal fault');
      END;
    `);
    raw.close();

    const input = request({ requestId: "journal-rollback", now: 1_000 });
    expect(() => enqueueReady(admission, input, "rollback prompt")).toThrow(/simulated journal fault/);
    const afterEnqueueFault = new Database(admission.databasePath, { readonly: true });
    expect(afterEnqueueFault.prepare("SELECT COUNT(*) AS count FROM turn_requests").get()).toEqual({ count: 0 });
    expect(afterEnqueueFault.prepare("SELECT COUNT(*) AS count FROM turn_payloads").get()).toEqual({ count: 0 });
    expect(afterEnqueueFault.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    afterEnqueueFault.close();

    const repair = new Database(admission.databasePath);
    repair.exec("DROP TRIGGER fail_event_insert");
    repair.close();
    enqueueReady(admission, input, "rollback prompt");
    const lease = admission.admitNext(1_001, "rollback-owner")!;

    const broken = new Database(admission.databasePath);
    broken.exec(`
      CREATE TRIGGER fail_event_insert BEFORE INSERT ON events
      BEGIN
        SELECT RAISE(ABORT, 'simulated transition journal fault');
      END;
    `);
    broken.close();
    expect(() => admission.markStarting(lease, 1_002)).toThrow(/simulated transition journal fault/);

    const afterTransitionFault = new Database(admission.databasePath, { readonly: true });
    expect(afterTransitionFault.prepare("SELECT state FROM turn_requests WHERE request_id = ?").get(input.requestId)).toEqual({
      state: "admitted"
    });
    expect(afterTransitionFault.prepare("SELECT phase FROM leases WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      phase: "admitted"
    });
    expect(afterTransitionFault.prepare("SELECT COUNT(*) AS count FROM start_history WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      count: 0
    });
    expect(afterTransitionFault.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    afterTransitionFault.close();
  });

  it("keeps prompt, tool, header, token, credential, and key sentinels out of SQLite, WAL, SHM, and events", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-event-redaction-"));
    stateDirs.push(stateDir);
    const databasePath = path.join(stateDir, "runtime.sqlite");
    const encryptionKey = Buffer.alloc(32, 89);
    const contentFingerprintKey = Buffer.alloc(32, 90);
    const claimTokenKey = Buffer.alloc(32, 88);
    const admission = new AdmissionController({
      databasePath,
      policy: DEFAULT_POLICY,
      encryptionKey,
      contentFingerprintKey,
      claimTokenKey
    });
    const sensitive = [
      "PROMPT_SENTINEL_7f6508",
      "TOOL_ARGS_SENTINEL_23bb96",
      "AUTH_HEADER_SENTINEL_b5298d",
      "TOKEN_SENTINEL_92f3c1",
      "CREDENTIAL_SENTINEL_3e702a",
      "AGENT_ID_SENTINEL_b8bb21",
      "RAW_STREAM_SENTINEL_a135a0",
      "ERROR_DETAIL_SENTINEL_60f272"
    ];
    const input = request({ requestId: "redaction-request", now: 1_000 });
    admission.enqueueWithPayload(input, sensitive.join("|"), 61_000);
    admission.enqueueDelivery(
      delivery(input.requestId, { eventId: "redaction-event", payload: [...sensitive].reverse().join("|"), now: 1_001 })
    );

    const eventJson = JSON.stringify(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 10 }));
    for (const sentinel of [...sensitive, input.requestId, input.sessionId, input.parentId, input.provider, input.model]) {
      expect(eventJson).not.toContain(sentinel);
    }
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      for (const sentinel of sensitive) expect(bytes.includes(Buffer.from(sentinel, "utf8"))).toBe(false);
      for (const key of [encryptionKey, contentFingerprintKey, claimTokenKey]) expect(bytes.includes(key)).toBe(false);
    }
  });

  it("records a versioned schema migration that survives controller reconnect", () => {
    const first = controller();
    expect(first.schemaVersion).toBe(10);

    const second = new AdmissionController({ databasePath: first.databasePath, policy: first.policy });
    expect(second.schemaVersion).toBe(10);
  });

  it("refuses to bless a structurally incomplete version-1 database", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-v1-"));
    stateDirs.push(stateDir);
    const databasePath = path.join(stateDir, "runtime.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'admission-controller-core', 1000);
      CREATE TABLE leases (
        lease_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        owner_instance_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    expect(
      () =>
        new AdmissionController({
          databasePath,
          policy: DEFAULT_POLICY
        })
    ).toThrow();
  });

  it("refuses to open a current database whose schema drifted", () => {
    const admission = controller();
    const { databasePath, policy } = admission;
    admission.close();

    const drifted = new Database(databasePath);
    drifted.exec("DROP INDEX turn_requests_queue");
    drifted.close();

    expect(() => new AdmissionController({ databasePath, policy, encryptionKey: Buffer.alloc(32, 1) })).toThrow(
      SchemaIntegrityError
    );
  });

  it("rolls back schema migration when post-migration integrity fails", () => {
    const admission = controller();
    const { databasePath, policy } = admission;
    admission.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP INDEX events_occurred;
      DROP TABLE events;
      DROP INDEX delivery_claim_leases_expiry;
      DROP TABLE delivery_claim_leases;
      DROP INDEX sessions_updated_at_session_id;
      DROP INDEX sessions_cwd_updated_at_session_id;
      DROP TABLE sessions;
      DROP INDEX lease_process_identities_request;
      DROP TABLE lease_process_identities;
      DELETE FROM schema_migrations WHERE version IN (5, 6, 7, 8, 9, 10);
      DROP TABLE recovery_claims;
      ALTER TABLE delivery_outbox DROP COLUMN sequence;
      ALTER TABLE delivery_outbox DROP COLUMN protocol_version;
      ALTER TABLE delivery_outbox DROP COLUMN protocol_semantics;
      ALTER TABLE delivery_outbox DROP COLUMN claim_generation;
      ALTER TABLE delivery_outbox DROP COLUMN claim_owner_instance_id;
      ALTER TABLE delivery_outbox DROP COLUMN claim_acquired_at;
      ALTER TABLE delivery_outbox DROP COLUMN lease_id;
      ALTER TABLE delivery_outbox DROP COLUMN lease_generation;
      ALTER TABLE turn_requests ADD COLUMN unexpected TEXT;
    `);
    legacy.close();

    expect(() => new AdmissionController({ databasePath, policy, encryptionKey: Buffer.alloc(32, 1) })).toThrow(
      SchemaIntegrityError
    );

    const inspected = new Database(databasePath, { readonly: true });
    const migration = inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    expect(migration.version).toBe(4);
    expect(
      (inspected.pragma("table_info(delivery_outbox)") as Array<{ name: string }>).map((column) => column.name)
    ).not.toContain("claim_generation");
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_claims'").get()).toBeUndefined();
    inspected.close();
  });

  it("fails closed when migrating a legacy pending outbox event without a negotiated claim", () => {
    const first = controller();
    first.enqueue(request({ requestId: "legacy-pending", now: 1_000 }));
    first.enqueueDelivery(delivery("legacy-pending", { eventId: "legacy-event", now: 1_001 }));
    const { databasePath, policy } = first;
    first.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP INDEX events_occurred;
      DROP TABLE events;
      DROP INDEX delivery_claim_leases_expiry;
      DROP TABLE delivery_claim_leases;
      DROP INDEX sessions_updated_at_session_id;
      DROP INDEX sessions_cwd_updated_at_session_id;
      DROP TABLE sessions;
      DROP INDEX lease_process_identities_request;
      DROP TABLE lease_process_identities;
      DELETE FROM schema_migrations WHERE version IN (5, 6, 7, 8, 9, 10);
      DROP TABLE recovery_claims;
      ALTER TABLE delivery_outbox DROP COLUMN sequence;
      ALTER TABLE delivery_outbox DROP COLUMN protocol_version;
      ALTER TABLE delivery_outbox DROP COLUMN protocol_semantics;
      ALTER TABLE delivery_outbox DROP COLUMN claim_generation;
      ALTER TABLE delivery_outbox DROP COLUMN claim_owner_instance_id;
      ALTER TABLE delivery_outbox DROP COLUMN claim_acquired_at;
      ALTER TABLE delivery_outbox DROP COLUMN lease_id;
      ALTER TABLE delivery_outbox DROP COLUMN lease_generation;
    `);
    legacy.close();

    const migrated = new AdmissionController({
      databasePath,
      policy,
      encryptionKey: Buffer.alloc(32, 1),
      contentFingerprintKey: Buffer.alloc(32, 2),
      claimTokenKey: Buffer.alloc(32, 3)
    });
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.claimPendingDelivery("legacy-event", "delivery-worker", 1_002)).toBeNull();
    const inspected = new Database(databasePath, { readonly: true });
    expect(
      inspected
        .prepare("SELECT state, nonce, ciphertext, auth_tag FROM delivery_outbox WHERE event_id = 'legacy-event'")
        .get()
    ).toEqual({ state: "recovery_required", nonce: null, ciphertext: null, auth_tag: null });
    inspected.close();
    migrated.close();
  });

  it("is idempotent for a stable request identity and rejects an identity conflict", () => {
    const admission = controller();
    const first = request({ requestId: "request-1" });

    expect(admission.enqueue(first)).toEqual({ requestId: "request-1", existed: false });
    expect(admission.enqueue(first)).toEqual({ requestId: "request-1", existed: true });
    expect(() => admission.enqueue({ ...first, fingerprint: "different" })).toThrow(AdmissionConflictError);
    expect(() => admission.enqueue({ ...first, sessionId: "different-session" })).toThrow(AdmissionConflictError);
    expect(() => admission.enqueue({ ...first, parentId: "different-parent" })).toThrow(AdmissionConflictError);
    expect(() => admission.enqueue({ ...first, provider: "different-provider" })).toThrow(AdmissionConflictError);
    expect(() => admission.enqueue({ ...first, model: "different-model" })).toThrow(AdmissionConflictError);
  });

  it("keeps request, delivery, and lease identifiers out of typed error messages", () => {
    const requestId = "private-request-identifier";
    const eventId = "private-delivery-identifier";
    const leaseId = "private-lease-identifier";
    const errors = [
      new AdmissionConflictError(requestId),
      new PayloadConflictError(requestId),
      new DeliveryConflictError(eventId),
      new DeliveryClaimFenceError(eventId),
      new LeaseFenceError(leaseId)
    ];

    for (const error of errors) {
      expect(error.message).not.toContain(requestId);
      expect(error.message).not.toContain(eventId);
      expect(error.message).not.toContain(leaseId);
    }
  });

  it("rejects malformed request metadata before writing SQLite state", () => {
    const admission = controller();
    for (const field of ["requestId", "sessionId", "parentId", "fingerprint", "provider", "model"] as const) {
      expect(() => admission.enqueue({ ...request(), [field]: "" })).toThrow(/request metadata/);
      expect(() => admission.enqueue({ ...request(), [field]: "contains\0nul" })).toThrow(/request metadata/);
    }
    expect(() => admission.enqueue(request({ now: Number.NaN }))).toThrow(/request timestamp/);
    expect(() => admission.enqueue(request({ now: 1.5 }))).toThrow(/request timestamp/);
  });

  it("does not admit request metadata until its encrypted payload is durable", () => {
    const admission = controller();
    admission.enqueue(request({ requestId: "metadata-only", now: 1_000 }));

    expect(admission.admitNext(1_001, "connector-a")).toBeNull();
  });

  it("atomically enqueues one immutable payload for a stable request identity", () => {
    const admission = controller();
    const input = request({ requestId: "atomic", now: 1_000 });

    expect(admission.enqueueWithPayload(input, "prompt-a", 2_000)).toEqual({ requestId: "atomic", existed: false });
    expect(admission.enqueueWithPayload(input, "prompt-a", 2_000)).toEqual({ requestId: "atomic", existed: true });
    expect(() => admission.enqueueWithPayload(input, "prompt-b", 2_000)).toThrow(PayloadConflictError);
    expect(admission.admitNext(1_001, "connector-a")?.requestId).toBe("atomic");
  });

  it("purges only a timed-out queued payload while preserving its nonreplayable tombstone", () => {
    const admission = controller({ maxActiveTurns: 2, maxConcurrentStarts: 2, queueTimeoutMs: 1 });
    const dispatchInput = request({
      requestId: "timeout-dispatch-private",
      sessionId: "timeout-dispatch-session",
      parentId: "timeout-dispatch-parent",
      now: 1_001
    });
    const recoveryInput = request({
      requestId: "timeout-recovery-private",
      sessionId: "timeout-recovery-session",
      parentId: "timeout-recovery-parent",
      now: 1_002
    });
    const timedOutInput = request({
      requestId: "timeout-request-private",
      sessionId: "timeout-session-private",
      parentId: "timeout-parent-private",
      now: 1_003
    });
    const timeoutPrompt = "timeout-prompt-private";

    enqueueReady(admission, dispatchInput, "dispatch-prompt-private");
    const dispatch = admission.admitRequest(dispatchInput.requestId, 1_001, "timeout-dispatch-owner")!;
    admission.markStarting(dispatch, 1_001);
    admission.markDispatchIntent(dispatch, 1_001);
    enqueueReady(admission, recoveryInput, "recovery-prompt-private");
    const recovery = admission.admitRequest(recoveryInput.requestId, 1_002, "timeout-recovery-owner")!;
    admission.recoverOwner(recovery.leaseId, 1_002, "timeout-recovery-claimant");
    admission.enqueueWithPayload(timedOutInput, timeoutPrompt, 61_003);

    expect(admission.admitNext(1_004, "timeout-sweeper")).toBeNull();
    expect(admission.getRequest(timedOutInput.requestId)?.state).toBe("queue_timeout");

    let payloadReadFailure = "";
    try {
      admission.readPayload(timedOutInput.requestId, 1_004);
    } catch (error) {
      payloadReadFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    expect(payloadReadFailure).toBe("Error: no payload is available");
    expect(payloadReadFailure).not.toContain(timedOutInput.requestId);
    expect(payloadReadFailure).not.toContain(timeoutPrompt);

    let reconnectFailure = "";
    try {
      admission.enqueueWithPayload(timedOutInput, timeoutPrompt, 61_003);
    } catch (error) {
      reconnectFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    expect(reconnectFailure).toBe("Error: request is no longer queued");
    expect(reconnectFailure).not.toContain(timedOutInput.requestId);
    expect(reconnectFailure).not.toContain(timeoutPrompt);
    expect(admission.getRequest(timedOutInput.requestId)?.state).toBe("queue_timeout");

    expect(admission.getRequest(dispatchInput.requestId)?.state).toBe("dispatch_intent");
    expect(admission.getRequest(recoveryInput.requestId)?.state).toBe("recovery_required");
    expect(admission.readPayload(dispatchInput.requestId, 1_004)).toBe("dispatch-prompt-private");
    expect(admission.readPayload(recoveryInput.requestId, 1_004)).toBe("recovery-prompt-private");

    const raw = new Database(admission.databasePath, { readonly: true });
    expect(
      raw
        .prepare("SELECT request_id FROM turn_payloads WHERE request_id IN (?, ?, ?) ORDER BY request_id ASC")
        .all(dispatchInput.requestId, recoveryInput.requestId, timedOutInput.requestId)
    ).toEqual([
      { request_id: dispatchInput.requestId },
      { request_id: recoveryInput.requestId }
    ]);
    raw.close();

    const journal = JSON.stringify(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 50 }));
    for (const privateValue of [timedOutInput.requestId, timeoutPrompt, timedOutInput.sessionId, timedOutInput.parentId]) {
      expect(journal).not.toContain(privateValue);
    }
  });

  it("rolls back timeout state, payload deletion, and journal when its audit write faults", () => {
    const admission = controller({ queueTimeoutMs: 1 });
    const input = request({ requestId: "timeout-rollback-private", now: 1_000 });
    const prompt = "timeout-rollback-prompt-private";
    admission.enqueueWithPayload(input, prompt, 61_000);

    const raw = new Database(admission.databasePath);
    raw.exec(`
      CREATE TRIGGER fail_queue_timeout_event BEFORE INSERT ON events
      WHEN NEW.kind = 'request_queue_timed_out'
      BEGIN
        SELECT RAISE(ABORT, 'simulated queue timeout journal fault');
      END;
    `);
    raw.close();

    let failure = "";
    try {
      admission.admitNext(1_001, "timeout-fault-owner");
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    expect(failure).toContain("simulated queue timeout journal fault");
    expect(failure).not.toContain(input.requestId);
    expect(failure).not.toContain(prompt);
    expect(admission.getRequest(input.requestId)?.state).toBe("queued");
    expect(admission.readPayload(input.requestId, 1_001)).toBe(prompt);

    const rolledBack = new Database(admission.databasePath, { readonly: true });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?").get(input.requestId)).toEqual({
      count: 1
    });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'request_queue_timed_out'").get()).toEqual({
      count: 0
    });
    rolledBack.close();
  });

  it("shares active capacity across controller processes", () => {
    const first = controller();
    const second = new AdmissionController({
      databasePath: first.databasePath,
      policy: first.policy,
      contentFingerprintKey: Buffer.alloc(32, 2)
    });
    enqueueReady(first, request({ requestId: "one", now: 1_000 }));
    enqueueReady(first, request({ requestId: "two", now: 1_001, sessionId: "session-b", parentId: "parent-b" }));

    const lease = first.admitNext(1_002, "connector-a");
    expect(lease?.requestId).toBe("one");
    expect(second.admitNext(1_003, "connector-b")).toBeNull();

    first.markStarting(lease!, 1_004);
    first.markDispatchIntent(lease!, 1_005);
    first.markActive(lease!, 1_006);
    first.markProviderTerminal(lease!, 1_007, terminalObservations(), delivery("one", { now: 1_007 }));
    first.release(lease!, 1_008);
    expect(second.admitNext(1_009, "connector-b")?.requestId).toBe("two");
  });

  it("does not mutate an older request when a later request asks for targeted admission", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "fifo-a", now: 1_000 }));
    enqueueReady(
      admission,
      request({ requestId: "fifo-b", sessionId: "session-b", parentId: "parent-b", now: 1_001 })
    );

    expect(admission.admitRequest("fifo-b", 1_002, "connector-b")).toBeNull();
    expect(admission.getRequest("fifo-a")?.state).toBe("queued");
    expect(admission.getRequest("fifo-b")?.state).toBe("queued");
    const raw = new Database(admission.databasePath, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM leases").get()).toEqual({ count: 0 });
    raw.close();
  });

  it("admits the oldest eligible request past a cooldown-blocked queue head", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "blocked-a", provider: "provider-a", model: "model-a", now: 1_000 }));
    enqueueReady(
      admission,
      request({
        requestId: "waiting-b",
        sessionId: "session-b",
        parentId: "parent-b",
        provider: "provider-b",
        model: "model-b",
        now: 1_001
      })
    );
    admission.setCapacityCooldown("provider-a", "model-a", 2_000, 1_001);

    expect(admission.admitRequest("waiting-b", 1_002, "connector-b")?.requestId).toBe("waiting-b");
    expect(admission.getRequest("blocked-a")?.state).toBe("queued");
    expect(admission.getRequest("waiting-b")?.state).toBe("admitted");
  });

  it("reports durable queue position and cooldown without granting mutation authority", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "queue-a", provider: "provider-a", model: "model-a", now: 1_000 }));
    enqueueReady(admission, request({
      requestId: "queue-b",
      sessionId: "session-b",
      parentId: "parent-b",
      provider: "provider-b",
      model: "model-b",
      now: 1_001
    }));
    admission.setCapacityCooldown("provider-a", "model-a", 2_000, 1_001);

    expect(admission.getQueueSnapshot("queue-a", 1_010)).toEqual({
      requestId: "queue-a",
      position: 1,
      eligiblePosition: null,
      enqueuedAt: 1_000,
      waitedMs: 10,
      cooldownUntil: 2_000
    });
    expect(admission.getQueueSnapshot("queue-b", 1_010)).toEqual({
      requestId: "queue-b",
      position: 2,
      eligiblePosition: 1,
      enqueuedAt: 1_001,
      waitedMs: 9,
      cooldownUntil: null
    });
    expect(admission.getRequest("queue-a")?.state).toBe("queued");
    expect(admission.getRequest("queue-b")?.state).toBe("queued");
  });

  it("admits one targeted lease across controller instances", () => {
    const first = controller();
    const second = new AdmissionController({ databasePath: first.databasePath, policy: first.policy });
    enqueueReady(first, request({ requestId: "one-target", now: 1_000 }));

    const firstLease = first.admitRequest("one-target", 1_001, "connector-a");
    const secondLease = second.admitRequest("one-target", 1_001, "connector-b");

    expect([firstLease, secondLease].filter((lease) => lease !== null)).toHaveLength(1);
    expect(first.getRequest("one-target")?.state).toBe("admitted");
    const raw = new Database(first.databasePath, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM leases WHERE request_id = 'one-target'").get()).toEqual({ count: 1 });
    raw.close();
    second.close();
  });

  it("has no targeted-admission side effects for expiry, cooldown, capacity, or start rate", () => {
    const expired = controller({ queueTimeoutMs: 1 });
    enqueueReady(expired, request({ requestId: "expired-target", now: 1_000 }));
    expect(expired.admitRequest("expired-target", 1_001, "connector-a")).toBeNull();
    expect(expired.getRequest("expired-target")?.state).toBe("queue_timeout");

    const cooled = controller();
    enqueueReady(cooled, request({ requestId: "cooled-target", now: 1_000 }));
    cooled.setCapacityCooldown("antigravity", "claude-opus-4-6-thinking", 2_000, 1_000);
    expect(cooled.admitRequest("cooled-target", 1_001, "connector-a")).toBeNull();
    expect(cooled.getRequest("cooled-target")?.state).toBe("queued");

    const capacity = controller({ maxActiveTurns: 1 });
    enqueueReady(capacity, request({ requestId: "capacity-holder", now: 1_000 }));
    enqueueReady(
      capacity,
      request({ requestId: "capacity-target", sessionId: "session-b", parentId: "parent-b", now: 1_001 })
    );
    expect(capacity.admitRequest("capacity-holder", 1_002, "connector-a")?.requestId).toBe("capacity-holder");
    expect(capacity.admitRequest("capacity-target", 1_003, "connector-b")).toBeNull();
    expect(capacity.getRequest("capacity-target")?.state).toBe("queued");

    const rateLimited = controller({ maxActiveTurns: 2, maxConcurrentStarts: 2, minStartIntervalMs: 100 });
    enqueueReady(rateLimited, request({ requestId: "rate-first", now: 1_000 }));
    enqueueReady(
      rateLimited,
      request({ requestId: "rate-target", sessionId: "session-b", parentId: "parent-b", now: 1_001 })
    );
    const first = rateLimited.admitRequest("rate-first", 1_002, "connector-a")!;
    rateLimited.markStarting(first, 1_010);
    expect(rateLimited.admitRequest("rate-target", 1_050, "connector-b")).toBeNull();
    expect(rateLimited.getRequest("rate-target")?.state).toBe("queued");

    for (const admission of [expired, cooled, capacity, rateLimited]) {
      const raw = new Database(admission.databasePath, { readonly: true });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM leases").get()).toEqual({
        count: admission === capacity || admission === rateLimited ? 1 : 0
      });
      raw.close();
    }
  });

  it("rejects stale owner and generation fences on lease mutations", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "fenced" }));
    const lease = admission.admitNext(1_001, "connector-a")!;

    expect(() => admission.heartbeat({ ...lease, ownerInstanceId: "connector-b" }, 1_002)).toThrow(LeaseFenceError);
    expect(() => admission.markStarting({ ...lease, generation: lease.generation + 1 }, 1_003)).toThrow(
      LeaseFenceError
    );

    admission.heartbeat(lease, 1_004);
    admission.markStarting(lease, 1_005);
    expect(admission.getRequest("fenced")?.state).toBe("starting");
  });

  it("atomically records verified Linux process identity with dispatch intent and preserves exact replay", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "atomic-dispatch", now: 1_000 }));
    const lease = admission.admitNext(1_001, LINUX_OWNER_INSTANCE_ID)!;
    admission.markStarting(lease, 1_002);
    const record = linuxProcessRecord(lease);

    expect(admission.recordProcessIdentity(record)).toEqual({ status: "recorded", idempotent: false });
    expect(admission.getRequest(lease.requestId)?.state).toBe("dispatch_intent");
    expect(admission.commitDispatchIntent(record)).toEqual({ status: "committed", idempotent: true });
    expect(admission.recordProcessIdentity(record)).toEqual({ status: "recorded", idempotent: true });

    const raw = new Database(admission.databasePath, { readonly: true });
    expect(
      raw
        .prepare(
          `SELECT request_id, lease_generation, owner_instance_id, prompt_channel,
                  connector_owner_instance_id, connector_pid, child_pid, child_start_time_ticks
           FROM lease_process_identities WHERE lease_id = ?`
        )
        .get(lease.leaseId)
    ).toEqual({
      request_id: lease.requestId,
      lease_generation: lease.generation,
      owner_instance_id: LINUX_OWNER_INSTANCE_ID,
      prompt_channel: "stdin",
      connector_owner_instance_id: LINUX_OWNER_INSTANCE_ID,
      connector_pid: 3711,
      child_pid: 4182,
      child_start_time_ticks: "1234567890999"
    });
    raw.close();
  });

  it("fails closed on stale owner or generation fences without persisting a process identity", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "stale-atomic-dispatch", now: 1_000 }));
    const lease = admission.admitNext(1_001, LINUX_OWNER_INSTANCE_ID)!;
    admission.markStarting(lease, 1_002);

    expect(admission.recordProcessIdentity(linuxProcessRecord({ ...lease, ownerInstanceId: "22222222-2222-4222-8222-222222222222" }))).toEqual({
      status: "not_recorded",
      reason: "stale_lease"
    });
    expect(admission.commitDispatchIntent(linuxProcessRecord({ ...lease, generation: lease.generation + 1 }))).toEqual({
      status: "not_committed",
      reason: "stale_lease"
    });
    expect(admission.getRequest(lease.requestId)?.state).toBe("starting");

    const raw = new Database(admission.databasePath, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM lease_process_identities WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      count: 0
    });
    raw.close();
  });

  it("refuses a duplicate or conflicting process identity instead of changing the durable dispatch intent", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "conflicting-atomic-dispatch", now: 1_000 }));
    const lease = admission.admitNext(1_001, LINUX_OWNER_INSTANCE_ID)!;
    admission.markStarting(lease, 1_002);
    const record = linuxProcessRecord(lease);
    const conflicting = linuxProcessRecord({
      ...lease,
      ownerInstanceId: LINUX_OWNER_INSTANCE_ID
    });
    conflicting.processIdentity = {
      ...conflicting.processIdentity,
      child: { ...conflicting.processIdentity.child, startTimeTicks: "1234567891000" }
    };

    expect(admission.recordProcessIdentity(record)).toEqual({ status: "recorded", idempotent: false });
    expect(admission.recordProcessIdentity(conflicting)).toEqual({ status: "not_recorded", reason: "conflicting_intent" });
    expect(admission.commitDispatchIntent(conflicting)).toEqual({ status: "not_committed", reason: "conflicting_intent" });

    const raw = new Database(admission.databasePath, { readonly: true });
    expect(
      raw.prepare("SELECT child_start_time_ticks FROM lease_process_identities WHERE lease_id = ?").get(lease.leaseId)
    ).toEqual({ child_start_time_ticks: "1234567890999" });
    raw.close();
  });

  it("rolls back the identity and dispatch transition when a fault occurs after identity persistence", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-atomic-fault-"));
    stateDirs.push(stateDir);
    let injected = false;
    const admission = new AdmissionController({
      databasePath: path.join(stateDir, "runtime.sqlite"),
      policy: DEFAULT_POLICY,
      encryptionKey: Buffer.alloc(32, 1),
      contentFingerprintKey: Buffer.alloc(32, 2),
      claimTokenKey: Buffer.alloc(32, 3),
      faultInjection: {
        afterProcessIdentityPersisted() {
          injected = true;
          throw new Error("simulated crash after process identity persistence");
        }
      }
    });
    enqueueReady(admission, request({ requestId: "atomic-fault", now: 1_000 }));
    const lease = admission.admitNext(1_001, LINUX_OWNER_INSTANCE_ID)!;
    admission.markStarting(lease, 1_002);

    expect(admission.recordProcessIdentity(linuxProcessRecord(lease))).toEqual({
      status: "not_recorded",
      reason: "transaction_fault"
    });
    expect(injected).toBe(true);
    expect(admission.getRequest(lease.requestId)?.state).toBe("starting");

    const raw = new Database(admission.databasePath, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM lease_process_identities WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      count: 0
    });
    expect(raw.prepare("SELECT phase FROM leases WHERE lease_id = ?").get(lease.leaseId)).toEqual({ phase: "starting" });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'request_dispatch_intent'").get()).toEqual({
      count: 0
    });
    raw.close();
  });

  it("lists a sanitized exact recovery inventory after a cross-process restart", () => {
    const first = controller();
    const input = request({
      requestId: "restart-inventory-request",
      sessionId: "restart-inventory-session",
      parentId: "restart-inventory-parent",
      fingerprint: "restart-inventory-fingerprint",
      provider: "antigravity",
      model: "claude-opus-4-6-thinking",
      now: 1_000
    });
    enqueueReady(first, input, "private restart inventory prompt");
    first.enqueueDelivery(
      delivery(input.requestId, {
        eventId: "restart-inventory-outbox",
        payload: "private restart inventory outbox payload",
        now: 1_000
      })
    );
    const lease = first.admitNext(1_001, LINUX_OWNER_INSTANCE_ID)!;
    first.markStarting(lease, 1_002);
    expect(first.recordProcessIdentity(linuxProcessRecord(lease))).toEqual({ status: "recorded", idempotent: false });

    const durable = new Database(first.databasePath, { readonly: true });
    const heartbeat = durable.prepare("SELECT heartbeat_at FROM leases WHERE lease_id = ?").get(lease.leaseId) as {
      heartbeat_at: number;
    };
    durable.close();
    const { databasePath } = first;
    first.close();

    const child = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), "tests/helpers/admission-controller-child.mjs"), "list-recoverable", databasePath],
      { encoding: "utf8" }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");

    const inventory = JSON.parse(child.stdout) as unknown[];
    expect(inventory).toEqual([
      {
        requestId: input.requestId,
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        fence: {
          leaseId: lease.leaseId,
          generation: lease.generation,
          ownerInstanceId: lease.ownerInstanceId
        },
        phase: "dispatch_intent",
        heartbeatAt: heartbeat.heartbeat_at,
        processIdentity: {
          promptChannel: "stdin",
          connector: linuxProcessRecord(lease).processIdentity.connector,
          child: linuxProcessRecord(lease).processIdentity.child
        }
      }
    ]);
    expect(child.stdout).not.toContain("private restart inventory prompt");
    expect(child.stdout).not.toContain("private restart inventory outbox payload");
    expect(inventory[0]).not.toHaveProperty("payload");
    expect(inventory[0]).not.toHaveProperty("fingerprint");
    expect(inventory[0]).not.toHaveProperty("parentId");
  });

  it("keeps a missing process identity explicit so startup recovery cannot resume the dispatch", () => {
    const admission = controller();
    const input = request({ requestId: "missing-inventory-identity", now: 1_000 });
    enqueueReady(admission, input);
    const lease = admission.admitNext(1_001, "connector-a")!;
    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);

    expect(admission.listRecoverableDispatches()).toEqual([
      {
        requestId: input.requestId,
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        fence: {
          leaseId: lease.leaseId,
          generation: lease.generation,
          ownerInstanceId: lease.ownerInstanceId
        },
        phase: "dispatch_intent",
        heartbeatAt: 1_003,
        processIdentity: null
      }
    ]);
  });

  it("orders nonterminal recovery candidates deterministically and excludes provider-terminal leases", () => {
    const admission = controller({ maxActiveTurns: 2, maxConcurrentStarts: 2 });
    const later = request({
      requestId: "inventory-later",
      sessionId: "inventory-session-later",
      parentId: "inventory-parent-later",
      now: 1_001
    });
    const firstById = request({
      requestId: "inventory-a",
      sessionId: "inventory-session-a",
      parentId: "inventory-parent-a",
      now: 1_000
    });
    const terminal = request({
      requestId: "inventory-terminal",
      sessionId: "inventory-session-terminal",
      parentId: "inventory-parent-terminal",
      now: 1_000
    });
    for (const input of [later, terminal, firstById]) enqueueReady(admission, input);

    const firstLease = admission.admitNext(1_002, "connector-a")!;
    const terminalLease = admission.admitNext(1_003, "connector-b")!;
    expect([firstLease.requestId, terminalLease.requestId]).toEqual([
      firstById.requestId,
      terminal.requestId
    ]);

    admission.markStarting(firstLease, 1_005);
    admission.markDispatchIntent(firstLease, 1_006);
    admission.markStarting(terminalLease, 1_007);
    admission.markDispatchIntent(terminalLease, 1_008);
    admission.markActive(terminalLease, 1_009);
    admission.markProviderTerminal(
      terminalLease,
      1_010,
      terminalObservations(),
      delivery(terminal.requestId, { now: 1_010 })
    );
    const laterLease = admission.admitNext(1_011, "connector-c")!;
    expect(laterLease.requestId).toBe(later.requestId);
    admission.markStarting(laterLease, 1_012);
    admission.markDispatchIntent(laterLease, 1_013);

    expect(admission.listRecoverableDispatches().map((entry) => entry.requestId)).toEqual([
      firstById.requestId,
      later.requestId
    ]);
  });

  it("fails closed when a persisted nonterminal process identity is corrupt", () => {
    const admission = controller();
    const input = request({ requestId: "corrupt-inventory-identity", now: 1_000 });
    enqueueReady(admission, input);
    const lease = admission.admitNext(1_001, LINUX_OWNER_INSTANCE_ID)!;
    admission.markStarting(lease, 1_002);
    expect(admission.recordProcessIdentity(linuxProcessRecord(lease))).toEqual({ status: "recorded", idempotent: false });

    const corrupt = new Database(admission.databasePath);
    corrupt.prepare("UPDATE lease_process_identities SET child_pid = 0 WHERE lease_id = ?").run(lease.leaseId);
    corrupt.close();

    expect(() => admission.listRecoverableDispatches()).toThrow(/recoverable dispatch inventory/i);
  });

  it("fails closed when a persisted lease and request no longer share an exact generation fence", () => {
    const admission = controller();
    const input = request({ requestId: "corrupt-inventory-fence", now: 1_000 });
    enqueueReady(admission, input);
    const lease = admission.admitNext(1_001, "connector-a")!;

    const corrupt = new Database(admission.databasePath);
    corrupt.prepare("UPDATE turn_requests SET lease_generation = lease_generation + 1 WHERE request_id = ?").run(lease.requestId);
    corrupt.close();

    expect(() => admission.listRecoverableDispatches()).toThrow(/recoverable dispatch inventory/i);
  });

  it("prefers an eligible parent with no active turn over a parent that already owns capacity", () => {
    const admission = controller({ maxActiveTurns: 2, maxConcurrentStarts: 2 });
    enqueueReady(admission, request({ requestId: "a-1", parentId: "parent-a", now: 1_000 }));
    enqueueReady(
      admission,
      request({ requestId: "a-2", parentId: "parent-a", sessionId: "session-a-2", now: 1_001 })
    );
    enqueueReady(admission, request({ requestId: "b-1", parentId: "parent-b", sessionId: "session-b", now: 1_002 }));

    expect(admission.admitNext(1_003, "connector-a")?.requestId).toBe("a-1");
    expect(admission.admitNext(1_004, "connector-b")?.requestId).toBe("b-1");
  });

  it("does not admit a provider/model held in capacity cooldown", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "blocked" }));
    admission.setCapacityCooldown("antigravity", "claude-opus-4-6-thinking", 31_000, 1_000);

    expect(admission.admitNext(1_001, "connector-a")).toBeNull();
    expect(admission.admitNext(31_001, "connector-a")?.requestId).toBe("blocked");
  });

  it("never shortens an existing provider capacity cooldown", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "monotonic-cooldown" }));
    admission.setCapacityCooldown("antigravity", "claude-opus-4-6-thinking", 31_000, 1_000);
    admission.setCapacityCooldown("antigravity", "claude-opus-4-6-thinking", 10_000, 2_000);

    expect(admission.admitNext(10_001, "connector-a")).toBeNull();
    expect(admission.admitNext(31_001, "connector-a")?.requestId).toBe("monotonic-cooldown");
  });

  it("rejects fractional policy values", () => {
    expect(() => controller({ maxActiveTurns: 1.5 })).toThrow(/maxActiveTurns/);
    expect(() => controller({ maxActiveTurns: 3 })).toThrow(/maxActiveTurns/);
    expect(() => controller({ minStartIntervalMs: 0.5 })).toThrow(/minStartIntervalMs/);
  });

  it("cancels a queued request before dispatch and erases its durable prompt", () => {
    const admission = controller({}, Buffer.alloc(32, 3));
    admission.enqueue(request({ requestId: "queued-cancel", now: 1_000 }));
    admission.persistPayload("queued-cancel", "do not run this prompt", 1_001, 2_000);

    admission.cancelQueued("queued-cancel", 1_002);
    expect(admission.getRequest("queued-cancel")?.state).toBe("cancelled");
    expect(() => admission.readPayload("queued-cancel", 1_003)).toThrow(/no payload/);
    expect(admission.admitNext(1_004, "connector-a")).toBeNull();
  });

  it("turns an unobserved dispatch into recovery_required and never requeues it", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "ambiguous" }));
    const lease = admission.admitNext(1_001, "connector-a")!;

    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);
    const claim = admission.recoverOwner(lease.leaseId, 1_004, "recovery-a");
    const attestations = admission.createRecoveryResolutionAttestations(
      claim,
      "confirmed_not_dispatched_requeue",
      "pre_dispatch_residue_empty",
      "dispatch_ambiguous"
    );
    expect(
      admission.resolveRecovery(
        {
          claim,
          action: "confirmed_not_dispatched_requeue",
          evidenceCode: "pre_dispatch_residue_empty",
          reasonCode: "dispatch_ambiguous",
          ...attestations
        },
        1_004
      )
    ).toEqual({ accepted: false, nextState: "recovery_required", rejectionCode: "evidence_mismatch" });

    expect(admission.getRequest("ambiguous")?.state).toBe("recovery_required");
    expect(admission.admitNext(1_005, "connector-b")).toBeNull();
  });

  it("records an ambiguous prompt write as non-replayable capacity debt", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "ambiguous-write", now: 1_000 }));
    enqueueReady(
      admission,
      request({ requestId: "waiting", sessionId: "session-b", parentId: "parent-b", now: 1_001 })
    );
    const lease = admission.admitNext(1_002, "connector-a")!;
    admission.markStarting(lease, 1_003);
    admission.markDispatchIntent(lease, 1_004);

    admission.markDispatchAmbiguous(lease, 1_005);

    expect(admission.getRequest("ambiguous-write")?.state).toBe("dispatch_ambiguous");
    expect(admission.admitNext(1_006, "connector-b")).toBeNull();
    expect(() => admission.release(lease, 1_007)).toThrow(/provider terminal/);
  });

  it("releases capacity only after a confirmed provider terminal outcome", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "terminal-proof", now: 1_000 }));
    const lease = admission.admitNext(1_001, "connector-a")!;
    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);
    admission.markActive(lease, 1_004);

    expect(() => admission.release(lease, 1_005)).toThrow(/provider terminal/);
    admission.markProviderTerminal(lease, 1_006, terminalObservations(), delivery("terminal-proof", { now: 1_006 }));
    expect(admission.getRequest("terminal-proof")?.state).toBe("provider_terminal");
    admission.release(lease, 1_007);
    expect(admission.getRequest("terminal-proof")?.state).toBe("completed");
  });

  it("atomically records provider terminal evidence with an encrypted delivery outbox row", () => {
    const admission = controller({}, Buffer.alloc(32, 8));
    enqueueReady(admission, request({ requestId: "terminal-atomic", now: 1_000 }));
    admission.enqueue(request({ requestId: "terminal-collision", now: 1_000, sessionId: "other-session" }));
    admission.enqueueDelivery(
      delivery("terminal-collision", { eventId: "terminal-event", payload: "other terminal output", now: 1_001 })
    );
    const lease = admission.admitNext(1_002, "connector-a")!;
    admission.markStarting(lease, 1_003);
    admission.markDispatchIntent(lease, 1_004);
    admission.markActive(lease, 1_005);

    expect(() =>
      admission.markProviderTerminal(
        lease,
        1_006,
        terminalObservations(),
        delivery("terminal-atomic", { eventId: "terminal-event", payload: "secret terminal output", now: 1_006 })
      )
    ).toThrow(DeliveryConflictError);
    expect(admission.getRequest("terminal-atomic")?.state).toBe("active");

    admission.markProviderTerminal(
      lease,
      1_007,
      terminalObservations(),
      delivery("terminal-atomic", { eventId: "terminal-event-atomic", payload: "secret terminal output", now: 1_007 })
    );
    const raw = new Database(admission.databasePath, { readonly: true });
    expect(
      raw
        .prepare("SELECT request_id, state, lease_id, lease_generation FROM delivery_outbox WHERE event_id = 'terminal-event-atomic'")
        .get()
    ).toEqual({
      request_id: "terminal-atomic",
      state: "pending",
      lease_id: lease.leaseId,
      lease_generation: lease.generation
    });
    raw.close();
    expect(readFileSync(admission.databasePath, "utf8")).not.toContain("secret terminal output");
  });

  it("rolls back the provider-terminal outbox midpoint test fault without exposing callback data", () => {
    const privatePayload = "terminal-fault-payload-must-not-leak";
    let hookCalls = 0;
    const admission = controller({}, {}, {
      afterProviderTerminalOutboxPersisted() {
        hookCalls += 1;
        if (hookCalls === 1) throw new Error(privatePayload);
      }
    });
    const input = request({ requestId: "terminal-midpoint-fault", now: 1_000 });
    const terminalDelivery = delivery(input.requestId, {
      eventId: "terminal-midpoint-fault-event",
      now: 1_005,
      payload: privatePayload
    });
    enqueueReady(admission, input);
    const lease = admission.admitNext(1_001, "connector-a")!;
    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);
    admission.markActive(lease, 1_004);
    const beforeEvents = admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 });

    let failure = "";
    try {
      admission.markProviderTerminal(lease, 1_005, terminalObservations(), terminalDelivery);
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    expect(failure).toBe("AdmissionControllerInjectedFaultError: admission transaction fault injection");
    expect(failure).not.toContain(privatePayload);
    expect(hookCalls).toBe(1);
    expect(admission.getRequest(input.requestId)?.state).toBe("active");
    expect(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 })).toEqual(beforeEvents);
    expect(admission.listRecoverableOutboxClaims()).toEqual([]);
    const rolledBack = new Database(admission.databasePath, { readonly: true });
    expect(rolledBack.prepare("SELECT phase, terminal_outcome FROM leases WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      phase: "active",
      terminal_outcome: null
    });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get()).toEqual({ count: 0 });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM delivery_claim_leases").get()).toEqual({ count: 0 });
    rolledBack.close();

    admission.markProviderTerminal(lease, 1_005, terminalObservations(), terminalDelivery);
    expect(hookCalls).toBe(2);
    const retried = new Database(admission.databasePath, { readonly: true });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get()).toEqual({ count: 1 });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'delivery_enqueued'").get()).toEqual({ count: 1 });
    retried.close();
  });

  it("persists a strict SQLite-primary terminal without a stream observation timestamp", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "terminal-sqlite-primary", now: 1_000 }));
    const lease = admission.admitNext(1_001, "connector-a")!;
    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);
    admission.markActive(lease, 1_004);

    admission.markProviderTerminal(
      lease,
      1_005,
      {
        outcome: "failed",
        conversationId: "conversation-sqlite-primary",
        status: "ERROR",
        streamObservedAt: null,
        sqliteObservedAt: 1_504,
        failure: {
          category: "provider_capacity",
          httpStatus: 503,
          code: "UNAVAILABLE",
          reason: undefined
        }
      },
      delivery("terminal-sqlite-primary", { now: 1_005 })
    );

    const raw = new Database(admission.databasePath, { readonly: true });
    expect(
      raw.prepare(
        `SELECT terminal_conversation_id, terminal_status, terminal_stream_observed_at, terminal_sqlite_observed_at,
                terminal_failure_category, terminal_http_status, terminal_code, terminal_reason
         FROM leases WHERE lease_id = ?`
      ).get(lease.leaseId)
    ).toEqual({
      terminal_conversation_id: "conversation-sqlite-primary",
      terminal_status: "ERROR",
      terminal_stream_observed_at: null,
      terminal_sqlite_observed_at: 1_504,
      terminal_failure_category: "provider_capacity",
      terminal_http_status: 503,
      terminal_code: "UNAVAILABLE",
      terminal_reason: null
    });
    raw.close();

    admission.release(lease, 1_006);
    expect(admission.getRequest("terminal-sqlite-primary")?.state).toBe("failed");
  });

  it("keeps SQLite-primary terminals request-specific and fenced without releasing capacity", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "terminal-fenced", now: 1_000 }));
    enqueueReady(
      admission,
      request({ requestId: "terminal-waiting", sessionId: "session-b", parentId: "parent-b", now: 1_001 })
    );
    const lease = admission.admitNext(1_002, "connector-a")!;
    admission.markStarting(lease, 1_003);
    admission.markDispatchIntent(lease, 1_004);
    admission.markActive(lease, 1_005);
    const evidence = {
      outcome: "completed" as const,
      conversationId: "conversation-terminal-fenced",
      status: "SUCCESS" as const,
      streamObservedAt: null,
      sqliteObservedAt: 1_005,
      failure: null
    };

    expect(() =>
      admission.markProviderTerminal(
        lease,
        1_006,
        evidence,
        delivery("other-request", { eventId: "wrong-terminal-request", now: 1_006 })
      )
    ).toThrow(DeliveryConflictError);
    expect(() =>
      admission.markProviderTerminal(
        { ...lease, generation: lease.generation + 1 },
        1_007,
        evidence,
        delivery("terminal-fenced", { eventId: "stale-terminal-fence", now: 1_007 })
      )
    ).toThrow(LeaseFenceError);

    expect(admission.getRequest("terminal-fenced")?.state).toBe("active");
    expect(admission.admitNext(1_008, "connector-b")).toBeNull();
    const raw = new Database(admission.databasePath, { readonly: true });
    expect(raw.prepare("SELECT phase, terminal_status FROM leases WHERE lease_id = ?").get(lease.leaseId)).toEqual({
      phase: "active",
      terminal_status: null
    });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get()).toEqual({ count: 0 });
    raw.close();
  });

  it("requires a self-consistent confirmed terminal record and preserves provider failure", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "terminal-error", now: 1_000 }));
    const lease = admission.admitNext(1_001, "connector-a")!;
    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);
    admission.markActive(lease, 1_004);

    const mismatched = { ...terminalObservations("ERROR"), outcome: "completed" as const };
    expect(() => admission.markProviderTerminal(lease, 1_005, mismatched, delivery("terminal-error", { now: 1_005 }))).toThrow(
      /inconsistent/
    );
    expect(admission.getRequest("terminal-error")?.state).toBe("active");

    const capacity: ConfirmedProviderTerminal = {
      ...terminalObservations("ERROR"),
      failure: {
        category: "provider_capacity",
        httpStatus: 503,
        code: "UNAVAILABLE",
        reason: undefined
      }
    };
    admission.markProviderTerminal(lease, 1_006, capacity, delivery("terminal-error", { now: 1_006 }));

    const raw = new Database(admission.databasePath, { readonly: true });
    expect(
      raw.prepare(
        `SELECT terminal_status, terminal_failure_category, terminal_http_status, terminal_code
         FROM leases WHERE lease_id = ?`
      ).get(lease.leaseId)
    ).toEqual({
      terminal_status: "ERROR",
      terminal_failure_category: "provider_capacity",
      terminal_http_status: 503,
      terminal_code: "UNAVAILABLE"
    });
    raw.close();

    admission.release(lease, 1_007);
    expect(admission.getRequest("terminal-error")?.state).toBe("failed");
  });

  it("keeps owner recovery fenced until a signed pre-dispatch resolution is accepted", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "safe-retry" }));
    const lease = admission.admitNext(1_001, "connector-a")!;

    admission.markStarting(lease, 1_002);
    expect(() => admission.recoverOwner(lease.leaseId, 1_003, { ownerAlive: false } as unknown as string)).toThrow(
      /recovery claimant/
    );
    const claim = admission.recoverOwner(lease.leaseId, 1_004, "recovery-a");
    expect(claim).toMatchObject({
      requestId: "safe-retry",
      leaseId: lease.leaseId,
      leaseGeneration: lease.generation,
      recoveryGeneration: 1,
      claimantInstanceId: "recovery-a"
    });
    expect(admission.getRequest("safe-retry")?.state).toBe("recovery_required");

    const unsigned = {
      claim,
      action: "confirmed_not_dispatched_requeue" as const,
      evidenceCode: "pre_dispatch_residue_empty" as const,
      reasonCode: "owner_lost" as const,
      actorHmac: "0".repeat(64),
      evidenceHmac: "0".repeat(64)
    };
    expect(admission.resolveRecovery(unsigned, 1_005)).toEqual({
      accepted: false,
      nextState: "recovery_required",
      rejectionCode: "evidence_mismatch"
    });
    expect(
      admission.resolveRecovery(
        { ...unsigned, claim: { ...claim, recoveryGeneration: claim.recoveryGeneration + 1 } },
        1_005
      )
    ).toEqual({ accepted: false, nextState: "recovery_required", rejectionCode: "claim_mismatch" });
    expect(admission.getRequest("safe-retry")?.state).toBe("recovery_required");

    const attestations = admission.createRecoveryResolutionAttestations(
      claim,
      "confirmed_not_dispatched_requeue",
      "pre_dispatch_residue_empty",
      "owner_lost"
    );
    expect(admission.resolveRecovery({ ...unsigned, ...attestations }, 1_006)).toMatchObject({
      accepted: true,
      nextState: "queued"
    });
    expect(admission.getRequest("safe-retry")?.state).toBe("queued");
    const retried = admission.admitNext(1_007, "connector-b")!;
    expect(retried.requestId).toBe("safe-retry");
    expect(retried.generation).toBe(2);
  });

  it("commits a confirmed recovery terminal outcome with its encrypted outbox event", () => {
    const admission = controller({}, Buffer.alloc(32, 6));
    enqueueReady(admission, request({ requestId: "recovery-terminal", now: 1_000 }));
    const lease = admission.admitNext(1_001, "connector-a")!;
    admission.markStarting(lease, 1_002);
    admission.markDispatchIntent(lease, 1_003);
    const claim = admission.recoverOwner(lease.leaseId, 1_004, "recovery-a");
    const attestations = admission.createRecoveryResolutionAttestations(
      claim,
      "confirmed_completed",
      "provider_completed",
      "provider_terminal_unproven"
    );
    const resolution = {
      claim,
      action: "confirmed_completed" as const,
      evidenceCode: "provider_completed" as const,
      reasonCode: "provider_terminal_unproven" as const,
      ...attestations
    };

    expect(admission.resolveRecovery(resolution, 1_005)).toEqual({
      accepted: false,
      nextState: "recovery_required",
      rejectionCode: "evidence_mismatch"
    });
    expect(admission.getRequest("recovery-terminal")?.state).toBe("recovery_required");

    expect(
      admission.resolveRecovery(
        resolution,
        1_006,
        delivery("recovery-terminal", { eventId: "recovery-terminal-event", now: 1_006, payload: "recovered answer" })
      )
    ).toMatchObject({ accepted: true, nextState: "completed" });
    expect(admission.getRequest("recovery-terminal")?.state).toBe("completed");
    const raw = new Database(admission.databasePath, { readonly: true });
    expect(
      raw
        .prepare("SELECT state, lease_id, lease_generation FROM delivery_outbox WHERE event_id = 'recovery-terminal-event'")
        .get()
    ).toEqual({ state: "pending", lease_id: lease.leaseId, lease_generation: lease.generation });
    raw.close();
  });

  it("does not requeue a starting request until its pre-dispatch process is proven terminated", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "residue", now: 1_000 }));
    const lease = admission.admitNext(1_001, "connector-a")!;
    admission.markStarting(lease, 1_002);

    admission.recoverOwner(lease.leaseId, 1_003, "recovery-a");
    expect(admission.getRequest("residue")?.state).toBe("recovery_required");
    expect(admission.admitNext(1_004, "connector-b")).toBeNull();
  });

  it("does not automatically requeue an admitted reservation after owner loss", () => {
    const admission = controller();
    enqueueReady(admission, request({ requestId: "reservation", now: 1_000 }));
    const lease = admission.admitNext(1_001, "connector-a")!;

    admission.recoverOwner(lease.leaseId, 1_002, "recovery-a");
    expect(admission.getRequest("reservation")?.state).toBe("recovery_required");
    expect(admission.admitNext(1_003, "connector-b")).toBeNull();
  });

  it("globally spaces admission reservations before they consume concurrent turn capacity", () => {
    const admission = controller({ maxActiveTurns: 2, maxConcurrentStarts: 2, minStartIntervalMs: 100 });
    enqueueReady(admission, request({ requestId: "first", now: 1_000 }));
    enqueueReady(admission, request({ requestId: "second", sessionId: "session-b", parentId: "parent-b", now: 1_001 }));
    const first = admission.admitNext(1_002, "connector-a")!;
    admission.markStarting(first, 1_010);
    expect(admission.admitNext(1_109, "connector-b")).toBeNull();
    expect(admission.getRequest("second")?.state).toBe("queued");
    const second = admission.admitNext(1_110, "connector-b")!;
    admission.markStarting(second, 1_110);
  });

  it("encrypts durable payloads and refuses an expired payload", () => {
    const secret = "the prompt must not be readable from sqlite";
    const admission = controller({}, Buffer.alloc(32, 7));
    const stored = request({ requestId: "payload", now: 1_000 });
    admission.enqueue(stored);

    admission.persistPayload("payload", secret, 1_001, 2_000);
    expect(admission.readPayload("payload", 1_002)).toBe(secret);
    expect(readFileSync(admission.databasePath, "utf8")).not.toContain(secret);
    const walPath = `${admission.databasePath}-wal`;
    if (existsSync(walPath)) expect(readFileSync(walPath, "utf8")).not.toContain(secret);
    expect(() => admission.readPayload("payload", 2_000)).toThrow(/expired/);
    expect(() => admission.readPayload("payload", 2_001)).toThrow(/no payload/);
  });

  it("binds encrypted payloads to their request row with authenticated data", () => {
    const admission = controller({}, Buffer.alloc(32, 7));
    admission.enqueueWithPayload(request({ requestId: "payload-a", now: 1_000 }), "prompt-a", 2_000);
    admission.enqueueWithPayload(request({ requestId: "payload-b", now: 1_001 }), "prompt-b", 2_000);

    const raw = new Database(admission.databasePath);
    const a = raw
      .prepare("SELECT nonce, ciphertext, auth_tag FROM turn_payloads WHERE request_id = 'payload-a'")
      .get() as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
    const b = raw
      .prepare("SELECT nonce, ciphertext, auth_tag FROM turn_payloads WHERE request_id = 'payload-b'")
      .get() as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
    raw.prepare("UPDATE turn_payloads SET nonce = ?, ciphertext = ?, auth_tag = ? WHERE request_id = 'payload-a'")
      .run(b.nonce, b.ciphertext, b.auth_tag);
    raw.prepare("UPDATE turn_payloads SET nonce = ?, ciphertext = ?, auth_tag = ? WHERE request_id = 'payload-b'")
      .run(a.nonce, a.ciphertext, a.auth_tag);
    raw.close();

    expect(() => admission.readPayload("payload-a", 1_002)).toThrow();
    expect(() => admission.readPayload("payload-b", 1_002)).toThrow();
  });

  it("requires a negotiated, generation-fenced single consumer before delivery acknowledgement", () => {
    const secret = "the terminal answer must not be readable from sqlite";
    const admission = controller({}, Buffer.alloc(32, 9));
    admission.enqueue(request({ requestId: "delivery-request", now: 1_000 }));
    const event = delivery("delivery-request", {
      eventId: "event-1",
      fingerprint: "hmac-derived-event-fingerprint",
      payload: secret,
      now: 1_001,
      expiresAt: 2_000,
      sequence: 7
    });

    expect(admission.enqueueDelivery(event)).toEqual({ eventId: "event-1", existed: false });
    expect(admission.enqueueDelivery(event)).toEqual({ eventId: "event-1", existed: true });
    const claim = admission.claimPendingDelivery("event-1", "delivery-worker-a", 1_002)!;
    expect(claim).toMatchObject({
      eventId: "event-1",
      requestId: "delivery-request",
      sessionId: "session-a",
      payload: secret,
      ownerInstanceId: "delivery-worker-a",
      claimGeneration: 1,
      metadata: {
        v: 1,
        eventId: "event-1",
        sequence: 7,
        claimGeneration: 1
      }
    });
    expect(admission.claimPendingDelivery("event-1", "delivery-worker-b", 1_002)).toBeNull();
    expect(readFileSync(admission.databasePath, "utf8")).not.toContain(secret);
    expect(() => admission.enqueueDelivery({ ...event, fingerprint: "different" })).toThrow(DeliveryConflictError);
    expect(() => admission.enqueueDelivery({ ...event, requestId: "different-request" })).toThrow(DeliveryConflictError);
    expect(() => admission.acknowledgeDelivery({ ...acknowledgement(claim), claimToken: "0".repeat(64) }, 1_003)).toThrow(
      DeliveryClaimFenceError
    );
    expect(() => admission.acknowledgeDelivery({ ...acknowledgement(claim), sessionId: "other-session" }, 1_003)).toThrow(
      DeliveryClaimFenceError
    );

    admission.acknowledgeDelivery(acknowledgement(claim), 1_004);
    expect(() => admission.acknowledgeDelivery(acknowledgement(claim), 1_005)).not.toThrow();
    expect(admission.claimPendingDelivery("event-1", "delivery-worker-b", 1_006)).toBeNull();
    expect(admission.enqueueDelivery(event)).toEqual({ eventId: "event-1", existed: true });

    expect(() =>
      admission.enqueueDelivery({
        ...event,
        eventId: "event-unnegotiated",
        protocol: { version: 1, semantics: "exactly-once" }
      } as unknown as EnqueueDelivery)
    ).toThrow(/negotiated at-least-once/i);
  });

  it("atomically persists enumerable delivery claim leases and settles exact ACK state", () => {
    const admission = controller();
    const input = request({ requestId: "atomic-delivery-claim", now: 1_000 });
    const event = delivery(input.requestId, { eventId: "atomic-delivery-claim-event", now: 1_001, expiresAt: 2_000 });
    admission.enqueue(input);
    admission.enqueueDelivery(event);

    const claim = admission.claimPendingDeliveryAtomically({
      eventId: event.eventId,
      ownerInstanceId: "delivery-worker-a",
      now: 1_002,
      leaseMs: 20
    })!;
    const claimed = new Database(admission.databasePath, { readonly: true });
    expect(
      claimed
        .prepare(
          `SELECT event_id, request_id, owner_instance_id, claim_generation, state,
                  heartbeat_at, lease_expires_at
           FROM delivery_claim_leases WHERE event_id = ?`
        )
        .get(event.eventId)
    ).toEqual({
      event_id: event.eventId,
      request_id: input.requestId,
      owner_instance_id: "delivery-worker-a",
      claim_generation: 1,
      state: "claimed",
      heartbeat_at: 1_002,
      lease_expires_at: 1_022
    });
    claimed.close();

    expect(admission.heartbeatClaimedDelivery(claim, 1_005, 20)).toMatchObject({
      eventId: event.eventId,
      ownerInstanceId: "delivery-worker-a",
      claimGeneration: 1,
      heartbeatAt: 1_005,
      leaseExpiresAt: 1_025
    });
    expect(() => admission.heartbeatClaimedDelivery({ ...claim, claimGeneration: 2 }, 1_006, 20)).toThrow(
      DeliveryClaimFenceError
    );

    admission.acknowledgeDelivery(acknowledgement(claim), 1_009);
    const delivered = new Database(admission.databasePath, { readonly: true });
    expect(delivered.prepare("SELECT state, nonce, ciphertext, auth_tag FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "delivered",
      nonce: null,
      ciphertext: null,
      auth_tag: null
    });
    expect(
      delivered
        .prepare("SELECT state, settled_at FROM delivery_claim_leases WHERE event_id = ?")
        .get(event.eventId)
    ).toEqual({ state: "delivered", settled_at: 1_009 });
    delivered.close();
  });

  it("rolls back the ACK settlement midpoint test fault without exposing callback data", () => {
    const privatePayload = "ack-fault-payload-must-not-leak";
    let hookCalls = 0;
    const admission = controller({}, {}, {
      afterDeliveryOutboxSettled() {
        hookCalls += 1;
        if (hookCalls === 1) throw new Error(privatePayload);
      }
    });
    const input = request({ requestId: "ack-midpoint-fault", now: 1_000 });
    const event = delivery(input.requestId, {
      eventId: "ack-midpoint-fault-event",
      now: 1_001,
      expiresAt: 2_000,
      payload: privatePayload
    });
    admission.enqueue(input);
    admission.enqueueDelivery(event);
    const claim = admission.claimPendingDeliveryAtomically({
      eventId: event.eventId,
      ownerInstanceId: "delivery-worker-a",
      now: 1_002,
      leaseMs: 100
    })!;
    const beforeEvents = admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 });

    let failure = "";
    try {
      admission.acknowledgeDelivery(acknowledgement(claim), 1_003);
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    expect(failure).toBe("AdmissionControllerInjectedFaultError: admission transaction fault injection");
    expect(failure).not.toContain(privatePayload);
    expect(hookCalls).toBe(1);
    expect(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 })).toEqual(beforeEvents);
    expect(admission.listRecoverableOutboxClaims()).toEqual([
      expect.objectContaining({ eventId: event.eventId, state: "claimed" })
    ]);
    const rolledBack = new Database(admission.databasePath, { readonly: true });
    expect(rolledBack.prepare("SELECT state, settled_at FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "claimed",
      settled_at: null
    });
    expect(
      rolledBack.prepare("SELECT state, settled_at FROM delivery_claim_leases WHERE event_id = ?").get(event.eventId)
    ).toEqual({ state: "claimed", settled_at: null });
    rolledBack.close();

    admission.acknowledgeDelivery(acknowledgement(claim), 1_003);
    expect(hookCalls).toBe(2);
    const retried = new Database(admission.databasePath, { readonly: true });
    expect(retried.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "delivered"
    });
    expect(retried.prepare("SELECT state FROM delivery_claim_leases WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "delivered"
    });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'delivery_delivered'").get()).toEqual({ count: 1 });
    retried.close();
  });

  it("enumerates every non-delivered outbox claim without reading payload material", () => {
    const admission = controller();
    const states = ["claimed", "recovery", "delivered"] as const;
    const claims = new Map<string, ReturnType<AdmissionController["claimPendingDeliveryAtomically"]>>();
    for (const [index, name] of states.entries()) {
      const input = request({
        requestId: `inventory-${name}-request`,
        sessionId: `inventory-${name}-session`,
        parentId: `inventory-${name}-parent`,
        now: 1_000 + index
      });
      const event = delivery(input.requestId, {
        eventId: `inventory-${name}-event`,
        payload: `private-${name}-payload`,
        now: 1_010 + index,
        expiresAt: 3_000
      });
      admission.enqueue(input);
      admission.enqueueDelivery(event);
      claims.set(name, admission.claimPendingDeliveryAtomically({
        eventId: event.eventId,
        ownerInstanceId: `inventory-${name}-owner`,
        now: 1_020 + index,
        leaseMs: 100
      }));
    }

    admission.markDeliveryRecoveryRequired(claims.get("recovery")!, 1_031);
    admission.acknowledgeDelivery(acknowledgement(claims.get("delivered")!), 1_032);

    const inventory = admission.listRecoverableOutboxClaims();
    expect(inventory.map((claim) => [claim.eventId, claim.state])).toEqual([
      ["inventory-claimed-event", "claimed"],
      ["inventory-recovery-event", "recovery_required"]
    ]);
    expect(JSON.stringify(inventory)).not.toContain("private-");
    for (const claim of inventory) {
      expect(claim).not.toHaveProperty("payload");
      expect(claim).not.toHaveProperty("claimToken");
      expect(claim).not.toHaveProperty("sessionId");
    }
  });

  it("fails the complete outbox claim inventory closed on partial or mismatched fences", () => {
    const corruptions = [
      "missing-lease",
      "orphan-lease",
      "owner-mismatch",
      "generation-mismatch",
      "state-mismatch"
    ] as const;

    for (const corruption of corruptions) {
      const admission = controller();
      const input = request({ requestId: `${corruption}-request`, now: 1_000 });
      const event = delivery(input.requestId, {
        eventId: `${corruption}-event`,
        now: 1_001,
        expiresAt: 2_000
      });
      admission.enqueue(input);
      admission.enqueueDelivery(event);
      admission.claimPendingDeliveryAtomically({
        eventId: event.eventId,
        ownerInstanceId: "inventory-worker",
        now: 1_002,
        leaseMs: 100
      });

      const database = new Database(admission.databasePath);
      if (corruption === "missing-lease") {
        database.prepare("DELETE FROM delivery_claim_leases WHERE event_id = ?").run(event.eventId);
      } else if (corruption === "orphan-lease") {
        database.pragma("foreign_keys = OFF");
        database.prepare("DELETE FROM delivery_outbox WHERE event_id = ?").run(event.eventId);
      } else if (corruption === "owner-mismatch") {
        database.prepare("UPDATE delivery_claim_leases SET owner_instance_id = 'other-worker' WHERE event_id = ?").run(event.eventId);
      } else if (corruption === "generation-mismatch") {
        database.prepare("UPDATE delivery_claim_leases SET claim_generation = 2 WHERE event_id = ?").run(event.eventId);
      } else {
        database.prepare("UPDATE delivery_claim_leases SET state = 'delivered' WHERE event_id = ?").run(event.eventId);
      }
      database.close();

      expect(() => admission.listRecoverableOutboxClaims()).toThrow(RecoverableOutboxClaimInventoryError);
    }
  });

  it("sweeps expired and legacy claimed deliveries to recovery without returning payloads", () => {
    const admission = controller();
    const atomicRequest = request({ requestId: "atomic-sweep-request", now: 1_000 });
    const legacyRequest = request({ requestId: "legacy-sweep-request", sessionId: "session-b", parentId: "parent-b", now: 1_001 });
    const atomicEvent = delivery(atomicRequest.requestId, { eventId: "atomic-sweep-event", now: 1_001, expiresAt: 2_000 });
    const legacyEvent = delivery(legacyRequest.requestId, { eventId: "legacy-sweep-event", now: 1_002, expiresAt: 2_000 });
    admission.enqueue(atomicRequest);
    admission.enqueue(legacyRequest);
    admission.enqueueDelivery(atomicEvent);
    admission.enqueueDelivery(legacyEvent);
    const atomicClaim = admission.claimPendingDeliveryAtomically({
      eventId: atomicEvent.eventId,
      ownerInstanceId: "delivery-worker-a",
      now: 1_003,
      leaseMs: 10
    })!;

    const legacy = new Database(admission.databasePath);
    legacy
      .prepare(
        `UPDATE delivery_outbox
         SET state = 'claimed', claim_generation = 7, claim_owner_instance_id = ?, claim_acquired_at = ?
         WHERE event_id = ?`
      )
      .run("legacy-worker", 1_004, legacyEvent.eventId);
    legacy.close();

    const swept = admission.sweepExpiredDeliveryClaims(1_013);
    expect(swept.map((record) => record.eventId)).toEqual([atomicEvent.eventId, legacyEvent.eventId]);
    for (const record of swept) expect(record).not.toHaveProperty("payload");
    const recovered = new Database(admission.databasePath, { readonly: true });
    expect(
      recovered
        .prepare(
          `SELECT event_id, state, nonce, ciphertext, auth_tag
           FROM delivery_outbox WHERE event_id IN (?, ?) ORDER BY event_id ASC`
        )
        .all(atomicEvent.eventId, legacyEvent.eventId)
    ).toEqual([
      { event_id: atomicEvent.eventId, state: "recovery_required", nonce: null, ciphertext: null, auth_tag: null },
      { event_id: legacyEvent.eventId, state: "recovery_required", nonce: null, ciphertext: null, auth_tag: null }
    ]);
    expect(recovered.prepare("SELECT state FROM delivery_claim_leases WHERE event_id = ?").get(atomicEvent.eventId)).toEqual({
      state: "recovery_required"
    });
    expect(recovered.prepare("SELECT state FROM delivery_claim_leases WHERE event_id = ?").get(legacyEvent.eventId)).toBeUndefined();
    recovered.close();
  });

  it("settles an expired exact delivery heartbeat to recovery before rejecting it", () => {
    const admission = controller();
    const input = request({ requestId: "expired-heartbeat-request", now: 1_000 });
    const event = delivery(input.requestId, { eventId: "expired-heartbeat-event", now: 1_001, expiresAt: 2_000 });
    admission.enqueue(input);
    admission.enqueueDelivery(event);
    const claim = admission.claimPendingDeliveryAtomically({
      eventId: event.eventId,
      ownerInstanceId: "delivery-worker-a",
      now: 1_002,
      leaseMs: 5
    })!;

    expect(() => admission.heartbeatClaimedDelivery(claim, 1_007, 5)).toThrow(DeliveryClaimFenceError);
    const recovered = new Database(admission.databasePath, { readonly: true });
    expect(recovered.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "recovery_required"
    });
    expect(recovered.prepare("SELECT state FROM delivery_claim_leases WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "recovery_required"
    });
    recovered.close();
  });

  it("sweeps a non-expired claim whose controller lease no longer matches its outbox fence", () => {
    const admission = controller();
    const input = request({ requestId: "mismatched-lease-request", now: 1_000 });
    const event = delivery(input.requestId, { eventId: "mismatched-lease-event", now: 1_001, expiresAt: 2_000 });
    admission.enqueue(input);
    admission.enqueueDelivery(event);
    admission.claimPendingDeliveryAtomically({
      eventId: event.eventId,
      ownerInstanceId: "delivery-worker-a",
      now: 1_002,
      leaseMs: 100
    });

    const corrupted = new Database(admission.databasePath);
    corrupted.prepare("UPDATE delivery_claim_leases SET claim_generation = 2 WHERE event_id = ?").run(event.eventId);
    corrupted.close();

    expect(admission.sweepExpiredDeliveryClaims(1_003)).toEqual([
      expect.objectContaining({ eventId: event.eventId, reason: "invalid_lease" })
    ]);
    const recovered = new Database(admission.databasePath, { readonly: true });
    expect(recovered.prepare("SELECT state, nonce, ciphertext, auth_tag FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "recovery_required",
      nonce: null,
      ciphertext: null,
      auth_tag: null
    });
    expect(recovered.prepare("SELECT state FROM delivery_claim_leases WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "recovery_required"
    });
    recovered.close();
  });

  it("enumerates and sweeps a controller claim after its claimant process crashes", () => {
    const first = controller();
    const input = request({ requestId: "crashed-claim-request", now: 1_000 });
    const event = delivery(input.requestId, { eventId: "crashed-claim-event", now: 1_001, expiresAt: 3_000 });
    first.enqueue(input);
    first.enqueueDelivery(event);
    const { databasePath, policy } = first;
    first.close();

    const child = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), "tests/helpers/admission-controller-child.mjs"), "claim-and-crash", databasePath, event.eventId],
      { encoding: "utf8" }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");

    const restarted = reopenController(databasePath, policy);
    const claimed = new Database(databasePath, { readonly: true });
    expect(
      claimed
        .prepare("SELECT owner_instance_id, claim_generation, heartbeat_at, lease_expires_at FROM delivery_claim_leases WHERE event_id = ?")
        .get(event.eventId)
    ).toEqual({ owner_instance_id: "crashed-worker", claim_generation: 1, heartbeat_at: 2_000, lease_expires_at: 2_010 });
    claimed.close();

    const swept = restarted.sweepExpiredDeliveryClaims(2_010);
    expect(swept.map((record) => record.eventId)).toEqual([event.eventId]);
    expect(swept[0]).not.toHaveProperty("payload");
    const recovered = new Database(databasePath, { readonly: true });
    expect(recovered.prepare("SELECT state, nonce, ciphertext, auth_tag FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "recovery_required",
      nonce: null,
      ciphertext: null,
      auth_tag: null
    });
    recovered.close();
    restarted.close();
  });

  it("does not expose terminal replay after an ACK claimant process crashes", () => {
    const first = controller();
    const input = request({ requestId: "ack-crash-request", now: 1_000 });
    const event = delivery(input.requestId, { eventId: "ack-crash-event", now: 1_001, expiresAt: 3_000 });
    first.enqueue(input);
    first.enqueueDelivery(event);
    const { databasePath, policy } = first;
    first.close();

    const child = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), "tests/helpers/admission-controller-child.mjs"), "ack-and-crash", databasePath, event.eventId],
      { encoding: "utf8" }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");

    const restarted = reopenController(databasePath, policy);
    expect(restarted.sweepExpiredDeliveryClaims(2_002)).toEqual([]);
    const durable = new Database(databasePath, { readonly: true });
    expect(durable.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get(event.eventId)).toEqual({ state: "delivered" });
    expect(durable.prepare("SELECT state FROM delivery_claim_leases WHERE event_id = ?").get(event.eventId)).toEqual({
      state: "delivered"
    });
    durable.close();
    restarted.close();
  });

  it("accepts only an exact durable delivery ACK across controller restarts", () => {
    const first = controller({}, Buffer.alloc(32, 9));
    first.enqueue(request({ requestId: "delivery-reconnect", now: 1_000 }));
    first.enqueueDelivery(
      delivery("delivery-reconnect", {
        eventId: "delivery-reconnect-event",
        fingerprint: "delivery-reconnect-fingerprint",
        payload: "private terminal update",
        now: 1_001,
        expiresAt: 2_000,
        sequence: 7
      })
    );
    const claim = first.claimPendingDelivery("delivery-reconnect-event", "delivery-worker-a", 1_002)!;
    const exactAcknowledgement = acknowledgement(claim);
    const { databasePath, policy } = first;
    first.close();

    const afterClaimRestart = new AdmissionController({
      databasePath,
      policy,
      encryptionKey: Buffer.alloc(32, 9),
      contentFingerprintKey: Buffer.alloc(32, 2),
      claimTokenKey: Buffer.alloc(32, 3)
    });
    for (const conflictingAcknowledgement of [
      { ...exactAcknowledgement, sessionId: "other-session" },
      { ...exactAcknowledgement, claimGeneration: exactAcknowledgement.claimGeneration + 1 },
      { ...exactAcknowledgement, claimToken: "0".repeat(64) }
    ]) {
      expect(() => afterClaimRestart.acknowledgeDelivery(conflictingAcknowledgement, 1_003)).toThrow(
        DeliveryClaimFenceError
      );
    }
    expect(() => afterClaimRestart.acknowledgeDelivery(exactAcknowledgement, 1_004)).not.toThrow();
    afterClaimRestart.close();

    const afterDeliveryRestart = new AdmissionController({
      databasePath,
      policy,
      encryptionKey: Buffer.alloc(32, 9),
      contentFingerprintKey: Buffer.alloc(32, 2),
      claimTokenKey: Buffer.alloc(32, 3)
    });
    expect(() => afterDeliveryRestart.acknowledgeDelivery(exactAcknowledgement, 1_005)).not.toThrow();
    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get("delivery-reconnect-event")).toEqual({
      state: "delivered"
    });
    database.close();
    expect(readFileSync(databasePath, "utf8")).not.toContain(exactAcknowledgement.claimToken);
    afterDeliveryRestart.close();
  });

  it("binds encrypted delivery payloads to their outbox event", () => {
    const admission = controller({}, Buffer.alloc(32, 9));
    admission.enqueue(request({ requestId: "delivery-aad", now: 1_000 }));
    admission.enqueueDelivery(
      delivery("delivery-aad", {
        eventId: "event-a",
        fingerprint: "event-a-fingerprint",
        payload: "answer-a",
        now: 1_001
      })
    );
    admission.enqueueDelivery(
      delivery("delivery-aad", {
        eventId: "event-b",
        fingerprint: "event-b-fingerprint",
        payload: "answer-b",
        now: 1_002
      })
    );

    const raw = new Database(admission.databasePath);
    const a = raw
      .prepare("SELECT nonce, ciphertext, auth_tag FROM delivery_outbox WHERE event_id = 'event-a'")
      .get() as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
    const b = raw
      .prepare("SELECT nonce, ciphertext, auth_tag FROM delivery_outbox WHERE event_id = 'event-b'")
      .get() as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
    raw.prepare("UPDATE delivery_outbox SET nonce = ?, ciphertext = ?, auth_tag = ? WHERE event_id = 'event-a'")
      .run(b.nonce, b.ciphertext, b.auth_tag);
    raw.prepare("UPDATE delivery_outbox SET nonce = ?, ciphertext = ?, auth_tag = ? WHERE event_id = 'event-b'")
      .run(a.nonce, a.ciphertext, a.auth_tag);
    raw.close();

    expect(() => admission.claimPendingDelivery("event-a", "delivery-worker-a", 1_003)).toThrow();
    expect(() => admission.claimPendingDelivery("event-b", "delivery-worker-b", 1_003)).toThrow();
  });
});
