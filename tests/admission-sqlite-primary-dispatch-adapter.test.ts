import { describe, expect, it, vi } from "vitest";
import { AdmissionSessionScopeResolver } from "../src/agy/acp/session/admission-scope-resolver.js";
import type {
  ActiveConnectorIdentity,
  ActiveSessionFence,
  ActiveSessionRegistration
} from "../src/agy/acp/session/active-registry.js";
import type { ActiveSessionTurnRegistry } from "../src/agy/acp/session/active-turn-binding.js";
import type { SessionState } from "../src/agy/acp/session/types.js";
import type {
  AgyExactConversationTurn,
  AgyExactConversationTurnOptions
} from "../src/agy/cli.js";
import { createSqliteProviderObserver } from "../src/agy/db/provider-observer.js";
import type {
  ExactConversationBinding
} from "../src/agy/db/exact-conversation-binder.js";
import type {
  AgyDispatchFence
} from "../src/agy/dispatch-boundary.js";
import type { AgyPromptFreeProcessWriteResult } from "../src/agy/prompt-free-process.js";
import {
  createSqlitePrimaryDispatchAdapter,
  SqlitePrimaryDispatchAdapterError,
  type SqlitePrimaryDispatchAdapter,
  type SqlitePrimaryRequestMetadata,
  type SqlitePrimaryTerminalDeliveryInput
} from "../src/admission/sqlite-primary-dispatch-adapter.js";
import type {
  AdmissionPromptAgyContract,
  AdmissionPromptAgySpawnContext,
  AdmissionPromptDispatchController,
  AdmissionPromptProviderContext,
  AdmissionPromptProviderObserver
} from "../src/admission/dispatcher.js";
import { AdmissionPromptDispatcher } from "../src/admission/dispatcher.js";
import type { AdmissionPromptDispatchInput } from "../src/admission/prompt-seam.js";
import { ACP_OUTBOX_CAPABILITY } from "../src/admission/outbox-protocol.js";

const AGENT_ID = "agent-1";
const REQUEST_ID = "request-1";
const SESSION_ID = "session-1";
const PARENT_ID = "parent-1";
const MODEL = "claude-opus-4-6-thinking";
const CONVERSATION_ID = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
const OTHER_CONVERSATION_ID = "055a398f-db14-4c5f-abbb-1bf03f8120a7";
const OWNER_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PROMPT = "private business prompt with Authorization: Bearer secret-token";

interface ProcessIdentity {
  readonly pid: number;
}

interface SnapshotSpec {
  readonly cursor: number;
  readonly kind: "activity" | "terminal";
  readonly status: "ACTIVE" | "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED";
  readonly backgroundTasks?: "settled" | "active";
}

interface RigOptions {
  readonly metadata?: unknown;
  readonly snapshots?: readonly SnapshotSpec[];
  readonly initialConversationId?: string | null;
  readonly initialCursor?: number;
  readonly bindingConversationId?: string;
  readonly bindingCursor?: number;
  readonly rejectBinding?: boolean;
  readonly terminalOverride?: ExactConversationBinding["observer"]["observeTerminal"];
  readonly payload?: unknown;
}

interface Rig {
  readonly adapter: SqlitePrimaryDispatchAdapter<ProcessIdentity>;
  readonly agy: FakeAgy;
  readonly events: string[];
  readonly registry: FakeActiveRegistry;
  readonly deliveryInputs: SqlitePrimaryTerminalDeliveryInput[];
  readonly metadataRead: ReturnType<typeof vi.fn>;
  readonly payloadRead: ReturnType<typeof vi.fn>;
}

class FakeAgy {
  conversationId: string | null;
  lastStepIdx: number;
  readonly events: string[];
  readonly bindingConversationId: string;
  readonly bindingCursor: number;
  readonly rejectBinding: boolean;
  readonly terminalOverride: ExactConversationBinding["observer"]["observeTerminal"] | undefined;
  readonly starts: AgyExactConversationTurnOptions[] = [];
  readonly prompts: string[] = [];
  readonly turns: FakeTurn[] = [];

