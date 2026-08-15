// ACP Agent: wires the dual v1 / draft-v2 RPC surface to section handlers.
// Handlers live under files/folders named after their exact ACP method path:
// root methods (authenticate.ts, logout.ts, initialize.ts) live directly
// under acp/; namespaced methods live under folders matching that namespace
// (auth/, session/, fs/, terminal/) — e.g. session/prompt.ts + session/
// cancel.ts implement session/prompt + session/cancel even though the ACP
// docs describe both under the single "prompt-turn" topic page. Folders that
// don't map to a single namespace hold logic spanning multiple doc topics
// instead (content/, slash-commands/, tool-calls/, agent-plan/). Non-ACP
// helper logic (agy CLI backend, conversation DB, model catalog resolution,
// local edit apply/revert) lives under agy/ rather than here, even where it
// builds ACP-shaped objects or consumes ACP types (e.g. agy/auth.ts,
// agy/model/catalog.ts, agy/edit/bridge.ts, agy/edit/revert.ts). This file
// owns instance state (active sessions, model cache) and wires it into those
// handlers.

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentContext as V1AgentContext,
  AgentApp as V1AgentApp,
  AuthenticateRequest,
  AuthenticateResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  InitializeRequest as V1InitializeRequest,
  InitializeResponse as V1InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  LogoutResponse,
  NewSessionRequest as V1NewSessionRequest,
  NewSessionResponse as V1NewSessionResponse,
  PromptRequest as V1PromptRequest,
  PromptResponse as V1PromptResponse,
  ResumeSessionRequest as V1ResumeSessionRequest,
  ResumeSessionResponse as V1ResumeSessionResponse,
  SetSessionConfigOptionRequest as V1SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse as V1SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse
} from "@agentclientprotocol/sdk";
import type {
  AgentContext as V2AgentContext,
  AgentApp as V2AgentApp,
  InitializeRequest as V2InitializeRequest,
  InitializeResponse as V2InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoginAuthRequest,
  LoginAuthResponse,
  LogoutAuthRequest,
  LogoutAuthResponse,
  NewSessionRequest as V2NewSessionRequest,
  NewSessionResponse as V2NewSessionResponse,
  PromptRequest as V2PromptRequest,
  PromptResponse as V2PromptResponse,
  ResumeSessionRequest as V2ResumeSessionRequest,
  ResumeSessionResponse as V2ResumeSessionResponse,
  SetSessionConfigOptionRequest as V2SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse as V2SetSessionConfigOptionResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import { ReplayCache } from "../agy/db/replay.js";
import type { ClientFileSystem } from "../agy/edit/bridge.js";
import { readTextFile } from "./fs/read-text-file.js";
import { writeTextFile } from "./fs/write-text-file.js";
import { ensureAgyInstalled } from "../agy/installer.js";
import { AUTH_REQUIRED_MESSAGE, isAgyAuthenticated, v1AuthMethods } from "../agy/auth.js";
import type { AgyStartupLauncher } from "../agy/startup-launcher.js";
import {
  AgyCliBackend,
  configFromEnv,
  type AgyCliConfig,
  type PtyFactory,
  type SpawnFactory
} from "../agy/cli.js";
import { handleInitializeV1, handleInitializeV2 } from "./initialize.js";
import {
  defaultStateDir,
  SessionStore,
  type SessionStoreBackend,
  type StoredSession
} from "./session/store.js";
import { handleCloseSession } from "./session/close.js";
import { handleDeleteSession } from "./session/delete.js";
import { handleListSessions } from "./session/list.js";
import { handleAuthenticate } from "./authenticate.js";
import { handleLogout } from "./logout.js";
import { handleLoginAuth } from "./auth/login.js";
import { handleLogoutAuth } from "./auth/logout.js";
import type { SessionState } from "./session/types.js";
import { applyConfigOption as applyConfigOptionHandler } from "./session/config-options.js";
import { handleSetConfigOptionV1, handleSetConfigOptionV2 } from "./session/set-config-option.js";
import {
  buildSession,
  createSession,
  registerSession,
  reloadSession,
  replayConversation,
  persistSession,
  type SessionBuildDeps
} from "./session/setup.js";
import { handleNewSessionV1, handleNewSessionV2, type NewSessionDeps } from "./session/new.js";
import { handleLoadSession } from "./session/load.js";
import { handleResumeSessionV1, handleResumeSessionV2 } from "./session/resume.js";
import { handleSetSessionMode } from "./session/set-mode.js";
import { MODE_CONFIG_ID } from "./session/modes.js";
import {
  notifyAvailableCommandsV1,
  notifyAvailableCommandsV2,
  notifyConfigOptionUpdateV1,
  notifyConfigOptionUpdateV2,
  notifyCurrentModeUpdate
} from "./session/update.js";
import { handlePromptV1, handlePromptV2, type PromptV1Deps, type PromptV2Deps } from "./session/prompt.js";
import { handleCancel } from "./session/cancel.js";
import { parseAdmissionRuntimeConfig } from "../../Admission Controller/runtime-config.js";
import { createAdmissionRuntime } from "../admission/runtime.js";
import { AdmissionTurnCoordinator } from "../admission/turn-coordinator.js";
import { SQLiteSessionStore } from "./session/sqlite-store.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: string };
/** Conversation replays cached per conversation id before LRU eviction. */
const REPLAY_CACHE_CAPACITY = 32;
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 64;

interface ModelCacheFile {
  entries: Record<string, { models: string[]; updatedAt: number }>;
}

export interface AcpAgentOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnFactory;
  ptyFactory?: PtyFactory;
  argv?: string[];
  stateDir?: string;
  conversationsDir?: string;
  maxActiveSessions?: number;
  modelCacheEnabled?: boolean;
  /** Explicitly injected local agy start gate; absent preserves legacy startup. */
  startupLauncher?: AgyStartupLauncher;
  /** Persistence backend selected by explicit runtime composition. */
  sessionStore?: SessionStoreBackend;
  /** Shared-queue wrapper for the final-plan online turn path. */
  turnAdmission?: AdmissionTurnCoordinator;
}

