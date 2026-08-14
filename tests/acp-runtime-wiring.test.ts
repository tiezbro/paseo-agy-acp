import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import Database from "better-sqlite3";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpAgent,
  AcpRuntimeCompositionError,
  composeAcpRuntime,
  createAcpApp,
  createAcpV2App,
  runAcp
} from "../ACP Connector/acp/agent.js";
import { AcpSessionClientRouteRegistry } from "../ACP Connector/acp/session/client-route-registry.js";
import { AcpOutboxDeliveryBridge, type OutboxDeliveryMessage } from "../ACP Connector/acp/outbox-delivery.js";
import {
  AdmissionController,
  DURABLE_DELIVERY_PROTOCOL,
  type AdmissionPolicy,
  type EnqueueDelivery
} from "../Admission Controller/controller.js";
import {
  ACP_OUTBOX_ACK_METHOD,
  ACP_OUTBOX_CAPABILITY,
  ACP_OUTBOX_CAPABILITY_KEY,
  ACP_OUTBOX_CAPABILITY_VERSION,
  type OutboxAck
} from "../ACP Connector/admission/outbox-protocol.js";
import * as installer from "../ACP Connector/agy/installer.js";
import type { AgyStartupLauncher } from "../ACP Connector/agy/startup-launcher.js";

const stateDirs: string[] = [];
const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

function stateDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-acp-runtime-wiring-"));
  stateDirs.push(directory);
  return directory;
}

function runtimeEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    AGY_ACP_ADMISSION_ENABLED: "1",
    AGY_ACP_STATE_DIR: directory,
    PASEO_AGENT_ID: "agent-runtime-wiring",
    NODE_ENV: "test"
  };
}

function outboxOffer(): Record<string, unknown> {
  return {
    versions: [ACP_OUTBOX_CAPABILITY_VERSION],
    required: false,
    ackRequests: true,
    durableEventIdDedupe: true
  };
}

function admission(directory: string): AdmissionController {
  return new AdmissionController({
    databasePath: path.join(directory, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 29),
    contentFingerprintKey: Buffer.alloc(32, 30),
    claimTokenKey: Buffer.alloc(32, 31)
  });
}

function enqueueDelivery(controller: AdmissionController, eventId: string): void {
  controller.enqueue({
    requestId: "request-runtime-wiring",
    sessionId: "session-runtime-wiring",
    parentId: "parent-runtime-wiring",
    fingerprint: "request-fingerprint-runtime-wiring",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_000
  });
  const delivery: EnqueueDelivery = {
    eventId,
    requestId: "request-runtime-wiring",
    fingerprint: "delivery-fingerprint-runtime-wiring",
    payload: "durable terminal update",
    sequence: 1,
    now: 1_001,
    expiresAt: 10_000,
    protocol: DURABLE_DELIVERY_PROTOCOL
  };
  controller.enqueueDelivery(delivery);
}

function deliveryState(controller: AdmissionController, eventId: string): string {
  const database = new Database(controller.databasePath, { readonly: true });
  const row = database.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get(eventId) as { state: string };
  database.close();
  return row.state;
}

function acknowledgement(message: OutboxDeliveryMessage): OutboxAck {
  return {
    v: ACP_OUTBOX_CAPABILITY_VERSION,
    sessionId: "session-runtime-wiring",
    eventId: message.metadata.eventId,
    claimGeneration: message.metadata.claimGeneration,
    claimToken: message.metadata.claimToken
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of stateDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ACP runtime SQLite composition", () => {
  it("threads the exact startup launcher into initialize installation and auth probes", async () => {
    const startupLauncher: AgyStartupLauncher = {
      enabled: true,
      acquire: () => ({ release() {} })
    };
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const agent = new AcpAgent({
      stateDir: stateDir(),
      modelCacheEnabled: false,
      startupLauncher
    });

    await agent.initializeV1({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(installed).toHaveBeenCalledWith(expect.objectContaining({ startupLauncher }));
    const authConfig = (agent as unknown as { authProbeConfig(cwd: string): { startupLauncher?: AgyStartupLauncher } })
      .authProbeConfig("/tmp");
    expect(authConfig.startupLauncher).toBe(startupLauncher);
  });

  it("fails closed before creating partial state while the production graph is incomplete", () => {
    const directory = stateDir();

    expect(() => composeAcpRuntime({
      env: runtimeEnvironment(directory),
      modelCacheEnabled: false
    })).toThrow(AcpRuntimeCompositionError);
    expect(existsSync(path.join(directory, "runtime.sqlite"))).toBe(false);
    expect(existsSync(path.join(directory, "sessions.json"))).toBe(false);
  });

  it("blocks the transport entrypoint before connection setup when admission is enabled", () => {
    const directory = stateDir();
    const input = new PassThrough();
    const output = new PassThrough();
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);

    expect(() => runAcp({
      env: runtimeEnvironment(directory),
      stdin: input,
      stdout: output,
      modelCacheEnabled: false
    })).toThrow(AcpRuntimeCompositionError);
    expect(installed).not.toHaveBeenCalled();
    expect(existsSync(path.join(directory, "runtime.sqlite"))).toBe(false);
    input.end();
    output.end();
  });
});

describe("ACP session client route wiring", () => {
  it("binds one exact v1 client.session/update sender and fences it on unbind", async () => {
    const routes = new AcpSessionClientRouteRegistry();
    const agent = new AcpAgent({
      stateDir: stateDir(),
      modelCacheEnabled: false,
      clientRoutes: routes,
      connectionFence: "connection-runtime-wiring"
    });
    const notify = vi.fn(async () => undefined);
    const client = { notify };
    const routedAgent = agent as unknown as {
      bindClientRoute(sessionId: string, protocol: "v1", client: { notify: typeof notify }): void;
      unbindClientRoutes(sessionId: string): void;
    };

    routedAgent.bindClientRoute("session-route-wiring", "v1", client);
    routedAgent.bindClientRoute("session-route-wiring", "v1", client);
    const route = routes.resolve({
      sessionId: "session-route-wiring",
      protocol: "v1",
      connectionFence: "connection-runtime-wiring"
    });
    await route.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "result" } });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(methods.client.session.update, {
      sessionId: "session-route-wiring",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "result" } }
    });

    routedAgent.unbindClientRoutes("session-route-wiring");
    await expect(route.send({ sessionUpdate: "agent_message_chunk" })).rejects.toThrow(/stale|unknown/i);
    routes.close();
  });

  it("requires client route registry and connection fence as one fail-closed pair", () => {
    expect(() => new AcpAgent({
      stateDir: stateDir(),
      modelCacheEnabled: false,
      clientRoutes: new AcpSessionClientRouteRegistry()
    })).toThrow(AcpRuntimeCompositionError);
    expect(() => new AcpAgent({
      stateDir: stateDir(),
      modelCacheEnabled: false,
      connectionFence: "orphan-fence"
    })).toThrow(AcpRuntimeCompositionError);
  });
});