  constructor(events: string[], options: RigOptions) {
    this.events = events;
    this.conversationId = options.initialConversationId ?? null;
    this.lastStepIdx = options.initialCursor ?? -1;
    this.bindingConversationId = options.bindingConversationId ?? CONVERSATION_ID;
    this.bindingCursor = options.bindingCursor ?? 1;
    this.rejectBinding = options.rejectBinding ?? false;
    this.terminalOverride = options.terminalOverride;
  }

  startExactConversationTurn(
    prompt: string,
    options: AgyExactConversationTurnOptions
  ): AgyExactConversationTurn {
    this.events.push("agy:start");
    this.prompts.push(prompt);
    this.starts.push(options);
    const observer = createSqliteProviderObserver({
      reader: options.reader!,
      now: () => 1_725_000_000_000
    }).bind(this.bindingConversationId);
    const binding: ExactConversationBinding = Object.freeze({
      conversationId: this.bindingConversationId,
      cursor: this.bindingCursor,
      observer: this.terminalOverride === undefined
        ? observer
        : Object.freeze({
          observeActivity: () => observer.observeActivity(),
          observeTerminal: this.terminalOverride
        }),
      streamCompletion: Promise.resolve(Object.freeze({
        status: "drained" as const,
        conversationId: this.bindingConversationId
      }))
    });
    const turn = new FakeTurn(
      this.events,
      this.rejectBinding
        ? Promise.reject(new Error(`${PROMPT}: provider diagnostics`))
        : Promise.resolve(binding)
    );
    // The production constructor marks its binding rejection observed.
    void turn.binding.catch(() => {});
    this.turns.push(turn);
    return turn;
  }

  restoreConversation(conversationId: string | null, cursor: number): void {
    this.events.push(`agy:restore:${conversationId}:${cursor}`);
    this.conversationId = conversationId;
    this.lastStepIdx = cursor;
  }
}

class FakeTurn implements AgyExactConversationTurn {
  readonly processId = 571;
  readonly promptChannel = "stdin" as const;
  readonly exit = Promise.resolve({ exitCode: 0, signal: null });
  readonly binding: Promise<ExactConversationBinding>;
  readonly #events: string[];
  cancelled = 0;
  writes = 0;

  constructor(events: string[], binding: Promise<ExactConversationBinding>) {
    this.#events = events;
    this.binding = binding;
  }

  writeBusinessPrompt(): AgyPromptFreeProcessWriteResult {
    this.#events.push("agy:write");
    this.writes += 1;
    return Object.freeze({ status: "accepted" as const });
  }

  cancel(): void {
    this.#events.push("agy:cancel");
    this.cancelled += 1;
  }
}

class FakeActiveRegistry implements ActiveSessionTurnRegistry {
  readonly events: string[];
  readonly registrations: ActiveSessionRegistration[] = [];
  readonly advances: unknown[] = [];
  readonly terminals: unknown[] = [];

  constructor(events: string[]) {
    this.events = events;
  }

  register(input: unknown): ActiveSessionFence {
    const registration = input as ActiveSessionRegistration;
    this.events.push(`registry:register:${registration.cursor}`);
    this.registrations.push(registration);
    return Object.freeze({
      requestId: registration.requestId,
      ownerInstanceId: registration.connectorIdentity.ownerInstanceId,
      leaseGeneration: 1
    });
  }

  advance(_fence: unknown, update: unknown): void {
    const cursor = (update as { cursor: number }).cursor;
    this.events.push(`registry:advance:${cursor}`);
    this.advances.push(update);
  }

  markTerminal(_fence: unknown, terminal: unknown): void {
    this.events.push(`registry:terminal:${String(terminal)}`);
    this.terminals.push(terminal);
  }

