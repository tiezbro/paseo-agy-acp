// ACP `initialize` handshake: negotiate protocol version and advertise capabilities.
// Docs: https://agentclientprotocol.com/protocol/v1/initialization

import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type {
  InitializeRequest as V1InitializeRequest,
  InitializeResponse as V1InitializeResponse
} from "@agentclientprotocol/sdk";
import type {
  InitializeRequest as V2InitializeRequest,
  InitializeResponse as V2InitializeResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import { v1AuthMethods, v2AuthMethods } from "../agy/auth.js";
import {
  negotiateAcpInitializationProtocolCapabilities,
  type AcpInitializationProtocolCapabilities,
  type AcpProtocolCapabilityAvailability
} from "./protocol-capabilities.js";

const AGENT_INFO = { name: "agy-acp", title: "Google Antigravity CLI" };

import type { ClientElicitationCapability } from "./tool-calls/elicitation.js";
export type { ClientElicitationCapability };

export interface ClientFsCapability {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export interface ClientToolCallNameCapability {
  name: boolean;
}

export function parseClientToolCallName(rawCaps: unknown, defaultEnabled = false): ClientToolCallNameCapability {
  if (!rawCaps || typeof rawCaps !== "object") return { name: defaultEnabled };
  const caps = rawCaps as Record<string, unknown>;
  const clientCaps =
    (caps.clientCapabilities as Record<string, unknown> | undefined) ??
    (caps.capabilities as Record<string, unknown> | undefined) ??
    caps;
  const capabilityMeta =
    (clientCaps._meta as Record<string, unknown> | undefined) ??
    (caps._meta as Record<string, unknown> | undefined);
  const nestedToolCall =
    (clientCaps.toolCall as Record<string, unknown> | undefined) ??
    (clientCaps.tool_call as Record<string, unknown> | undefined);

  const toolCallName =
    clientCaps.toolCallName ??
    clientCaps.tool_call_name ??
    nestedToolCall?.name ??
    clientCaps.unstable_toolCallName ??
    clientCaps.unstable_tool_call_name ??
    (clientCaps.unstable as Record<string, unknown> | undefined)?.toolCallName ??
    (clientCaps.unstable as Record<string, unknown> | undefined)?.tool_call_name ??
    capabilityMeta?.toolCallName ??
    capabilityMeta?.tool_call_name;

  if (typeof toolCallName === "boolean") return { name: toolCallName };
  if (toolCallName && typeof toolCallName === "object") {
    return { name: Boolean((toolCallName as Record<string, unknown>).name ?? true) };
  }
  return { name: defaultEnabled };
}
function parseClientElicitation(rawCaps: unknown): ClientElicitationCapability {
  if (!rawCaps || typeof rawCaps !== "object") return { form: false, url: false };
  const caps = rawCaps as Record<string, unknown>;
  const elicitation = (caps.elicitation ?? (caps.clientCapabilities as Record<string, unknown> | undefined)?.elicitation ?? (caps.capabilities as Record<string, unknown> | undefined)?.elicitation) as Record<string, unknown> | undefined;
  if (!elicitation || typeof elicitation !== "object") return { form: false, url: false };
  return {
    form: Boolean(elicitation.form != null && typeof elicitation.form === "object"),
    url: Boolean(elicitation.url != null && typeof elicitation.url === "object")
  };
}

/** v1 `initialize`: also returns the client's advertised `fs`, `elicitation`, and `toolCallName` capabilities. */
export function handleInitializeV1(
  params: V1InitializeRequest,
  agentVersion: string,
  capabilityAvailability: AcpProtocolCapabilityAvailability = {}
): {
  response: V1InitializeResponse;
  clientFs: ClientFsCapability;
  clientElicitation: ClientElicitationCapability;
  clientToolCallName: ClientToolCallNameCapability;
  clientProtocolCapabilities: AcpInitializationProtocolCapabilities;
} {
  const clientProtocolCapabilities = negotiateAcpInitializationProtocolCapabilities(
    params._meta,
    capabilityAvailability
  );
  return {
    clientFs: {
      readTextFile: params.clientCapabilities?.fs?.readTextFile ?? false,
      writeTextFile: params.clientCapabilities?.fs?.writeTextFile ?? false
    },
    clientElicitation: parseClientElicitation(params.clientCapabilities),
    clientToolCallName: parseClientToolCallName(params.clientCapabilities, false),
    clientProtocolCapabilities,
    response: {
      protocolVersion:
        params.protocolVersion === v1.PROTOCOL_VERSION ? params.protocolVersion : v1.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: {
          http: false,
          sse: false,
          acp: false
        },
        sessionCapabilities: {
          list: {},
          additionalDirectories: {},
          resume: {},
          close: {}
        },
        auth: {
          logout: {}
        },
        toolCallName: {}
      } as unknown as v1.AgentCapabilities,
      authMethods: v1AuthMethods(),
      agentInfo: { ...AGENT_INFO, version: agentVersion },
      ...(clientProtocolCapabilities.responseMeta === undefined
        ? {}
        : { _meta: clientProtocolCapabilities.responseMeta })
    }
  };
}

export function handleInitializeV2(
  params: V2InitializeRequest,
  agentVersion: string,
  capabilityAvailability: AcpProtocolCapabilityAvailability = {}
): {
  response: V2InitializeResponse;
  clientElicitation: ClientElicitationCapability;
  clientToolCallName: ClientToolCallNameCapability;
  clientProtocolCapabilities: AcpInitializationProtocolCapabilities;
} {
  const clientProtocolCapabilities = negotiateAcpInitializationProtocolCapabilities(
    params._meta,
    capabilityAvailability
  );
  return {
    clientElicitation: parseClientElicitation(params),
    clientToolCallName: parseClientToolCallName(params, true),
    clientProtocolCapabilities,
    response: {
      protocolVersion:
        params.protocolVersion === v2.PROTOCOL_VERSION ? params.protocolVersion : v2.PROTOCOL_VERSION,
      info: { ...AGENT_INFO, version: agentVersion },
      // Advertising `session` commits to the v2 baseline methods (new/list/resume/close/prompt/cancel/update).
      capabilities: {
        session: {
          prompt: {
            image: {},
            embeddedContext: {}
          },
          additionalDirectories: {}
        },
        auth: {},
        toolCallName: {},
        _meta: {
          toolCallName: {}
        }
      } as unknown as v2.AgentCapabilities,
      // Non-empty authMethods commits the agent to auth/login + auth/logout.
      authMethods: v2AuthMethods(),
      ...(clientProtocolCapabilities.responseMeta === undefined
        ? {}
        : { _meta: clientProtocolCapabilities.responseMeta })
    }
  };
}
