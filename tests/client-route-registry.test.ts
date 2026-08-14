import { describe, expect, it } from "vitest";
import {
  AcpSessionClientRouteClosedError,
  AcpSessionClientRouteConflictError,
  AcpSessionClientRouteError,
  AcpSessionClientRouteFenceError,
  AcpSessionClientRouteNotFoundError,
  AcpSessionClientRouteProtocolError,
  AcpSessionClientRouteRegistry,
  AcpSessionClientRouteStaleSenderError,
  type AcpSessionClientRouteBinding,
  type AcpSessionClientRouteReference,
  type AcpSessionUpdateSender
} from "../ACP Connector/acp/session/client-route-registry.js";

describe("AcpSessionClientRouteRegistry", () => {
  it("binds standard session/update senders by exact session, protocol, and connection fence", async () => {
    const registry = new AcpSessionClientRouteRegistry();
    const v1 = senderSpy();
    const v2 = senderSpy();
    const v1Binding = binding({ sender: v1.sender });
    const v2Binding = binding({ protocol: "v2", sender: v2.sender });

    const first = registry.bind(v1Binding);
    const retried = registry.bind(v1Binding);
    const second = registry.bind(v2Binding);
    await first.send({ sessionUpdate: "agent_message_chunk", messageId: "message-v1" });
    await retried.send({ sessionUpdate: "agent_message_chunk", messageId: "message-retry" });
    await second.send({ sessionUpdate: "agent_message_chunk", messageId: "message-v2" });

    expect(v1.calls).toEqual([
      [v1Binding.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "message-v1" }],
      [v1Binding.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "message-retry" }]
    ]);
    expect(v2.calls).toEqual([
      [v2Binding.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "message-v2" }]
    ]);
    registry.close();
  });

  it("rejects a different sender or fence while the exact session-protocol route remains active", () => {
    const registry = new AcpSessionClientRouteRegistry();
    const primary = senderSpy();
    const differentSender = senderSpy();
    const route = binding({ sender: primary.sender });
    registry.bind(route);

    expect(() => registry.bind({ ...route, sender: differentSender.sender })).toThrow(AcpSessionClientRouteConflictError);
    expect(() => registry.bind({ ...route, connectionFence: "connection-fence-next" })).toThrow(
      AcpSessionClientRouteConflictError
    );
    expect(registry.resolve(reference(route))).toBeDefined();
    registry.close();
  });

  it("requires an exact fence to unbind and makes an unbound route fail closed", () => {
    const registry = new AcpSessionClientRouteRegistry();
    const route = binding();
    registry.bind(route);

    expect(() => registry.unbind({ ...reference(route), connectionFence: "connection-fence-other" })).toThrow(
      AcpSessionClientRouteFenceError
    );
    expect(registry.unbind(reference(route))).toBe(true);
    expect(() => registry.resolve(reference(route))).toThrow(AcpSessionClientRouteNotFoundError);
    expect(() => registry.unbind(reference(route))).toThrow(AcpSessionClientRouteNotFoundError);
    registry.close();
  });

  it("never lets a stale resolved sender write after exact unbind and rebind", async () => {
    const registry = new AcpSessionClientRouteRegistry();
    const first = senderSpy();
    const replacement = senderSpy();
    const originalRoute = binding({ sender: first.sender });
    const stale = registry.bind(originalRoute);

    registry.unbind(reference(originalRoute));
    const replacementRoute = binding({ connectionFence: "connection-fence-next", sender: replacement.sender });
    const current = registry.bind(replacementRoute);

    await expect(stale.send({ sessionUpdate: "agent_message_chunk", messageId: "stale" })).rejects.toThrow(
      AcpSessionClientRouteStaleSenderError
    );
    await current.send({ sessionUpdate: "agent_message_chunk", messageId: "current" });
    expect(first.calls).toEqual([]);
    expect(replacement.calls).toEqual([
      [replacementRoute.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "current" }]
    ]);
    registry.close();
  });

  it("fails closed with typed errors for an unknown, unbound, or wrong-protocol route", () => {
    const registry = new AcpSessionClientRouteRegistry();
    const route = binding();
    registry.bind(route);

    expect(() => registry.resolve({ ...reference(route), protocol: "v2" })).toThrow(AcpSessionClientRouteProtocolError);
    expect(() => registry.resolve({ ...reference(route), sessionId: "session-unknown" })).toThrow(
      AcpSessionClientRouteNotFoundError
    );
    registry.unbind(reference(route));
    expect(() => registry.resolve(reference(route))).toThrow(AcpSessionClientRouteNotFoundError);
    registry.close();
  });

  it("uses strict route-input allowlists and retains no prompt, token, or header metadata", () => {
    const registry = new AcpSessionClientRouteRegistry();
    const route = binding();
    const rawPrompt = "prompt must not become route metadata";
    const rawToken = "token must not become route metadata";
    const rawHeader = "Bearer must not become route metadata";
    const unsafeBinding = Object.assign(route, {
      prompt: rawPrompt,
      token: rawToken,
      headers: { authorization: rawHeader }
    });

    expect(() => registry.bind(unsafeBinding as unknown as AcpSessionClientRouteBinding)).toThrow(
      AcpSessionClientRouteError
    );
    expect(() => registry.resolve(Object.assign(reference(route), { headers: { authorization: rawHeader } }))).toThrow(
      AcpSessionClientRouteError
    );
    expect(() => registry.resolve(reference(route))).toThrow(AcpSessionClientRouteNotFoundError);
    registry.close();
  });

  it("serializes concurrent conflicting binds and keeps only the winning route callable", async () => {
    const registry = new AcpSessionClientRouteRegistry();
    const left = senderSpy();
    const right = senderSpy();
    const leftRoute = binding({ connectionFence: "connection-fence-left", sender: left.sender });
    const rightRoute = binding({ connectionFence: "connection-fence-right", sender: right.sender });

    const results = await Promise.allSettled([
      Promise.resolve().then(() => registry.bind(leftRoute)),
      Promise.resolve().then(() => registry.bind(rightRoute))
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<ReturnType<AcpSessionClientRouteRegistry["bind"]>> => result.status === "fulfilled"
    );
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(AcpSessionClientRouteConflictError);

    const winner = fulfilled[0]?.value;
    await winner?.send({ sessionUpdate: "agent_message_chunk", messageId: "winner" });
    expect(left.calls.length + right.calls.length).toBe(1);
    registry.close();
  });

  it("clears all routes on close and rejects later bind, resolve, unbind, and stale sends", async () => {
    const registry = new AcpSessionClientRouteRegistry();
    const route = binding();
    const sender = registry.bind(route);
    registry.close();
    registry.close();

    expect(() => registry.bind(route)).toThrow(AcpSessionClientRouteClosedError);
    expect(() => registry.resolve(reference(route))).toThrow(AcpSessionClientRouteClosedError);
    expect(() => registry.unbind(reference(route))).toThrow(AcpSessionClientRouteClosedError);
    await expect(sender.send({ sessionUpdate: "agent_message_chunk", messageId: "after-close" })).rejects.toThrow(
      AcpSessionClientRouteClosedError
    );
  });
});

function binding(overrides: Partial<AcpSessionClientRouteBinding> = {}): AcpSessionClientRouteBinding {
  return {
    sessionId: overrides.sessionId ?? "session-default",
    protocol: overrides.protocol ?? "v1",
    connectionFence: overrides.connectionFence ?? "connection-fence-default",
    sender: overrides.sender ?? NOOP_SENDER
  };
}

function reference(route: AcpSessionClientRouteBinding): AcpSessionClientRouteReference {
  return {
    sessionId: route.sessionId,
    protocol: route.protocol,
    connectionFence: route.connectionFence
  };
}

function senderSpy(): { sender: AcpSessionUpdateSender; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    sender(sessionId: string, update: unknown): void {
      calls.push([sessionId, update]);
    },
    calls
  };
}

const NOOP_SENDER: AcpSessionUpdateSender = () => undefined;