  archiveTerminal(): boolean {
    this.events.push("registry:archive");
    return true;
  }
}

function metadata(overrides: Partial<SqlitePrimaryRequestMetadata> = {}): SqlitePrimaryRequestMetadata {
  return {
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    parentId: PARENT_ID,
    provider: "antigravity",
    model: MODEL,
    ...overrides
  };
}

function connectorIdentity(): ActiveConnectorIdentity {
  return {
    ownerInstanceId: OWNER_INSTANCE_ID,
    createdAt: "2026-08-10T12:00:00.000Z",
    bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pid: 4121,
    startTimeTicks: "101",
    pidNamespaceInode: 4_026_531_836,
    ppid: 4000,
    pgrp: 4000,
    session: 4000
  };
}

function fence(overrides: Partial<AgyDispatchFence> = {}): AgyDispatchFence {
  return {
    requestId: REQUEST_ID,
    leaseId: "lease-1",
    generation: 1,
    ownerInstanceId: OWNER_INSTANCE_ID,
    ...overrides
  };
}

function issuedContext(abortController = new AbortController()): {
  readonly context: AdmissionPromptAgySpawnContext;
  readonly abortController: AbortController;
} {
  let issued: AdmissionPromptAgySpawnContext | undefined;
  const controller: AdmissionPromptDispatchController = {
    admitRequest: () => ({ ...fence() }),
    markStarting: () => {},
    readPayload: () => "issuer-only prompt",
    markActive: () => {},
    markDispatchAmbiguous: () => {},
    markProviderTerminal: () => ({ eventId: "issuer-event", existed: false }),
    release: () => {}
  };
  const dispatcher = new AdmissionPromptDispatcher({
    controller,
    ownerInstanceId: OWNER_INSTANCE_ID,
    lifecycle: {
      recordProcessIdentity: () => ({ status: "recorded" }),
      revalidate: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
      commitDispatchIntent: () => ({ status: "committed" })
    },
    agy: {
      spawnPromptFree(context) {
        issued = context;
        return {
          process: Object.freeze({ pid: 999 }),
          identity: Object.freeze({ pid: 999 }),
          promptChannel: "stdin" as const,
          writeInitialPrompt: () => ({ status: "accepted" as const })
        };
      }
    },
    provider: {
      observeProviderActivity: async () => ({ status: "observed" as const }),
      observeTerminal: async () => ({
        observations: {
          mode: "sqlite_primary" as const,
          sqliteReconciliation: {
            source: "sqlite_reconciliation" as const,
            conversationId: "issuer-conversation",
            observedAt: 1,
            status: "SUCCESS" as const
          }
        },
        delivery: {
          eventId: "issuer-event",
          fingerprint: "issuer-fingerprint",
          payload: "issuer-delivery",
          sequence: 1,
          expiresAt: 2,
          protocol: ACP_OUTBOX_CAPABILITY
        }
      })
    },
    recovery: {
      recoverPreDispatch: async () => ({ state: "recovery_required" as const }),
      recordRecoveryRequired: async () => {}
    },
    now: () => 1
  });
  const input = {
    runtime: { controller },
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    parentId: PARENT_ID,
    provider: "antigravity",
    model: MODEL,
    claim: { signal: abortController.signal }
  } as AdmissionPromptDispatchInput;
  void dispatcher.run(input).catch(() => {});
  if (issued === undefined) throw new Error("dispatcher did not issue a spawn context synchronously");
  return Object.freeze({ context: issued, abortController });
}

function context(overrides: Partial<AdmissionPromptProviderContext> = {}): AdmissionPromptProviderContext {
  return {
    ...fence(),
    sessionId: SESSION_ID,
    parentId: PARENT_ID,
    provider: "antigravity",
    model: MODEL,
    ...overrides
  };
}

