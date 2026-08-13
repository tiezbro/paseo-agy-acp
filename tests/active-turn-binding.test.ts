import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActiveSessionTurnBindingError,
  createActiveSessionTurnBinding,
  type ActiveSessionTurnRegistry
} from "../src/agy/acp/session/active-turn-binding.js";
import {
  ActiveSessionRegistry,
  type ActiveConnectorIdentity,
  type ActiveSessionAdvance,
  type ActiveSessionFence,
  type ActiveSessionRegistration,
  type ActiveSessionTerminalState
} from "../src/agy/acp/session/active-registry.js";

const stateDirectories: string[] = [];

afterEach(() => {
  for (const directory of stateDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ActiveSessionTurnBinding", () => {
  it("captures one exact fence, advances one conversation monotonically, and advances the final cursor before terminal/archive", () => {
    const input = registration({ conversationId: null, cursor: -1 });
    const registry = new RecordingRegistry(fenceFor(input));
    const binding = createActiveSessionTurnBinding(registry, input);

    expect(registry.registerCalls).toBe(1);
    expect(Object.keys(binding)).toEqual([]);
    expect(JSON.stringify(binding)).toBe("{}");
    for (const hidden of ["prompt", "process", "controller", "route", "payload", "fence", "registry"]) {
      expect(binding).not.toHaveProperty(hidden);
    }

    binding.advance({ conversationId: "conversation-exact", cursor: 2 });
    binding.advance({ conversationId: "conversation-exact", cursor: 5 });
    binding.markTerminal("completed", 8);
    expect(binding.archive()).toBe(true);

    expect(registry.events).toEqual(["register", "advance", "advance", "advance", "terminal", "archive"]);
    expect(registry.advances).toEqual([
      { conversationId: "conversation-exact", cursor: 2 },
      { conversationId: "conversation-exact", cursor: 5 },
      { conversationId: "conversation-exact", cursor: 8 }
    ]);
    expect(registry.terminalStates).toEqual(["completed"]);
    expect(registry.fences).toEqual([
      fenceFor(input),
      fenceFor(input),
      fenceFor(input),
      fenceFor(input),
      fenceFor(input)
    ]);
  });

  it("fails closed for wrong order, rebind, regression, invalid terminal state, and double terminal", () => {
    const rebind = bindingFor({ conversationId: null, cursor: -1 });
    rebind.binding.advance({ conversationId: "conversation-a", cursor: 3 });
    expectBindingError(() => rebind.binding.advance({ conversationId: "conversation-b", cursor: 4 }), "conversation_rebind");
    expectBindingError(() => rebind.binding.advance({ conversationId: "conversation-a", cursor: 4 }), "closed");

    const regression = bindingFor({ conversationId: "conversation-a", cursor: 3 });
    expectBindingError(() => regression.binding.advance({ conversationId: "conversation-a", cursor: 2 }), "cursor_regression");
    expectBindingError(() => regression.binding.markTerminal("completed", 3), "closed");

    const archiveBeforeTerminal = bindingFor({ conversationId: null, cursor: -1 });
    expectBindingError(() => archiveBeforeTerminal.binding.archive(), "wrong_order");
    expectBindingError(() => archiveBeforeTerminal.binding.advance({ conversationId: null, cursor: -1 }), "closed");

    const invalidTerminal = bindingFor({ conversationId: null, cursor: -1 });
    expectBindingError(() => invalidTerminal.binding.markTerminal("SUCCESS", -1), "invalid_terminal");

    const terminal = bindingFor({ conversationId: null, cursor: -1 });
    terminal.binding.markTerminal("cancelled", -1);
    expectBindingError(() => terminal.binding.markTerminal("cancelled", -1), "terminal_already_marked");
    expectBindingError(() => terminal.binding.archive(), "closed");
  });

  it("preserves every exact registry terminal state without exposing a raw terminal payload", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      const fixture = bindingFor({ conversationId: null, cursor: -1 });
      fixture.binding.markTerminal(state, -1);
      expect(fixture.registry.terminalStates).toEqual([state]);
    }
  });

  it("fails closed when the captured fence becomes stale in the real registry", () => {
    const { registry, input } = activeRegistryFixture();
    try {
      const binding = createActiveSessionTurnBinding(registry, input);
      const originalFence = registry.register(input);
      registry.takeOverStale(originalFence, connectorIdentity({
        ownerInstanceId: "22222222-2222-4222-8222-222222222222",
        pid: 4222,
        startTimeTicks: "102"
      }));

      expectBindingError(() => binding.advance({ conversationId: "conversation-stale", cursor: 0 }), "stale_fence");
      expectBindingError(() => binding.markTerminal("failed", -1), "closed");
    } finally {
      registry.close();
    }
  });

  it("converts registry failures to non-payload errors and seals the facade", () => {
    const privatePayload = "prompt, process stderr, and Authorization header must not escape";
    const input = registration({ conversationId: null, cursor: -1 });
    const registry = new RecordingRegistry(fenceFor(input));
    registry.advanceFailure = new Error(privatePayload);
    const binding = createActiveSessionTurnBinding(registry, input);

    const error = expectBindingError(
      () => binding.advance({ conversationId: "conversation-error", cursor: 0 }),
      "registry_error"
    );
    expect(error.message).not.toContain(privatePayload);
    expect(JSON.stringify(error)).not.toContain(privatePayload);
    expectBindingError(() => binding.archive(), "closed");
  });

  it("rejects an unavailable registry or malformed returned fence before exposing a facade", () => {
    const input = registration({ conversationId: null, cursor: -1 });
    expectBindingError(() => createActiveSessionTurnBinding(null, input), "invalid_registry");

    const strictRegistry = new RecordingRegistry(fenceFor(input));
    const unsafeInput = Object.assign({}, input, { prompt: "must not enter active-turn binding" });
    expectBindingError(() => createActiveSessionTurnBinding(strictRegistry, unsafeInput), "invalid_input");
    expect(strictRegistry.registerCalls).toBe(0);

    const malformed: ActiveSessionTurnRegistry = {
      register: () => ({ requestId: input.requestId, ownerInstanceId: input.connectorIdentity.ownerInstanceId, leaseGeneration: 1, raw: "no" }) as never,
      advance: () => {},
      markTerminal: () => {},
      archiveTerminal: () => true
    };
    expectBindingError(() => createActiveSessionTurnBinding(malformed, input), "registry_error");
  });
});