/** Resources created for the opt-in v2 runtime around one ACP connection. */
export interface AcpRuntimeComposition {
  readonly options: AcpAgentOptions;
  readonly sessionStore: SessionStoreBackend | undefined;
  close(): void;
}

export class AcpRuntimeCompositionError extends Error {
  constructor(message: string) {
    super(`ACP runtime composition error: ${message}`);
    this.name = "AcpRuntimeCompositionError";
  }
}

export class AcpAgent {
  readonly #env: NodeJS.ProcessEnv;
  readonly #argv: string[];
  readonly #backend: AgyCliBackend;
  readonly #sessions = new Map<string, SessionState>();
  readonly #store: SessionStoreBackend;
  readonly #replayCache = new ReplayCache(REPLAY_CACHE_CAPACITY);
  readonly #modelCacheFile: string;
  readonly #modelCacheEnabled: boolean;
  readonly #modelOptionsCache = new Map<string, { models: string[]; updatedAt: number }>();
  readonly #modelRefreshes = new Map<string, Promise<void>>();
  readonly #maxActiveSessions: number;
  readonly #conversationsDir: string | undefined;
  readonly #turnAdmission: AdmissionTurnCoordinator | undefined;
  readonly #startupLauncher: AgyStartupLauncher | undefined;
  #modelCacheWrite: Promise<void> = Promise.resolve();
  #ensureAgyPromise: Promise<string | null> | undefined;
  /** v1 client's `fs` capability, set from `initialize`. Draft v2 has no fs/* client methods. */
  #clientFs = { readTextFile: false, writeTextFile: false };
  #clientElicitation = { form: false, url: false };
  #clientToolCallName = { name: false };

  constructor(options: AcpAgentOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#argv = options.argv ?? [];
    this.#backend = new AgyCliBackend(options.spawnProcess, options.ptyFactory);
    const stateDir = options.stateDir ?? defaultStateDir();
    this.#store = options.sessionStore ?? new SessionStore(stateDir);
    this.#modelCacheFile = path.join(stateDir, "models.json");
    this.#modelCacheEnabled = options.modelCacheEnabled ?? (this.#env.NODE_ENV !== "test");
    this.#turnAdmission = options.turnAdmission;
    this.#startupLauncher = options.startupLauncher;
    this.#maxActiveSessions =
      options.maxActiveSessions !== undefined &&
      Number.isInteger(options.maxActiveSessions) &&
      options.maxActiveSessions > 0
        ? options.maxActiveSessions
        : DEFAULT_MAX_ACTIVE_SESSIONS;
    this.#conversationsDir = options.conversationsDir;
    this.loadModelCache();
  }