function rig(options: RigOptions = {}): Rig {
  const events: string[] = [];
  const snapshots = [...(options.snapshots ?? [
    { cursor: 2, kind: "activity", status: "ACTIVE" },
    { cursor: 3, kind: "terminal", status: "SUCCESS" }
  ])];
  const agy = new FakeAgy(events, options);
  const sessions = new AdmissionSessionScopeResolver(new Map([[SESSION_ID, {
    sessionId: SESSION_ID,
    agy
  } as unknown as SessionState]]));
  const registry = new FakeActiveRegistry(events);
  const metadataRead = vi.fn(() => {
    events.push("controller:metadata");
    return options.metadata ?? metadata();
  });
  const payloadRead = vi.fn(() => {
    events.push("controller:payload");
    return Object.hasOwn(options, "payload") ? options.payload : PROMPT;
  });
  const deliveryInputs: SqlitePrimaryTerminalDeliveryInput[] = [];

  const adapter = createSqlitePrimaryDispatchAdapter<ProcessIdentity>({
    agentId: AGENT_ID,
    connectorIdentity: connectorIdentity(),
    requestMetadata: { readRequestMetadata: metadataRead },
    businessPrompts: { readBusinessPrompt: payloadRead as (requestId: string) => string },
    sessions,
    activeSessions: registry,
    sqliteSnapshots: {
      readSnapshot(conversationId) {
        const next = snapshots.shift();
        events.push(`sqlite:read:${next?.cursor ?? "none"}`);
        if (next === undefined) return null;
        return {
          conversationId,
          cursor: next.cursor,
          latest: {
            cursor: next.cursor,
            kind: next.kind,
            status: next.status
          },
          backgroundTasks: next.backgroundTasks ?? "settled"
        };
      }
    },
    captureProcessIdentity(input) {
      events.push(`identity:capture:${input.processId}`);
      return Object.freeze({ pid: input.processId });
    },
    createTerminalDelivery(input) {
      events.push(`delivery:create:${input.cursor}`);
      deliveryInputs.push(input);
      return Object.freeze({
        eventId: "event-1",
        fingerprint: "terminal-fingerprint-1",
        payload: "encrypted terminal event",
        sequence: 3,
        expiresAt: 1_725_000_060_000,
        protocol: ACP_OUTBOX_CAPABILITY
      });
    }
  });

  // Compile-time proof that one request-scoped object supplies both dispatcher facets.
  const _agyContract: AdmissionPromptAgyContract<AgyExactConversationTurn, ProcessIdentity> = adapter;
  const _providerContract: AdmissionPromptProviderObserver = adapter;
  void _agyContract;
  void _providerContract;

  return { adapter, agy, events, registry, deliveryInputs, metadataRead, payloadRead };
}

function expectAdapterError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(SqlitePrimaryDispatchAdapterError);
  expect((error as SqlitePrimaryDispatchAdapterError).code).toBe(code);
  expect(String(error)).not.toContain(PROMPT);
  expect(JSON.stringify(error)).not.toContain(PROMPT);
}

