import type { AgyCliSession } from "../../agy/cli.js";
import type { ModelCatalog } from "../../agy/model/catalog.js";
import type { PromptV1Deps, PromptV2Deps } from "./prompt.js";

export type TurnIntent = "queue" | "steer";

export interface QueuedPromptV1 {
  id: string;
  version: "v1";
  params: import("@agentclientprotocol/sdk").PromptRequest;
  client: import("@agentclientprotocol/sdk").AgentContext;
  signal?: AbortSignal;
  deps: PromptV1Deps;
  resolve: (response: import("@agentclientprotocol/sdk").PromptResponse) => void;
  reject: (error: Error) => void;
  /**
   * Detaches the in-FIFO cancel listener. Called when the item leaves the
   * queue by any path — afterwards the turn's claim owns cancellation, and a
   * long-lived request signal must not pin the session.
   */
  detachQueueCancel?: () => void;
}

export interface QueuedPromptV2 {
  id: string;
  version: "v2";
  params: import("@agentclientprotocol/sdk/experimental/v2").PromptRequest;
  client: import("@agentclientprotocol/sdk/experimental/v2").AgentContext;
  /** Legacy preparation starts at local queue admission; global admission defers it until the TurnClaim exists. */
  ready: Promise<void>;
  promptText?: string;
  userMessageId?: string;
  controller: AbortController;
  deps: PromptV2Deps;
}

export type QueuedPrompt = QueuedPromptV1 | QueuedPromptV2;

export interface SessionState {
  sessionId: string;
  cwd: string;
  /** ACP additionalDirectories (excludes cwd). */
  additionalDirectories: string[];
  agy: AgyCliSession;
  catalog: ModelCatalog;
  selectedBaseModel: string;
  selectedReasoningEffort: string;
  /**
   * Owns the session's single turn slot: who is running, who has reserved the
   * next turn, and the abort controller for each. Created lazily via
   * `turnsOf(session)`; see `turn-scheduler.ts` for the invariants.
   */
  turns?: import("./turn-scheduler.js").TurnScheduler;
  /** Per-session FIFO of queued follow-up prompts. */
  promptQueue: QueuedPrompt[];
  /** Serializes v2 queued-message preparation and publication in FIFO order. */
  promptQueuePreparation?: Promise<void>;
  /** Set when the session is being closed or deleted. */
  closed?: boolean;
  /** Stable v2 user-message IDs keyed by their persisted agy step index. */
  v2UserMessageIdsByStep: Record<string, string>;
}