describe("ACP durable outbox route", () => {
  it("advertises the outbox only with an active route and accepts valid, duplicate, and rejects forged ACKs", async () => {
    const directory = stateDir();
    const controller = admission(directory);
    enqueueDelivery(controller, "event-runtime-wiring");
    const sent: OutboxDeliveryMessage[] = [];
    const bridge = new AcpOutboxDeliveryBridge({
      admission: controller,
      ownerInstanceId: "delivery-runtime-wiring",
      sender: async (message) => {
        sent.push(message);
      }
    });
    await bridge.deliver("event-runtime-wiring", 1_002);
    const valid = acknowledgement(sent[0]!);
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const connection = acpClient({ name: "runtime-wiring-client" }).connect(
      createAcpApp({
        stateDir: directory,
        modelCacheEnabled: false,
        outboxDelivery: bridge,
        outboxNow: () => 1_003
      })
    );

    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer() }
      });
      expect(initialized._meta).toMatchObject({
        [ACP_OUTBOX_CAPABILITY_KEY]: {
          version: ACP_OUTBOX_CAPABILITY_VERSION,
          ackMethod: ACP_OUTBOX_ACK_METHOD
        }
      });

      await expect(
        connection.agent.request<Record<string, never>, OutboxAck>(ACP_OUTBOX_ACK_METHOD, {
          ...valid,
          claimToken: "forged-token"
        })
      ).rejects.toThrow();
      expect(deliveryState(controller, valid.eventId)).toBe("claimed");

      await expect(
        connection.agent.request<Record<string, never>, OutboxAck>(ACP_OUTBOX_ACK_METHOD, valid)
      ).resolves.toEqual({});
      expect(deliveryState(controller, valid.eventId)).toBe("delivered");

      await expect(
        connection.agent.request<Record<string, never>, OutboxAck>(ACP_OUTBOX_ACK_METHOD, valid)
      ).resolves.toEqual({});
      expect(installed).toHaveBeenCalledOnce();
    } finally {
      connection.close();
      controller.close();
    }
  });

  it("keeps the default-disabled path legacy and does not advertise an unavailable outbox", async () => {
    const directory = stateDir();
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const connection = acpClient({ name: "legacy-runtime-wiring-client" }).connect(
      createAcpApp({ stateDir: directory, modelCacheEnabled: false })
    );

    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer() }
      });

      expect(initialized).not.toHaveProperty("_meta");
      await expect(
        connection.agent.request<Record<string, never>, OutboxAck>(ACP_OUTBOX_ACK_METHOD, {
          v: ACP_OUTBOX_CAPABILITY_VERSION,
          sessionId: "session-runtime-wiring",
          eventId: "event-runtime-wiring",
          claimGeneration: 1,
          claimToken: "not-active"
        })
      ).rejects.toThrow();
      expect(installed).toHaveBeenCalledOnce();
    } finally {
      connection.close();
    }
  });

  it("keeps draft v2 capability negotiation truthful when the route is absent", async () => {
    const directory = stateDir();
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const connection = acpV2.client({ name: "legacy-v2-runtime-wiring-client" }).connect(
      createAcpV2App({ stateDir: directory, modelCacheEnabled: false })
    );

    try {
      const initialized = await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "legacy-v2-runtime-wiring-client", version: "1.0.0" },
        capabilities: {},
        _meta: { [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer() }
      });

      expect(initialized).not.toHaveProperty("_meta");
      expect(installed).toHaveBeenCalledOnce();
    } finally {
      connection.close();
    }
  });
});