describe("SQLite-primary dispatcher adapter", () => {
  it("keeps spawn prompt-free, binds exact SQLite activity, and advances final cursor before terminal", async () => {
    const current = rig();

    const process = current.adapter.spawnPromptFree(issuedContext().context);

    expect(process.promptChannel).toBe("stdin");
    expect(process.identity).toEqual({ pid: 571 });
    expect(current.agy.prompts).toEqual([PROMPT]);
    expect(current.agy.starts[0]).toMatchObject({
      expectedConversationId: null,
      minimumCursor: 0
    });
    expect(current.agy.turns[0]?.writes).toBe(0);
    expect(current.events).toEqual([
      "controller:metadata",
      "controller:payload",
      "agy:start",
      "identity:capture:571",
      "registry:register:-1"
    ]);

    expect(process.writeInitialPrompt(PROMPT)).toEqual({ status: "accepted" });
    await expect(current.adapter.observeProviderActivity(context())).resolves.toEqual({ status: "observed" });
    const terminal = await current.adapter.observeTerminal(context());

    expect(terminal).toEqual({
      observations: {
        mode: "sqlite_primary",
        sqliteReconciliation: {
          source: "sqlite_reconciliation",
          conversationId: CONVERSATION_ID,
          observedAt: 1_725_000_000_000,
          status: "SUCCESS"
        }
      },
      delivery: {
        eventId: "event-1",
        fingerprint: "terminal-fingerprint-1",
        payload: "encrypted terminal event",
        sequence: 3,
        expiresAt: 1_725_000_060_000,
        protocol: ACP_OUTBOX_CAPABILITY
      }
    });
    expect(current.registry.registrations[0]).toMatchObject({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      conversationId: null,
      cursor: -1
    });
    expect(current.registry.advances).toEqual([
      { conversationId: CONVERSATION_ID, cursor: 1 },
      { conversationId: CONVERSATION_ID, cursor: 2 },
      { conversationId: CONVERSATION_ID, cursor: 3 }
    ]);
    expect(current.registry.terminals).toEqual(["completed"]);
    expect(current.agy.conversationId).toBe(CONVERSATION_ID);
    expect(current.agy.lastStepIdx).toBe(3);
    expect(current.deliveryInputs[0]).toMatchObject({
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      cursor: 3,
      terminal: { status: "SUCCESS", source: "sqlite_reconciliation" }
    });
    expect(current.events.indexOf("registry:advance:3")).toBeLessThan(
      current.events.indexOf("registry:terminal:completed")
    );
    expect(JSON.stringify(current.adapter)).not.toContain(PROMPT);
    expect(JSON.stringify(terminal)).not.toContain(PROMPT);
  });

  it("pins a resumed session to its existing conversation and requires a later SQLite cursor", async () => {
    const current = rig({
      initialConversationId: CONVERSATION_ID,
      initialCursor: 8,
      bindingCursor: 9,
      snapshots: [
        { cursor: 10, kind: "activity", status: "ACTIVE" },
        { cursor: 11, kind: "terminal", status: "CANCELED" }
      ]
    });
    const process = current.adapter.spawnPromptFree(issuedContext().context);

    expect(current.agy.starts[0]).toMatchObject({
      expectedConversationId: CONVERSATION_ID,
      minimumCursor: 9
    });
    expect(process.writeInitialPrompt(PROMPT)).toEqual({ status: "accepted" });
    await current.adapter.observeProviderActivity(context());
    const result = await current.adapter.observeTerminal(context());

    expect(result.observations.sqliteReconciliation.status).toBe("CANCELED");
    expect(current.registry.terminals).toEqual(["cancelled"]);
    expect(current.registry.advances.at(-1)).toEqual({ conversationId: CONVERSATION_ID, cursor: 11 });
  });

  it("rejects payload-free metadata and provider-context mismatches before observing SQLite", async () => {
    const wrongMetadata = rig({ metadata: metadata({ requestId: "other-request" }) });
    expect(() => wrongMetadata.adapter.spawnPromptFree(issuedContext().context)).toThrowError(
      expect.objectContaining({ code: "metadata_mismatch" })
    );
    expect(wrongMetadata.agy.turns).toHaveLength(0);
    expect(wrongMetadata.payloadRead).not.toHaveBeenCalled();

    const current = rig();
    const process = current.adapter.spawnPromptFree(issuedContext().context);
    expect(process.writeInitialPrompt(PROMPT)).toEqual({ status: "accepted" });
    await expect(current.adapter.observeProviderActivity(context({ model: "different-model" })))
      .rejects.toMatchObject({ code: "provider_context_mismatch" });
    expect(current.events.some((event) => event.startsWith("sqlite:read"))).toBe(false);
  });

  it("cancels a mismatched prompt without writing it and never permits a duplicate request replay", () => {
    const current = rig();
    const trusted = issuedContext().context;
    const process = current.adapter.spawnPromptFree(trusted);

    expect(process.writeInitialPrompt("different prompt")).toEqual({ status: "ambiguous" });
    expect(current.agy.turns[0]?.writes).toBe(0);
    expect(current.agy.turns[0]?.cancelled).toBe(1);
    expect(() => current.adapter.spawnPromptFree(trusted)).toThrowError(
      expect.objectContaining({ code: "duplicate_request" })
    );
    expect(current.agy.turns).toHaveLength(1);
  });

  it("accepts only dispatcher-issued spawn contexts", () => {
    const current = rig();
    const forged = Object.freeze({
      ...fence(),
      signal: new AbortController().signal
    }) as AdmissionPromptAgySpawnContext;

    expect(() => current.adapter.spawnPromptFree(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_fence" })
    );
    expect(current.metadataRead).not.toHaveBeenCalled();
    expect(current.agy.turns).toHaveLength(0);
  });

  it("cancels exactly once on abort and accepts only an official SQLite cancelled terminal", async () => {
    const current = rig({
      snapshots: [
        { cursor: 2, kind: "terminal", status: "CANCELED" },
        { cursor: 2, kind: "terminal", status: "CANCELED" }
      ]
    });
    const issued = issuedContext();
    const process = current.adapter.spawnPromptFree(issued.context);

    expect(current.agy.starts[0]?.signal).toBe(issued.abortController.signal);
    expect(process.writeInitialPrompt(PROMPT)).toEqual({ status: "accepted" });
    issued.abortController.abort();
    issued.abortController.abort();
    expect(current.agy.turns[0]?.cancelled).toBe(1);

    await expect(current.adapter.observeProviderActivity(context())).resolves.toEqual({
      status: "terminal_observed"
    });
    const terminal = await current.adapter.observeTerminal(context());
    expect(terminal.observations).toMatchObject({
      mode: "sqlite_primary",
      sqliteReconciliation: { status: "CANCELED" }
    });
    expect(current.registry.terminals).toEqual(["cancelled"]);
    expect(current.agy.turns[0]?.cancelled).toBe(1);

    await expect(current.adapter.observeTerminal(context())).rejects.toMatchObject({
      code: "unknown_request"
    });
    expect(() => current.adapter.spawnPromptFree(issued.context)).toThrowError(
      expect.objectContaining({ code: "duplicate_request" })
    );
    expect(JSON.stringify(current.adapter)).not.toContain(PROMPT);
  });

  it("does not infer cancellation from a local signal when SQLite reports another terminal", async () => {
    const current = rig({
      snapshots: [
        { cursor: 2, kind: "activity", status: "ACTIVE" },
        { cursor: 3, kind: "terminal", status: "SUCCESS" }
      ]
    });
    const issued = issuedContext();
    const process = current.adapter.spawnPromptFree(issued.context);
    process.writeInitialPrompt(PROMPT);
    issued.abortController.abort();

    await current.adapter.observeProviderActivity(context());
    await expect(current.adapter.observeTerminal(context())).rejects.toMatchObject({
      code: "terminal_mismatch"
    });
    expect(current.registry.terminals).toHaveLength(0);
    expect(current.agy.turns[0]?.cancelled).toBe(1);
    await expect(current.adapter.observeTerminal(context())).rejects.toMatchObject({
      code: "unknown_request"
    });
  });

  it("close cancels and detaches every live turn exactly once", () => {
    const current = rig();
    const issued = issuedContext();
    current.adapter.spawnPromptFree(issued.context);

    current.adapter.close();
    current.adapter.close();
    issued.abortController.abort();
    expect(current.agy.turns[0]?.cancelled).toBe(1);
    expect(() => current.adapter.spawnPromptFree(issuedContext().context)).toThrowError(
      expect.objectContaining({ code: "wrong_order" })
    );
    expect(JSON.stringify(current.adapter)).not.toContain(PROMPT);
  });

  it("discards an unrecoverable dispatcher path without retaining a replayable prompt", () => {
    const current = rig();
    const issued = issuedContext();
    current.adapter.spawnPromptFree(issued.context);

    current.adapter.discardPromptFree(issued.context);
    current.adapter.discardPromptFree(issued.context);
    issued.abortController.abort();

    expect(current.agy.turns[0]?.cancelled).toBe(1);
    expect(() => current.adapter.spawnPromptFree(issued.context)).toThrowError(
      expect.objectContaining({ code: "duplicate_request" })
    );
    expect(JSON.stringify(current.adapter)).not.toContain(PROMPT);
  });

  it("fails closed for identity binding, background work, and regressed terminal cursors", async () => {
    const bindingFailure = rig({ rejectBinding: true });
    const failedProcess = bindingFailure.adapter.spawnPromptFree(issuedContext().context);
    expect(failedProcess.writeInitialPrompt(PROMPT)).toEqual({ status: "accepted" });
    await expect(bindingFailure.adapter.observeProviderActivity(context())).rejects.toSatisfy((error: unknown) => {
      expectAdapterError(error, "conversation_binding_failed");
      return true;
    });
    expect(bindingFailure.agy.turns[0]?.cancelled).toBe(1);

    const background = rig({
      snapshots: [
        { cursor: 2, kind: "activity", status: "ACTIVE" },
        { cursor: 3, kind: "terminal", status: "SUCCESS", backgroundTasks: "active" }
      ]
    });
    const backgroundProcess = background.adapter.spawnPromptFree(issuedContext().context);
    backgroundProcess.writeInitialPrompt(PROMPT);
    await background.adapter.observeProviderActivity(context());
    await expect(background.adapter.observeTerminal(context())).rejects.toMatchObject({
      code: "terminal_unobserved"
    });
    expect(background.registry.terminals).toHaveLength(0);

    const regression = rig({
      snapshots: [
        { cursor: 7, kind: "activity", status: "ACTIVE" },
        { cursor: 6, kind: "terminal", status: "SUCCESS" }
      ]
    });
    const regressionProcess = regression.adapter.spawnPromptFree(issuedContext().context);
    regressionProcess.writeInitialPrompt(PROMPT);
    await regression.adapter.observeProviderActivity(context());
    await expect(regression.adapter.observeTerminal(context())).rejects.toMatchObject({
      code: "cursor_unavailable"
    });
    expect(regression.registry.terminals).toHaveLength(0);
  });

  it("returns only detail-free errors when controller and stream failures contain sensitive values", async () => {
    const metadataFailure = rig();
    metadataFailure.metadataRead.mockImplementation(() => {
      throw new Error(PROMPT);
    });
    try {
      metadataFailure.adapter.spawnPromptFree(issuedContext().context);
      throw new Error("expected metadata failure");
    } catch (error) {
      expectAdapterError(error, "metadata_unavailable");
    }

    const streamFailure = rig({
      terminalOverride: async () => {
        throw new Error(`${PROMPT}: reasoning and headers`);
      }
    });
    const process = streamFailure.adapter.spawnPromptFree(issuedContext().context);
    process.writeInitialPrompt(PROMPT);
    await streamFailure.adapter.observeProviderActivity(context());
    try {
      await streamFailure.adapter.observeTerminal(context());
      throw new Error("expected terminal failure");
    } catch (error) {
      expectAdapterError(error, "terminal_unobserved");
    }

    const unknown = rig();
    await expect(unknown.adapter.observeProviderActivity(context({ requestId: "unknown-request" })))
      .rejects.toMatchObject({ code: "unknown_request" });
    expect(JSON.stringify(unknown.adapter)).not.toContain(PROMPT);
    expect(JSON.stringify(unknown.adapter)).not.toContain("secret-token");
  });
});