  async initializeV1(params: V1InitializeRequest): Promise<V1InitializeResponse> {
    await this.ensureAgyReady();
    const { response, clientFs, clientElicitation, clientToolCallName } = handleInitializeV1(
      params,
      packageJson.version ?? "0.0.0"
    );
    this.#clientFs = clientFs;
    this.#clientElicitation = clientElicitation;
    this.#clientToolCallName = clientToolCallName;
    return response;
  }

  async initializeV2(params: V2InitializeRequest): Promise<V2InitializeResponse> {
    await this.ensureAgyReady();
    const { response, clientElicitation, clientToolCallName } = handleInitializeV2(
      params,
      packageJson.version ?? "0.0.0"
    );
    this.#clientElicitation = clientElicitation;
    this.#clientToolCallName = clientToolCallName;
    return response;
  }

  private ensureAgyReady(): Promise<string | null> {
    this.#ensureAgyPromise ??= ensureAgyInstalled({
      env: this.#env,
      warn: (message) => console.error(message),
      startupLauncher: this.#startupLauncher
    });
    return this.#ensureAgyPromise;
  }

  /** Probe config for auth checks (cwd only; no workspace roots required). */
  private authProbeConfig(cwd = process.cwd()): AgyCliConfig {
    const config = configFromEnv({
      cwd,
      env: this.#env,
      argv: this.#argv,
      conversationsDir: this.#conversationsDir
    });
    if (this.#startupLauncher !== undefined) config.startupLauncher = this.#startupLauncher;
    return config;
  }

  /**
   * Ensure agy is signed in. Throws ACP `auth_required` when not authenticated.
   */
  private async requireAuthenticated(cwd?: string): Promise<void> {
    await this.ensureAgyReady();
    const status = await isAgyAuthenticated(this.#backend, this.authProbeConfig(cwd));
    if (status.ok) return;
    console.error(`[agy-acp] auth required: ${status.reason}`);
    throw RequestError.authRequired(
      { authMethods: v1AuthMethods() },
      AUTH_REQUIRED_MESSAGE
    );
  }

  /**
   * v1 `authenticate` / v2 `auth/login`: confirm keyring login after terminal auth,
   * or succeed immediately when already signed in.
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return handleAuthenticate(params, this.#backend, this.authProbeConfig(), () => this.ensureAgyReady());
  }

  async loginAuth(params: LoginAuthRequest): Promise<LoginAuthResponse> {
    return handleLoginAuth(params, this.#backend, this.authProbeConfig(), () => this.ensureAgyReady());
  }

  /** v1 `logout` / v2 `auth/logout`: best-effort agy TUI `/logout`. */
  async logout(params: LogoutRequest = {}): Promise<LogoutResponse> {
    return handleLogout(params, this.#backend, this.authProbeConfig(), () => this.ensureAgyReady());
  }

  async logoutAuth(params: LogoutAuthRequest = {}): Promise<LogoutAuthResponse> {
    return handleLogoutAuth(params, this.#backend, this.authProbeConfig(), () => this.ensureAgyReady());
  }

  /**
   * When the client advertises `fs.readTextFile` + `fs.writeTextFile`, route
   * already-applied edits through those methods so the client's own
   * diff/review UI (e.g. Zed's Review Changes panel) tracks them. Draft v2
   * has no fs/* client methods, so this is v1-only.
   */
  private clientFileSystemV1(client: V1AgentContext, sessionId: string): ClientFileSystem | undefined {
    if (!this.#clientFs.readTextFile || !this.#clientFs.writeTextFile) return undefined;
    return {
      readTextFile: (path) => readTextFile(client, sessionId, path),
      writeTextFile: (path, content) => writeTextFile(client, sessionId, path, content)
    };
  }

  private newSessionDeps(): NewSessionDeps {
    return {
      requireAuthenticated: (cwd) => this.requireAuthenticated(cwd),
      createSession: (cwd, dirs) => this.createSession(cwd, dirs)
    };
  }

  async newSessionV1(params: V1NewSessionRequest, client?: V1AgentContext): Promise<V1NewSessionResponse> {
    const response = await handleNewSessionV1(params, client, {
      ...this.newSessionDeps(),
      notifyAvailableCommandsV1
    });
    return response;
  }

  async newSessionV2(params: V2NewSessionRequest, client?: V2AgentContext): Promise<V2NewSessionResponse> {
    const response = await handleNewSessionV2(params, client, {
      ...this.newSessionDeps(),
      notifyAvailableCommandsV2
    });
    return response;
  }

  async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    return handleListSessions(params, this.#store);
  }

  private reloadSessionDeps() {
    return {
      requireAuthenticated: (cwd?: string) => this.requireAuthenticated(cwd),
      reloadSession: (sessionId: string, cwd: string | undefined, dirs: string[] | undefined) =>
        this.reloadSession(sessionId, cwd, dirs),
      replayConversation: (
        session: SessionState,
        conversationId: string,
        cwd: string,
        emit: (update: v1.SessionUpdate) => Promise<void>,
        replayFrom?: unknown,
        v2UserMessageIdsByStep?: Record<string, string>
      ) => this.replayConversation(session, conversationId, cwd, emit, replayFrom, v2UserMessageIdsByStep)
    };
  }

  async loadSession(params: LoadSessionRequest, client: V1AgentContext): Promise<LoadSessionResponse> {
    const response = await handleLoadSession(params, client, {
      ...this.reloadSessionDeps(),
      clientToolCallNameV1: () => this.#clientToolCallName,
      notifyAvailableCommandsV1
    });
    return response;
  }

  async resumeSessionV1(params: V1ResumeSessionRequest, client?: V1AgentContext): Promise<V1ResumeSessionResponse> {
    const response = await handleResumeSessionV1(params, client, {
      ...this.reloadSessionDeps(),
      notifyAvailableCommandsV1
    });
    return response;
  }

  async resumeSessionV2(params: V2ResumeSessionRequest, client: V2AgentContext): Promise<V2ResumeSessionResponse> {
    const response = await handleResumeSessionV2(params, client, {
      ...this.reloadSessionDeps(),
      clientToolCallNameV2: () => this.#clientToolCallName,
      notifyAvailableCommandsV2
    });
    return response;
  }

  setConfigOptionV1(
    params: V1SetSessionConfigOptionRequest,
    client?: V1AgentContext
  ): Promise<V1SetSessionConfigOptionResponse> {
    return handleSetConfigOptionV1(params, client, {
      requireSession: (id) => this.requireSession(id),
      applyConfigOption: (sessionId, configId, value) => this.applyConfigOption(sessionId, configId, value),
      notifyCurrentModeUpdate,
      notifyConfigOptionUpdateV1
    });
  }

  setConfigOptionV2(params: V2SetSessionConfigOptionRequest): Promise<V2SetSessionConfigOptionResponse> {
    return handleSetConfigOptionV2(params, {
      requireSession: (id) => this.requireSession(id),
      applyConfigOption: (sessionId, configId, value) => this.applyConfigOption(sessionId, configId, value)
    });
  }

  setSessionMode(params: SetSessionModeRequest, client: V1AgentContext): Promise<SetSessionModeResponse> {
    return handleSetSessionMode(params, client, {
      requireSession: (id) => this.requireSession(id),
      applyConfigOption: (sessionId, configId, value) => this.applyConfigOption(sessionId, configId, value),
      notifyCurrentModeUpdate,
      notifyConfigOptionUpdateV1
    });
  }

  /**
   * Honor curated ACP slash commands that map onto session config (mode / model /
   * reasoningEffort). Returns true when the prompt was fully handled without
   * spawning agy. Unknown or non-slash prompts return false (pass through).
   */
  private promptV1Deps(): PromptV1Deps {
    return {
      requireSession: (id) => this.requireSession(id),
      applyConfigOption: (sessionId, configId, value) => this.applyConfigOption(sessionId, configId, value),
      persistSession: (id, session) => this.persistSession(id, session),
      notifyCurrentModeUpdate,
      notifyConfigOptionUpdateV1,
      clientFileSystemV1: (client, sessionId) => this.clientFileSystemV1(client, sessionId),
      clientElicitationV1: () => this.#clientElicitation,
      clientToolCallNameV1: () => this.#clientToolCallName,
      turnAdmission: this.#turnAdmission
    };
  }

  private promptV2Deps(): PromptV2Deps {
    return {
      requireSession: (id) => this.requireSession(id),
      applyConfigOption: (sessionId, configId, value) => this.applyConfigOption(sessionId, configId, value),
      persistSession: (id, session) => this.persistSession(id, session),
      notifyConfigOptionUpdateV2,
      clientElicitationV2: () => this.#clientElicitation,
      clientToolCallNameV2: () => this.#clientToolCallName,
      turnAdmission: this.#turnAdmission
    };
  }

  /**
   * v1 prompt lifecycle: response carries stopReason after the full turn.
   */
  promptV1(
    params: V1PromptRequest,
    client: V1AgentContext,
    signal?: AbortSignal
  ): Promise<V1PromptResponse> {
    return handlePromptV1(params, client, signal, this.promptV1Deps());
  }

  /**
   * v2 prompt lifecycle: respond `{}` immediately on acceptance. Foreground
   * progress and stopReason arrive as `state_update` notifications.
   */
  promptV2(params: V2PromptRequest, client: V2AgentContext): Promise<V2PromptResponse> {
    return handlePromptV2(params, client, this.promptV2Deps());
  }

  cancel(params: { sessionId: string; _meta?: Record<string, unknown> | null }): Promise<void> {
    return handleCancel(params.sessionId, this.#sessions, params._meta);
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    return handleCloseSession(params, this.#sessions);
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    return handleDeleteSession(params, this.#sessions, this.#store);
  }

  private createSession(
    requestedCwd: string | undefined,
    requestedDirs: string[] | undefined
  ): Promise<SessionState> {
    return createSession(requestedCwd, requestedDirs, {
      ...this.sessionBuildDeps(),
      sessions: this.#sessions,
      maxActiveSessions: this.#maxActiveSessions,
      persistSession: (sessionId, session) => this.persistSession(sessionId, session)
    });
  }

  private applyConfigOption(sessionId: string, configId: string, value: unknown): Promise<void> {
    if (
      this.#turnAdmission !== undefined &&
      configId === MODE_CONFIG_ID &&
      value !== "dangerously-skip-permissions"
    ) {
      throw new AcpRuntimeCompositionError(
        "enabled admission currently requires dangerously-skip-permissions mode"
      );
    }
    return applyConfigOptionHandler(sessionId, configId, value, {
      requireSession: (id) => this.requireSession(id),
      persistSession: (id, session) => this.persistSession(id, session)
    });
  }

  private replayConversation(
    session: SessionState,
    conversationId: string,
    cwd: string,
    emit: (update: v1.SessionUpdate) => Promise<void>,
    replayFrom?: unknown,
    v2UserMessageIdsByStep?: Record<string, string>
  ): Promise<void> {
    return replayConversation(
      this.#replayCache,
      session,
      conversationId,
      cwd,
      emit,
      replayFrom,
      v2UserMessageIdsByStep
    );
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, session);
    return session;
  }

  private registerSession(sessionId: string, session: SessionState): Promise<void> {
    return registerSession(sessionId, session, this.#sessions, this.#maxActiveSessions);
  }

  private sessionBuildDeps(): SessionBuildDeps {
    return {
      env: this.#env,
      argv: this.#argv,
      backend: this.#backend,
      getModelOptions: (config) => this.modelOptionsForConfig(config),
      conversationsDir: this.#conversationsDir,
      admissionEnabled: this.#turnAdmission !== undefined
    };
  }

  private async modelOptionsForConfig(config: AgyCliConfig): Promise<string[]> {
    const key = config.agyPath;
    const cached = this.#modelOptionsCache.get(key);
    if (cached?.models.length) {
      if (Date.now() - cached.updatedAt >= MODEL_CACHE_TTL_MS) {
        this.refreshModelOptions(config);
      }
      return cached.models;
    }

    try {
      const models = await this.#backend.listModels(config);
      if (models.length > 0) {
        this.cacheModelOptions(key, models);
      }
      return models;
    } catch {
      return config.model ? [config.model] : [];
    }
  }

  private loadModelCache(): void {
    if (!this.#modelCacheEnabled) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#modelCacheFile, "utf-8")) as Partial<ModelCacheFile>;
      for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
        if (!entry || !Array.isArray(entry.models) || !Number.isFinite(entry.updatedAt)) continue;
        const models = entry.models.filter((model): model is string => typeof model === "string");
        if (models.length > 0) {
          this.#modelOptionsCache.set(key, { models, updatedAt: entry.updatedAt });
        }
      }
    } catch {
      // Missing or malformed caches are rebuilt from `agy models`.
    }
  }

  private cacheModelOptions(key: string, models: string[]): void {
    const normalized = [...new Set(models)];
    this.#modelOptionsCache.set(key, { models: normalized, updatedAt: Date.now() });
    if (!this.#modelCacheEnabled) return;

    this.#modelCacheWrite = this.#modelCacheWrite
      .then(async () => {
        const entries = Object.fromEntries(this.#modelOptionsCache);
        await fs.promises.mkdir(path.dirname(this.#modelCacheFile), { recursive: true });
        const tmp = `${this.#modelCacheFile}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify({ entries }, null, 2));
        await fs.promises.rename(tmp, this.#modelCacheFile);
      })
      .catch((error) => {
        console.error(`[agy-acp] WARN: failed to persist model cache: ${(error as Error).message}`);
      });
  }

  private refreshModelOptions(config: AgyCliConfig): void {
    const key = config.agyPath;
    if (this.#modelRefreshes.has(key)) return;
    const refresh = this.#backend.listModels(config)
      .then((models) => {
        if (models.length > 0) this.cacheModelOptions(key, models);
      })
      .catch(() => {})
      .finally(() => {
        this.#modelRefreshes.delete(key);
      });
    this.#modelRefreshes.set(key, refresh);
  }

  private buildSession(
    cwd: string,
    additionalDirectories: string[],
    stored: StoredSession | null
  ): Promise<SessionState> {
    return buildSession(cwd, additionalDirectories, stored, this.sessionBuildDeps());
  }

  /** Shared reconstruction for `session/load` and `session/resume`: restore a
   *  persisted session binding and re-register it in memory. */
  private reloadSession(
    sessionId: string,
    requestedCwd: string | undefined,
    requestedDirs: string[] | undefined
  ): Promise<{ session: SessionState; cwd: string; stored: StoredSession }> {
    return reloadSession(sessionId, requestedCwd, requestedDirs, {
      ...this.sessionBuildDeps(),
      store: this.#store,
      sessions: this.#sessions,
      maxActiveSessions: this.#maxActiveSessions
    });
  }

  private persistSession(sessionId: string, session: SessionState): Promise<void> {
    if (session.closed || this.#sessions.get(sessionId) !== session) {
      return Promise.resolve();
    }
    return persistSession(this.#store, sessionId, session);
  }

}

/**
 * Build the opt-in runtime around one ACP connection. The disabled default
 * leaves both the legacy JSON store and legacy prompt path untouched.
 */
export function composeAcpRuntime(options: AcpAgentOptions = {}): AcpRuntimeComposition {
  const runtimeConfig = parseAdmissionRuntimeConfig(options.env ?? process.env);
  if (runtimeConfig.enabled) {
    if (
      options.sessionStore !== undefined ||
      options.turnAdmission !== undefined
    ) {
      throw new AcpRuntimeCompositionError("enabled admission does not accept alternate state or delivery owners");
    }
    const runtime = createAdmissionRuntime(options.env ?? process.env);
    if (runtime === null) throw new AcpRuntimeCompositionError("enabled admission runtime is unavailable");
    let sessionStore: SQLiteSessionStore | undefined;
    let coordinator: AdmissionTurnCoordinator | undefined;
    try {
      sessionStore = new SQLiteSessionStore(runtimeConfig.databasePath);
      coordinator = new AdmissionTurnCoordinator({
        controller: runtime.controller,
        parentId: runtimeConfig.agentId
      });
      let closed = false;
      const composedOptions: AcpAgentOptions = {
        ...options,
        stateDir: runtimeConfig.stateDir,
        sessionStore,
        turnAdmission: coordinator
      };
      return {
        options: composedOptions,
        sessionStore,
        close() {
          if (closed) return;
          closed = true;
          coordinator?.close();
          let failure: unknown;
          try {
            sessionStore?.close();
          } catch (error) {
            failure = error;
          }
          try {
            runtime.close();
          } catch (error) {
            failure ??= error;
          }
          if (failure !== undefined) throw failure;
        }
      };
    } catch (error) {
      try {
        coordinator?.close();
      } catch {}
      try {
        sessionStore?.close();
      } catch {}
      try {
        runtime.close();
      } catch {}
      throw error;
    }
  }

  if (options.sessionStore !== undefined) {
    return {
      options,
      sessionStore: options.sessionStore,
      close() {}
    };
  }

  return {
    options,
    sessionStore: undefined,
    close() {}
  };
}

/** ACP v1 agent app (stable protocol). */
export function createAcpApp(options: AcpAgentOptions = {}): V1AgentApp {
  return createAcpAppForAgent(new AcpAgent(options));
}

function createAcpAppForAgent(agent: AcpAgent): V1AgentApp {
  return v1
    .agent({ name: "agy-acp" })
    .onRequest(v1.methods.agent.initialize, (ctx) => agent.initializeV1(ctx.params))
    .onRequest(v1.methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
    .onRequest(v1.methods.agent.logout, (ctx) => agent.logout(ctx.params))
    .onRequest(v1.methods.agent.session.new, (ctx) => agent.newSessionV1(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(v1.methods.agent.session.load, (ctx) => agent.loadSession(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.resume, (ctx) => agent.resumeSessionV1(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params, ctx.client))
    .onRequest(v1.methods.agent.session.setConfigOption, (ctx) =>
      agent.setConfigOptionV1(ctx.params, ctx.client)
    )
    .onRequest(v1.methods.agent.session.prompt, (ctx) => agent.promptV1(ctx.params, ctx.client, ctx.signal))
    .onRequest(v1.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(v1.methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
    .onNotification(v1.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params));
}

/**
 * Experimental draft ACP v2 agent app.
 * Prefer {@link createDualAcpApp} / {@link runAcp} so v1 clients still work.
 */
export function createAcpV2App(options: AcpAgentOptions = {}): V2AgentApp {
  return createAcpV2AppForAgent(new AcpAgent(options));
}

function createAcpV2AppForAgent(agent: AcpAgent): V2AgentApp {
  return v2
    .agent({ name: "agy-acp" })
    .onRequest(v2.methods.agent.initialize, (ctx) => agent.initializeV2(ctx.params))
    .onRequest(v2.methods.agent.auth.login, (ctx) => agent.loginAuth(ctx.params))
    .onRequest(v2.methods.agent.auth.logout, (ctx) => agent.logoutAuth(ctx.params))
    .onRequest(v2.methods.agent.session.new, (ctx) => agent.newSessionV2(ctx.params, ctx.client))
    .onRequest(v2.methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(v2.methods.agent.session.resume, (ctx) => agent.resumeSessionV2(ctx.params, ctx.client))
    .onRequest(v2.methods.agent.session.setConfigOption, (ctx) => agent.setConfigOptionV2(ctx.params))
    .onRequest(v2.methods.agent.session.prompt, (ctx) => agent.promptV2(ctx.params, ctx.client))
    .onRequest(v2.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(v2.methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
    .onNotification(v2.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params));
}

/**
 * Dual-version agent connector: negotiates ACP v1 or experimental draft v2 from
 * the client's `initialize.protocolVersion`.
 */
export function createDualAcpApp(options: AcpAgentOptions = {}): v2.AgentProtocolRouter {
  const agent = new AcpAgent(options);
  return v2
    .agentProtocolRouter()
    .withV1(createAcpAppForAgent(agent))
    .withV2(createAcpV2AppForAgent(agent));
}

export function runAcp(options: AcpAgentOptions = {}) {
  const composition = composeAcpRuntime(options);
  const stdout = (composition.options.stdout ?? process.stdout) as Writable;
  const stdin = (composition.options.stdin ?? process.stdin) as Readable;
  // v1 ndJsonStream is sufficient: framing is shared; the router peeks initialize.
  const stream = v1.ndJsonStream(
    Writable.toWeb(stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(stdin) as ReadableStream<Uint8Array>
  );
  try {
    const connection = createDualAcpApp(composition.options).connect(stream);
    const closed = connection.closed;
    if (closed !== undefined) {
      void closed.then(() => composition.close()).catch(() => {
        try {
          composition.close();
        } catch {
          // Connection teardown cannot safely report a second failure.
        }
      });
    }
    return connection;
  } catch (error) {
    composition.close();
    throw error;
  }
}

export { contentBlocksToPrompt, contentBlocksToText } from "./content/index.js";
export { buildModelCatalog, modelConfigOption, reasoningEffortConfigOption, toModelSlug, prettifyModelSlug } from "../agy/model/catalog.js";
export { sessionModeState, modeConfigOption } from "./session/modes.js";