class RecordingRegistry implements ActiveSessionTurnRegistry {
  readonly events: string[] = [];
  readonly advances: ActiveSessionAdvance[] = [];
  readonly terminalStates: ActiveSessionTerminalState[] = [];
  readonly fences: ActiveSessionFence[] = [];
  registerCalls = 0;
  advanceFailure: Error | undefined;
  private archived = false;

  constructor(private readonly fence: ActiveSessionFence) {}

  register(): ActiveSessionFence {
    this.registerCalls += 1;
    this.events.push("register");
    return this.fence;
  }

  advance(fenceInput: unknown, updateInput: unknown): void {
    if (this.advanceFailure !== undefined) throw this.advanceFailure;
    this.events.push("advance");
    this.fences.push(fenceInput as ActiveSessionFence);
    this.advances.push(updateInput as ActiveSessionAdvance);
  }

  markTerminal(fenceInput: unknown, terminalState: unknown): void {
    this.events.push("terminal");
    this.fences.push(fenceInput as ActiveSessionFence);
    this.terminalStates.push(terminalState as ActiveSessionTerminalState);
  }

  archiveTerminal(fenceInput: unknown): boolean {
    this.events.push("archive");
    this.fences.push(fenceInput as ActiveSessionFence);
    if (this.archived) return false;
    this.archived = true;
    return true;
  }
}

function bindingFor(overrides: Partial<ActiveSessionRegistration> = {}) {
  const input = registration(overrides);
  const registry = new RecordingRegistry(fenceFor(input));
  return { binding: createActiveSessionTurnBinding(registry, input), registry };
}

function activeRegistryFixture(): { registry: ActiveSessionRegistry; input: ActiveSessionRegistration } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "active-turn-binding-"));
  stateDirectories.push(directory);
  return {
    registry: new ActiveSessionRegistry(path.join(directory, "active.sqlite")),
    input: registration({ conversationId: null, cursor: -1 })
  };
}

function registration(overrides: Partial<ActiveSessionRegistration> = {}): ActiveSessionRegistration {
  return {
    agentId: overrides.agentId ?? "agent-default",
    sessionId: overrides.sessionId ?? "session-default",
    requestId: overrides.requestId ?? "request-default",
    conversationId: Object.hasOwn(overrides, "conversationId") ? overrides.conversationId ?? null : "conversation-default",
    cursor: overrides.cursor ?? 7,
    connectorIdentity: overrides.connectorIdentity ?? connectorIdentity()
  };
}

function connectorIdentity(overrides: Partial<ActiveConnectorIdentity> = {}): ActiveConnectorIdentity {
  return {
    ownerInstanceId: overrides.ownerInstanceId ?? "11111111-1111-4111-8111-111111111111",
    createdAt: overrides.createdAt ?? "2026-08-10T12:00:00.000Z",
    bootId: overrides.bootId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pid: overrides.pid ?? 4121,
    startTimeTicks: overrides.startTimeTicks ?? "101",
    pidNamespaceInode: overrides.pidNamespaceInode ?? 4026531836,
    ppid: overrides.ppid ?? 4000,
    pgrp: overrides.pgrp ?? 4000,
    session: overrides.session ?? 4000
  };
}

function fenceFor(input: ActiveSessionRegistration): ActiveSessionFence {
  return {
    requestId: input.requestId,
    ownerInstanceId: input.connectorIdentity.ownerInstanceId,
    leaseGeneration: 1
  };
}

function expectBindingError(
  action: () => unknown,
  code: ActiveSessionTurnBindingError["code"]
): ActiveSessionTurnBindingError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ActiveSessionTurnBindingError);
    expect((error as ActiveSessionTurnBindingError).code).toBe(code);
    return error as ActiveSessionTurnBindingError;
  }
  throw new Error(`expected active session turn binding error: ${code}`);
}
