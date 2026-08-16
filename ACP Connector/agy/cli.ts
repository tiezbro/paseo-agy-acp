import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, statSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgyPromptFreeDispatchBoundary,
  type AgyDispatchBoundaryResult,
  type AgyDispatchCancellationRecheck,
  type AgyDispatchFence,
  type AgyDispatchIdentityPersistenceResult,
  type AgyDispatchIntentCommitResult,
  type AgyDispatchProcess,
  type AgyDispatchProcessRecord,
  type AgyDispatchWriteResult
} from "./dispatch-boundary.js";
import {
  isVerifiedAgyBinary,
  type AgyLaunchSpecification,
  type VerifiedAgyBinary
} from "./launch-spec.js";
import {
  startAgyPromptFreeProcess,
  type AgyPromptFreeProcess
} from "./prompt-free-process.js";
import { launchAgyProcess, type AgyStartupLauncher } from "./startup-launcher.js";
import { conversationSnapshot } from "./db/scan.js";
import { defaultInstallBinDir, ensureAgyInstalled } from "./installer.js";
import { StreamPoller } from "./db/streaming.js";
import type { StepRow } from "./db/types.js";
import { diffBlocks, revertEditToolCall, type DiffBlock } from "./edit/revert.js";
import {
  primeEditReadThroughClient,
  routeEditThroughClient,
  writeEditThroughClient,
  type ClientFileSystem
} from "./edit/bridge.js";
import {
  buildReconcileEditUpdate,
  observeEditedPaths,
  reconcileWorkingTree,
  snapshotWorkingTree,
  toDisplayPath,
  type ReportedBlock,
  type ReportedContent,
  type WorkingTreeSnapshot
} from "./edit/reconcile.js";
import {
  canBridgeInteraction,
  interactionKeys,
  isEditToolCall,
  normalizePermissionChoice,
  parseAskQuestion,
  type PermissionChoice
} from "../acp/tool-calls/permissions.js";
import type { ClientElicitationCapability } from "../acp/tool-calls/elicitation.js";
export const DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS = 15_000;
export const DEFAULT_CONVERSATIONS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
const POLL_INTERVAL_MS = 200;
/** Trailing polls after the process exits, to catch rows flushed right around exit. */
const TRAILING_POLL_ATTEMPTS = 3;
const TRAILING_POLL_DELAY_MS = 100;
const PERMISSION_RENDER_SETTLE_MS = 20;
const PERMISSION_REDRAW_TIMEOUT_MS = 500;
// No entry is added until a real prompt-free PTY spawn exists. The current
// interactive PTY argv carries the business prompt and must never register.
const cliProducedPromptFreePtyLaunches = new WeakSet<object>();

/**
 * A canary source must have been registered by an actual prompt-free PTY
 * launcher in this module. Generic specs and stdin print launches are not
 * sources, even when they carry a verified binary identity.
 */
export function isCliProducedPromptFreePtyLaunch(value: unknown): value is AgyLaunchSpecification {
  return typeof value === "object" && value !== null && cliProducedPromptFreePtyLaunches.has(value);
}

/** Signature of the permission decision agy has recorded for a gated step.
 *  A re-armed status-9 prompt (e.g. the next segment of `a && b`) changes this
 *  even though the toolCallId is unchanged, letting the turn loop tell a fresh
 *  decision apart from a redundant re-emission of the same still-pending one. */
function permissionSignature(row: StepRow): string {
  const p = row.permission;
  return p ? `${p.kind}\u0000${p.value}\u0000${p.decision}` : "none";
}

/**
 * agy tools whose diff blocks carry the whole file body rather than a snippet,
 * so disk is accounted for exactly when it equals the reported content. An
 * unrecognized name is treated as a targeted replacement, which fails closed.
 */
const WHOLE_FILE_EDIT_TOOLS = new Set(["write_to_file"]);

/** True when the tool-call's diff blocks carry whole file bodies, not snippets. */
function wholeFileEdit(toolCall: SessionUpdate): boolean {
  const name = (toolCall as unknown as { name?: string }).name;
  return name !== undefined && WHOLE_FILE_EDIT_TOOLS.has(name);
}

/**
 * What a tool-call's diff reported, per absolute path (targets may be
 * session-relative). The blocks let the reconciler tell the change this update
 * accounts for apart from one that reached the file before it was polled.
 */
function reportedContents(cwd: string, toolCall: SessionUpdate): ReportedContent[] {
  const wholeFile = wholeFileEdit(toolCall);
  const byPath = new Map<string, Array<{ oldText: string | null; newText: string }>>();
  for (const { path: target, oldText, newText } of diffBlocks(toolCall)) {
    const abs = path.resolve(cwd, target);
    const blocks = byPath.get(abs);
    if (blocks) blocks.push({ oldText, newText });
    else byPath.set(abs, [{ oldText, newText }]);
  }
  return [...byPath].map(([filePath, blocks]) => ({ path: filePath, blocks, wholeFile }));
}

/**
 * What a completed revert restored, per absolute path. A rejected creation
 * left nothing on disk and the client rejected it, so the path is forgotten
 * unconditionally. Anything else is attributed by the *reverse* of the
 * restored blocks: the client knows the edit was undone, but a restored block
 * says nothing about the rest of the file, so an unrelated change that landed
 * next to the edit before the reject still reaches reconciliation.
 */
function revertedContents(cwd: string, toolCall: SessionUpdate, restored: DiffBlock[]): ReportedContent[] {
  const wholeFile = wholeFileEdit(toolCall);
  const byPath = new Map<string, { created: boolean; blocks: ReportedBlock[] }>();
  for (const { path: target, oldText, newText } of restored) {
    const abs = path.resolve(cwd, target);
    const entry = byPath.get(abs) ?? { created: false, blocks: [] };
    if (oldText === null) entry.created = true;
    else entry.blocks.push({ oldText: newText, newText: oldText });
    byPath.set(abs, entry);
  }
  return [...byPath].map(([filePath, { created, blocks }]) =>
    created ? { path: filePath } : { path: filePath, wholeFile, blocks }
  );
}

/** How many unsupported changes to name individually in the warning line. */
const UNSUPPORTED_DETAIL_LIMIT = 10;

export type SpawnedProcess = ChildProcessWithoutNullStreams;

export interface PtyProcess {
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}
export interface PtyFactory {
  spawn(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; cols: number; rows: number }): PtyProcess;
}

/**
 * @deprecated Compatibility-only shape for the removed CLI-owned dispatch
 * boundary. `enabled: true` fails closed before spawning or invoking any hook;
 * use `startPromptFreeProcess` and let AdmissionPromptDispatcher own the
 * durable identity, intent, and irreversible write.
 */
export interface AgyPromptFreeDispatchConfig<TProcessIdentity = unknown> {
  enabled: boolean;
  fence: AgyDispatchFence;
  captureProcessIdentity(process: { pid?: number }): TProcessIdentity | null | undefined;
  persistProcessIdentity(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchIdentityPersistenceResult;
  recheckCancellation(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchCancellationRecheck;
  commitDispatchIntent(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchIntentCommitResult;
  /**
   * Performs the one prompt write after a durable commit. It may return
   * accepted only with synchronous proof; undefined, partial, or thrown
   * writes become terminal dispatch_ambiguous.
   */
  writeInitialPrompt(child: SpawnedProcess, prompt: string): AgyDispatchWriteResult;
}

/** Terminal outcome for an enabled prompt-free dispatch that could not safely proceed. */
export class AgyPromptFreeDispatchError extends Error {
  readonly state: "blocked" | "dispatch_ambiguous";
  readonly reason?: string;

  constructor(state: "blocked" | "dispatch_ambiguous", reason?: string) {
    super(state === "dispatch_ambiguous"
      ? "agy prompt dispatch is ambiguous; the prompt will not be retried automatically"
      : `agy prompt dispatch was blocked${reason ? `: ${reason}` : ""}`);
    this.name = "AgyPromptFreeDispatchError";
    this.state = state;
    this.reason = reason;
  }
}

export type PermissionCallback = (
  toolCall: SessionUpdate,
  context: { toolName: string; questionIndex?: number }
) => Promise<PermissionChoice | "cancelled">;

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Immutable startup proof for the prompt-free production launch path. */
  launchSpecification?: AgyLaunchSpecification;
}

export type SpawnFactory = (
  command: string,
  args: string[],
  options: SpawnOptions
) => SpawnedProcess;

/** agy execution setting exposed through ACP/Paseo. `dangerously-skip-permissions`
 * is the native agy flag name, not an agy `--mode` value. */
export type SessionModeId = "default" | "accept-edits" | "plan" | "dangerously-skip-permissions";

export const SESSION_MODE_IDS: readonly SessionModeId[] = [
  "default",
  "accept-edits",
  "plan",
  "dangerously-skip-permissions"
] as const;

export function isSessionModeId(value: string): value is SessionModeId {
  return (SESSION_MODE_IDS as readonly string[]).includes(value);
}

export interface AgyCliConfig {
  cwd: string;
  /** ACP `additionalDirectories` (extra roots for `agy --add-dir`; excludes cwd). */
  additionalDirectories: string[];
  agyPath: string;
  /** Value for `--model` (base model slug or display name). */
  model?: string;
  /** Value for `--effort` (`low` | `medium` | `high`), when applicable. */
  effort?: string;
  /**
   * Agent execution mode exposed through ACP/Paseo.
   * `default` omits the flag (request-review / write confirmation).
   * `accept-edits` and `plan` pass `--mode <value>`.
   * `dangerously-skip-permissions` passes `--dangerously-skip-permissions` and no `--mode`.
   */
  mode: SessionModeId;
  project?: string;
  printTimeout: string;
  sandbox: boolean;
  skipPermissions: boolean;
  interactivePermissions: boolean;
  logFile?: string;
  promptInArgv: boolean;
  /**
   * Explicit programmatic input issued from a successful exact `agy --version`
   * probe. configFromEnv intentionally never supplies it.
   */
  verifiedAgyBinary?: VerifiedAgyBinary;
  /** @deprecated Compatibility-only; enabled configurations fail closed. */
  promptFreeDispatch?: AgyPromptFreeDispatchConfig;
  /** Explicitly injected only; configFromEnv never enables a local-start gate. */
  startupLauncher?: AgyStartupLauncher;
  autoInstall: boolean;
  installBinDir?: string;
  modelList: string[];
  discoverModels: boolean;
  modelListTimeoutMs: number;
  /** Directory where agy writes its per-conversation SQLite databases. */
  conversationsDir: string;
  env?: NodeJS.ProcessEnv;
}

export interface PromptOutcome {
  stopReason: "end_turn" | "cancelled";
}

export interface AgyCliConfigInput {
  cwd: string;
  additionalDirectories?: string[];
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  /** Override the conversations directory (defaults to ~/.gemini/antigravity-cli/conversations). */
  conversationsDir?: string;
}

/**
 * Narrow request-scoped hook used by the Admission Controller around the
 * existing print-mode stdin write. It owns no process creation or output.
 */
export interface AgyAdmissionDispatchBoundary {
  prepare(processId: number): void;
  beforePromptWrite(): void;
  afterPromptWrite(): void;
}

type PromptFreeDispatchProcessIdentity = { readonly pid: number } | null;

interface AgyAdmissionDispatchAmbiguousBridge {
  markDispatchAmbiguous(): void;
}

interface AgyAdmissionDispatchIntentBridge {
  commitDispatchIntent(): void;
}

export class AgyCliError extends Error {
  readonly command: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    command: string[],
    exitCode: number | null,
    stderr: string
  ) {
    super(message);
    this.name = "AgyCliError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class AgyCliSession {
  #process: SpawnedProcess | undefined;
  #pty: PtyProcess | undefined;
  #ptyExit: Promise<{ exitCode: number }> | undefined;
  #ptyOutput = "";
  #ptyIdleMarkerCount = 0;
  #ptyIdleMatchTail = "";
  #ptyPermissionMarkerCount = 0;
  #ptyPermissionRender = "";
  #ptyPermissionMarkerTail = "";
  #ptyPermissionPanelVisible = false;
  #ptyPermissionRenderTimer: ReturnType<typeof setTimeout> | undefined;
  #ptyConfig = "";
  #cancelled = false;
  #cancelTurn: (() => void) | undefined;
  #cancelWait: Promise<void> = Promise.resolve();
  #extraPath: string | undefined;
  #conversationId: string | null = null;
  #lastStepIdx = -1;
  #lastPromptUserStepIdxs: number[] = [];
  readonly config: AgyCliConfig;
  readonly spawnProcess: SpawnFactory;
  readonly ptyFactory?: PtyFactory;

  constructor(
    config: AgyCliConfig,
    spawnProcess: SpawnFactory = defaultSpawnFactory,
    ptyFactory?: PtyFactory
  ) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.ptyFactory = ptyFactory;
  }

  get wasCancelled(): boolean {
    return this.#cancelled;
  }

  /** The agy conversation id this session is bound to, once known (after the first prompt). */
  get conversationId(): string | null {
    return this.#conversationId;
  }

  /** Highest conversation-database step idx already delivered to the ACP client. */
  get lastStepIdx(): number {
    return this.#lastStepIdx;
  }

  /** Type-14 user rows observed during the most recent prompt invocation. */
  get lastPromptUserStepIdxs(): readonly number[] {
    return this.#lastPromptUserStepIdxs;
  }

  /** Seed the conversation binding from persisted state (for session/load and session/resume). */
  restoreConversation(conversationId: string | null, lastStepIdx: number): void {
    this.#conversationId = conversationId;
    this.#lastStepIdx = lastStepIdx;
  }

  setModel(model: string | undefined): void {
    this.config.model = model;
  }

  setEffort(effort: string | undefined): void {
    this.config.effort = effort;
  }

  setMode(mode: SessionModeId): void {
    this.config.mode = mode;
    this.config.skipPermissions = mode === "dangerously-skip-permissions";
  }

  commandForPrompt(prompt: string): string[] {
    return this.commandForPromptValue(prompt, this.config.promptInArgv);
  }

  /** The request-scoped stdin primitive owns no business write at startup. */
  private commandForPromptFreeProcess(): string[] {
    return [
      ...this.commandForPromptValue(undefined, false),
      "--output-format",
      "stream-json"
    ];
  }

  /**
   * Starts the exact verified stdin child without writing the business prompt.
   * The caller receives the once-only capability and must consume it only after
   * its own durable admission and dispatch-intent checks have succeeded.
   */
  startPromptFreeProcess(businessPrompt: string): AgyPromptFreeProcess<SpawnedProcess> {
    return this.startPromptFreeProcessInternal(businessPrompt);
  }

  private startPromptFreeProcessInternal(businessPrompt: string): AgyPromptFreeProcess<SpawnedProcess> {
    const command = this.commandForPromptFreeProcess();
    try {
      const process = startAgyPromptFreeProcess({
        verifiedAgyBinary: this.verifiedAgyBinaryForPromptFreeProcess(),
        argv: command,
        environment: this.promptFreeEnvironment(businessPrompt),
        cwd: this.config.cwd,
        processTitle: "agy-acp:prompt-free-print",
        temporaryFilePath: path.join(os.tmpdir(), "paseo-agy-acp", "prompt-free-print.launch"),
        launcherDiagnostics: [
          "agy-acp launch=prompt-free-print",
          "transport=stdin"
        ],
        businessPrompt,
        start: (launch) => launchAgyProcess(
          this.config.startupLauncher,
          "model_turn",
          () => {
            const [program, ...args] = launch.argv;
            if (!program) throw new Error("prompt-free launch specification has no executable");
            return this.spawnProcess(program, args, {
              cwd: launch.cwd,
              env: { ...launch.environment },
              launchSpecification: launch
            });
          }
        )
      });
      this.#process = process.child;
      void process.exit.then(() => {
        if (this.#process === process.child) this.#process = undefined;
      });
      return process;
    } catch (error) {
      throw this.errorForSpawnFailure(command, error as NodeJS.ErrnoException);
    }
  }

  private commandForPromptValue(prompt: string | undefined, includePrompt: boolean): string[] {
    const command = [
      this.config.agyPath,
      "--print"
    ];

    if (includePrompt && prompt !== undefined) {
      command.push(prompt);
    }

    command.push("--print-timeout", this.config.printTimeout);

    if (this.config.sandbox) {
      command.push("--sandbox");
    }
    if (this.shouldSkipPermissions()) {
      command.push("--dangerously-skip-permissions");
    }
    if (this.config.mode !== "default" && this.config.mode !== "dangerously-skip-permissions") {
      command.push("--mode", this.config.mode);
    }
    if (this.config.model) {
      command.push("--model", this.config.model);
    }
    if (this.config.effort) {
      command.push("--effort", this.config.effort);
    }
    if (this.config.project) {
      command.push("--project", this.config.project);
    }
    if (this.config.logFile) {
      command.push("--log-file", this.config.logFile);
    }
    if (this.#conversationId) {
      command.push("--conversation", this.#conversationId);
    }

    // Pass cwd + additionalDirectories as --add-dir roots (cwd included so agy
    // treats the workspace the same way the previous workspaces[] list did).
    const seen = new Set<string>();
    for (const root of [this.config.cwd, ...this.config.additionalDirectories]) {
      const resolved = path.resolve(root);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      command.push("--add-dir", resolved);
    }

    return command;
  }

  interactiveCommandForPrompt(
    prompt: string,
    options: { includeStartupPrompt?: boolean } = {}
  ): string[] {
    const includeStartupPrompt = options.includeStartupPrompt !== false;
    const command = includeStartupPrompt
      ? this.commandForPrompt(prompt)
      : this.commandForPromptValue(undefined, false);
    const timeout = command.indexOf("--print-timeout");
    if (timeout >= 0) command.splice(timeout, 2);
    const print = command.indexOf("--print");
    if (print >= 0) command.splice(print, includeStartupPrompt && this.config.promptInArgv ? 2 : 1);
    if (includeStartupPrompt) command.splice(1, 0, "--prompt-interactive", prompt);
    return command;
  }

  /**
   * Run one prompt turn: spawn agy, poll its conversation database for newly
   * appended steps while the process runs, and invoke `onUpdate` with the
   * translated ACP updates in order. Resolves once the process exits and a few
   * trailing polls have drained any steps flushed right around exit.
   *
   * Invariant (zero prompt injection): `prompt` is only client-originated
   * content from ACP session/prompt. Never invent labels, instructions, or
   * follow-ups (e.g. "continue") — for background wakeups, keep the turn open
   * and poll instead. PTY writes during a turn are permission keys (or the same
   * user `prompt` when reusing an interactive TUI), never adapter prose.
   */
  async prompt(
    prompt: string,
    onUpdate: (update: SessionUpdate) => Promise<void>,
    onPermission?: PermissionCallback,
    fsBridge?: ClientFileSystem,
    elicitationCap?: ClientElicitationCapability,
    admissionBoundary?: AgyAdmissionDispatchBoundary
  ): Promise<PromptOutcome> {
    this.#lastPromptUserStepIdxs = [];
    // The removed CLI-owned dispatch configuration must stay unreachable. The
    // Admission Controller uses the request-scoped boundary argument below.
    if (this.config.promptFreeDispatch?.enabled === true) {
      throw new AgyPromptFreeDispatchError("blocked", "dispatcher_owned_prompt_required");
    }
    if (this.shouldUseInteractivePermissions() && !onPermission) {
      throw new Error("interactive permissions require a permission callback");
    }
    this.#cancelled = false;
    this.#cancelWait = new Promise((resolve) => { this.#cancelTurn = resolve; });
    try {
      if (this.shouldUseInteractivePermissions()) {
        return await this.runInteractivePrompt(
          prompt,
          onUpdate,
          onPermission!,
          fsBridge,
          elicitationCap,
          admissionBoundary
        );
      }
      const command = admissionBoundary === undefined
        ? this.commandForPrompt(prompt)
        : this.commandForPromptFreeProcess();
      try {
        return await this.runPromptCommand(command, prompt, onUpdate, fsBridge, admissionBoundary);
      } catch (error) {
        if (this.shouldInstallAfterError(error)) {
          await this.installAgy();
          return await this.runPromptCommand(
            admissionBoundary === undefined
              ? this.commandForPrompt(prompt)
              : this.commandForPromptFreeProcess(),
            prompt,
            onUpdate,
            fsBridge,
            admissionBoundary
          );
        }
        throw error;
      }
    } finally {
      this.#cancelTurn = undefined;
    }
  }

  private async runInteractivePrompt(
    prompt: string,
    onUpdate: (update: SessionUpdate) => Promise<void>,
    onPermission: PermissionCallback,
    fsBridge?: ClientFileSystem,
    elicitationCap?: ClientElicitationCapability,
    admissionBoundary?: AgyAdmissionDispatchBoundary
  ): Promise<PromptOutcome> {
    // Snapshot the pre-edit working tree so edits agy makes outside recognized
    // structured-edit tool-calls (shell commands, unrecognized payloads) still
    // get reflected through ACP. Emitting the synthetic session/update needs no
    // client fs capability, so do this for every client (v1 and v2); the client
    // write-through is layered on later only when a bridge is available.
    let editBaseline: WorkingTreeSnapshot | null = null;
    try {
      editBaseline = await snapshotWorkingTree([this.config.cwd, ...this.config.additionalDirectories]);
    } catch {
      editBaseline = null;
    }
    const observeReported = (reported: ReportedContent[]): Promise<void> =>
      this.observeReported(editBaseline, reported);
    const signature = JSON.stringify([this.config.model, this.config.effort, this.config.mode]);
    if (this.#pty && this.#ptyConfig !== signature) await this.stopPty();
    if (this.#cancelled) { this.#cancelTurn = undefined; return { stopReason: "cancelled" }; }
    const snapshot = this.#conversationId === null ? conversationSnapshot(this.config.conversationsDir) : null;
    let freshPty = false;
    if (!this.#pty) {
      const factory = this.ptyFactory ?? await defaultPtyFactory();
      if (this.#cancelled) { this.#cancelTurn = undefined; return { stopReason: "cancelled" }; }
      const [program, ...args] = this.interactiveCommandForPrompt(prompt, {
        includeStartupPrompt: admissionBoundary === undefined
      });
      this.#pty = launchAgyProcess(
        this.config.startupLauncher,
        "resident_pty",
        () => factory.spawn(program, args, { ...this.spawnOptions(), cols: 120, rows: 40 }),
        "pty"
      );
      freshPty = true;
      this.#ptyConfig = signature;
      this.#ptyOutput = "";
      this.#ptyIdleMarkerCount = 0;
      this.#ptyIdleMatchTail = "";
      this.#ptyPermissionMarkerCount = 0;
      this.#ptyPermissionRender = "";
      this.#ptyPermissionMarkerTail = "";
      this.#ptyPermissionPanelVisible = false;
      const activePty = this.#pty;
      activePty.onData((data) => {
        if (this.#pty !== activePty) return;
        const idleMarker = "for shortcuts";
        const searchable = this.#ptyIdleMatchTail + data;
        let offset = 0;
        while ((offset = searchable.indexOf(idleMarker, offset)) >= 0) {
          this.#ptyIdleMarkerCount++;
          this.#ptyPermissionPanelVisible = false;
          offset += idleMarker.length;
        }
        this.#ptyIdleMatchTail = searchable.slice(-(idleMarker.length - 1));

        // Treat a transition into agy's permission panel as one occurrence.
        // Arrow-key navigation redraws the same panel and must not re-arm the
        // gate; consecutive identical gates transition through a non-panel
        // render while the approved command segment runs.
        this.#ptyPermissionRender = (this.#ptyPermissionRender + data).slice(-16_384);
        if (this.#ptyPermissionRenderTimer) clearTimeout(this.#ptyPermissionRenderTimer);
        this.#ptyPermissionRenderTimer = setTimeout(
          () => this.flushPermissionRender(),
          PERMISSION_RENDER_SETTLE_MS
        );
        this.#ptyOutput = (this.#ptyOutput + data).slice(-16_384);
      });
      this.#ptyExit = new Promise((resolve) => this.#pty!.onExit(resolve));
    }
    if (!freshPty || admissionBoundary !== undefined) {
      const writePrompt = () => {
        this.#pty?.write(`\x1b[200~${prompt.replaceAll("\x1b", "")}\x1b[201~\r`);
      };
      if (admissionBoundary !== undefined) {
        const processId = ptyProcessId(this.#pty);
        if (processId === undefined) {
          throw new AgyPromptFreeDispatchError("blocked", "child_process_identity_unavailable");
        }
        admissionBoundary.prepare(processId);
        admissionBoundary.beforePromptWrite();
        writePrompt();
        admissionBoundary.afterPromptWrite();
      } else {
        writePrompt();
      }
    }
    const poller = new StreamPoller({ dir: this.config.conversationsDir, conversationId: this.#conversationId,
      baseStepIdx: this.#lastStepIdx, skipNarration: false, cwd: this.config.cwd, snapshot });
    // Tracked separately: a toolCallId can legitimately go through the live
    // gate first (status 9 -> keys sent) and later reappear as a completed
    // edit once agy applies it, at which point it's still worth routing
    // through the client's fs write-through so its native review UI tracks
    // the edit — that's a second, independent decision for the same id.
    const requestedGate = new Map<string, string>();
    const gateMarkerCounts = new Map<string, number>();
    const rearmedGateIds = new Set<string>();
    const requestedEditReview = new Set<string>();
    // ids that already went through the live gate above, so a later
    // completed-edit sighting shouldn't trigger a second (redundant) local
    // permission prompt if the client has no fs write-through.
    const gatedIds = new Set<string>();
    // The ACP client's decision is authoritative for the visible tool
    // lifecycle. agy can rewrite a rejected status-9 row to completed after
    // the menu closes; never let that late DB state override the rejection.
    const deniedToolIds = new Set<string>();
    let permissionContinuationResolved = false;
    let suppressAssistantMessagesAfterDenial = false;
    const isToolUpdate = (update: SessionUpdate): boolean => {
      const kind = (update as unknown as { sessionUpdate?: string }).sessionUpdate;
      return kind === "tool_call" || kind === "tool_call_update";
    };
    const emitVisibleUpdate = async (update: SessionUpdate): Promise<void> => {
      const raw = update as unknown as {
        sessionUpdate?: string;
        toolCallId?: string;
      };
      if (isToolUpdate(update) && raw.toolCallId && deniedToolIds.has(raw.toolCallId)) {
        return;
      }
      if (
        suppressAssistantMessagesAfterDenial &&
        (raw.sessionUpdate === "agent_message_chunk" || raw.sessionUpdate === "agent_thought_chunk")
      ) {
        return;
      }
      await this.raceTurnCallback(onUpdate(update), deadline);
    };
    const activePtyExit = this.#ptyExit!;
    const timeoutMs = parsePrintTimeoutMs(this.config.printTimeout);
    let deadline = Date.now() + timeoutMs;
    let candidateRevision = -1;
    let seenRevision = -1;
    // A newly spawned TUI first draws its initial idle prompt, then draws
    // another when the submitted turn finishes. A reused TUI only owes the
    // latter marker.
    let requiredIdleMarkerCount = this.#ptyIdleMarkerCount + (freshPty ? 2 : 1);
    let failed = false;
    try {
      while (true) {
        if (this.#cancelled) break;
        const updates = poller.poll();
        if (poller.revision !== seenRevision) {
          seenRevision = poller.revision;
          candidateRevision = poller.turnCompleteCandidate ? poller.revision : -1;
          deadline = Date.now() + timeoutMs;
        } else if (!poller.turnCompleteCandidate) candidateRevision = -1;
        if (Date.now() >= deadline) throw new AgyCliError(`agy interactive turn timed out after ${this.config.printTimeout}; no final idle marker was observed`, [this.config.agyPath], null, this.#ptyOutput);
        for (const [id, markerCount] of gateMarkerCounts) {
          if (this.#ptyPermissionMarkerCount <= markerCount) continue;
          // An identical permission gate can redraw without changing the DB at
          // all. Use the permission-panel-specific redraw as its occurrence
          // signal; a normal progress or completion redraw must not requeue it.
          if (poller.requeuePending(id)) rearmedGateIds.add(id);
          gateMarkerCounts.delete(id);
        }
        const interactions = poller.takePending();
        const reviewIds = new Set(
          interactions
            .filter((interaction) => !interaction.blocked)
            .map((interaction) => String(
              (interaction.update as unknown as { toolCallId?: string }).toolCallId
            ))
            .filter((id) => !requestedEditReview.has(id))
        );
        let stagedFrom = updates.length;
        for (const [index, update] of updates.entries()) {
          const id = (update as unknown as { toolCallId?: string }).toolCallId;
          if (id && reviewIds.has(id)) {
            stagedFrom = Math.min(stagedFrom, index);
          }
        }
        if (stagedFrom < updates.length) {
          for (let index = stagedFrom - 1; index >= 0; index--) {
            if (isToolUpdate(updates[index])) {
              stagedFrom = index + 1;
              break;
            }
            if (index === 0) stagedFrom = 0;
          }
        }
        const stagedUpdates = updates.slice(stagedFrom);
        for (const update of updates.slice(0, stagedFrom)) {
          await emitVisibleUpdate(update);
        }
        if (this.#cancelled) break;
        for (const interaction of interactions) {
          const toolCall = interaction.update;
          const id = String((toolCall as unknown as { toolCallId?: string }).toolCallId);
          if (interaction.blocked) {
            // A single agy run_command step can gate several sequential
            // decisions (each segment of `a && b`, a sandbox escalation, ...):
            // agy records the just-resolved decision in the row's permission
            // column but keeps the step at status 9 until every decision is
            // answered. Content dedup handles ordinary DB updates; a
            // permission-panel redraw explicitly re-arms an identical gate.
            const signature = permissionSignature(interaction.row);
            const rearmed = rearmedGateIds.delete(id);
            if (!rearmed && requestedGate.get(id) === signature) continue;
            requestedGate.set(id, signature);
          } else {
            if (requestedEditReview.has(id)) continue;
            requestedEditReview.add(id);
          }

          if (interaction.blocked) {
            const hasElicitation = Boolean(elicitationCap?.form);
            if (!canBridgeInteraction(interaction.toolName, toolCall, { hasElicitation })) {
              const detail = unsupportedInteractionDetail(interaction.toolName, toolCall, { hasElicitation });
              throw new AgyCliError(
                `Unsupported agy interaction '${interaction.toolName}' (status 9); ${detail}`,
                [this.config.agyPath],
                null,
                this.#ptyOutput
              );
            }
            gatedIds.add(id);

            if (fsBridge && isEditToolCall(toolCall)) {
              // Prime the client's pre-edit snapshot now, while disk still
              // genuinely holds it — agy hasn't written yet. Doing this
              // after the fact (like the ungated path below) would mean
              // reverting disk ourselves and racing the client's own file
              // watcher/open-buffer state, which can silently produce an
              // empty diff if the file is open in the client's editor.
              try {
                await this.raceTurnCallback(primeEditReadThroughClient(toolCall, fsBridge), deadline);
              } catch {
                // best effort
              }
            }

            if (interaction.toolName !== "ask_question" && !await this.waitForPermissionPanel(deadline)) {
              if (this.#cancelled) break;
              throw new AgyCliError(
                "agy permission panel was not observed before requesting permission",
                [this.config.agyPath],
                null,
                this.#ptyOutput
              );
            }

            if (interaction.toolName === "ask_question") {
              const ask = parseAskQuestion(toolCall);
              const count = ask?.questions.length ?? 1;
              for (let qIndex = 0; qIndex < count; qIndex++) {
                const choice = await this.raceTurnCallback(
                  onPermission(toolCall, { toolName: interaction.toolName, questionIndex: qIndex })
                );
                deadline = Date.now() + timeoutMs;
                if (this.#cancelled || choice === "cancelled") { this.#cancelled = true; break; }

                const keys = interactionKeys(choice, interaction.toolName, toolCall, qIndex);
                if (keys == null) {
                  throw new AgyCliError(
                    `Unsupported permission choice '${choice}' for '${interaction.toolName}'`,
                    [this.config.agyPath],
                    null,
                    this.#ptyOutput
                  );
                }
                this.#pty?.write(keys);
                if (choice === "agy-q-skip" || choice.endsWith("-skip")) break;
                if (qIndex < count - 1) {
                  await sleep(50);
                }
              }
            } else {
              const choice = await this.raceTurnCallback(
                onPermission(toolCall, { toolName: interaction.toolName })
              );
              deadline = Date.now() + timeoutMs;
              if (this.#cancelled || choice === "cancelled") { this.#cancelled = true; break; }

              const keys = interactionKeys(choice, interaction.toolName, toolCall);
              if (keys == null) {
                throw new AgyCliError(
                  `Unsupported permission choice '${choice}' for '${interaction.toolName}'`,
                  [this.config.agyPath],
                  null,
                  this.#ptyOutput
                );
              }
              if (!await this.writePermissionKeys(keys, deadline)) break;
              permissionContinuationResolved = true;
              if (normalizePermissionChoice(choice) === "agy-reject-once") {
                deniedToolIds.add(id);
                suppressAssistantMessagesAfterDenial = true;
                await this.raceTurnCallback(onUpdate({
                  ...(toolCall as object),
                  sessionUpdate: "tool_call_update",
                  status: "failed",
                  rawOutput: { message: "Permission denied by ACP client" }
                } as SessionUpdate), deadline);
              }
            }
            gateMarkerCounts.set(id, this.#ptyPermissionMarkerCount);
            // An idle marker printed before the decision cannot mean that the
            // approved/rejected command has finished.
            requiredIdleMarkerCount = this.#ptyIdleMarkerCount + 1;
            continue;
          }

          // Completed edit — either it landed on disk without ever pausing
          // (accept-edits / skip-permissions), or it just passed through the
          // live gate above and agy applied it. Either way, if the client can
          // take the write itself, hand it off so its native diff/review UI
          // (e.g. Zed's Review Changes panel) tracks it.
          //
          // Record what disk holds for the reported paths before any
          // write-through revert/replay, so reconciliation cannot mistake the
          // client's own write (or the intermediate revert) for an unreflected
          // change. Paths whose content this update no longer accounts for are
          // left for reconciliation to report.
          await observeReported(reportedContents(this.config.cwd, toolCall));
          if (this.shouldSkipPermissions()) {
            continue;
          }
          let restored: DiffBlock[] = [];
          try {
            if (fsBridge) {
              const routed = gatedIds.has(id)
                // Pre-edit state was already primed above (race-free) — just
                // hand over the final content, no local revert needed.
                ? await this.raceTurnCallback(writeEditThroughClient(toolCall, fsBridge), deadline)
                // No prior gate — this is the only chance we get, so fall back
                // to revert-then-replay (races the client's file watcher if
                // the file happens to be open there, but it's the best we can
                // do after the fact).
                : await this.raceTurnCallback(routeEditThroughClient(toolCall, fsBridge), deadline);
              if (routed === true) continue;
            }
            if (gatedIds.has(id)) {
              // Already approved through the live gate above and the client
              // has no write-through — nothing more to do here.
              continue;
            }

            // Genuinely ungated (no live agy gate ever asked) and no client
            // write-through available — offer local review: keep is a no-op,
            // reject restores prior text.
            const choice = await this.raceTurnCallback(
              onPermission(toolCall, { toolName: interaction.toolName })
            );
            deadline = Date.now() + timeoutMs;
            if (this.#cancelled || choice === "cancelled") { this.#cancelled = true; break; }
            const rejected = normalizePermissionChoice(choice) === "agy-reject-once";
            if (rejected) {
              restored = revertEditToolCall(toolCall);
              deniedToolIds.add(id);
              suppressAssistantMessagesAfterDenial = true;
              await this.raceTurnCallback(onUpdate({
                ...(toolCall as object),
                sessionUpdate: "tool_call_update",
                status: "failed",
                rawOutput: {
                  message: restored.length > 0
                    ? "Permission denied by ACP client; the already-applied edit was reverted"
                    : "Permission denied by ACP client; the already-applied edit could not be fully reverted"
                }
              } as SessionUpdate), deadline);
            }
          } finally {
            // A reject put the pre-edit text back on disk; that restoration is
            // the answer the client already has, so re-record it rather than
            // reporting it again as an unstructured change. Only the blocks
            // the revert actually restored, and only through the reverse
            // attribution: a diverged block it declined to touch, or an
            // unrelated change next to the edit, still holds content the
            // client has not seen.
            if (restored.length > 0) {
              await observeReported(revertedContents(this.config.cwd, toolCall, restored));
            }
          }
        }
        for (const update of stagedUpdates) {
          await emitVisibleUpdate(update);
        }
        const hasStableFinalEvidence = candidateRevision === poller.revision;
        const hasCompletionSignal =
          this.#ptyIdleMarkerCount >= requiredIdleMarkerCount ||
          permissionContinuationResolved;
        if (hasStableFinalEvidence && hasCompletionSignal) {
          // Background work can finish after the TUI looks idle. Stay on this
          // user turn and keep polling — do not inject a synthetic "continue".
          // Do not re-arm deadline here: only poller revision progress (above)
          // refreshes the timeout, so a missing completion cannot hang forever.
          if (poller.hasActiveBackgroundTasks && !this.#cancelled) {
            const exited = await Promise.race([activePtyExit.then(() => true), sleep(POLL_INTERVAL_MS).then(() => false)]);
            if (exited && !this.#cancelled) throw new AgyCliError(`agy interactive PTY exited unexpectedly: ${this.#ptyOutput.trim() || "<no output>"}`, [this.config.agyPath], null, this.#ptyOutput);
            continue;
          }
          break;
        }
        const exited = await Promise.race([activePtyExit.then(() => true), sleep(POLL_INTERVAL_MS).then(() => false)]);
        if (exited && !this.#cancelled) throw new AgyCliError(`agy interactive PTY exited unexpectedly: ${this.#ptyOutput.trim() || "<no output>"}`, [this.config.agyPath], null, this.#ptyOutput);
      }
      if (editBaseline && !this.#cancelled) {
        // The final idle marker has already proved that agy completed. Do not
        // reuse its inactivity deadline for client notification/write-through.
        await this.reflectUnstructuredEdits(editBaseline, fsBridge, onUpdate);
      }
      return { stopReason: this.#cancelled ? "cancelled" : "end_turn" };
    } catch (error) {
      failed = true;
      await this.stopPty();
      throw error;
    } finally {
      this.#conversationId = poller.conversationId ?? this.#conversationId;
      this.#lastStepIdx = Math.max(this.#lastStepIdx, poller.lastStepIdx);
      this.#lastPromptUserStepIdxs = poller.userStepIdxs;
      poller.close();
      if (this.#cancelled && !failed) await this.stopPty();
    }
  }

  private async raceTurnCallback<T>(callback: Promise<T>, deadline?: number): Promise<T | "cancelled"> {
    const guarded = callback.catch((error) => {
      if (this.#cancelled) return "cancelled" as const;
      throw error;
    });
    if (deadline === undefined) {
      return await Promise.race([guarded, this.#cancelWait.then(() => "cancelled" as const)]);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AgyCliError(`agy interactive turn timed out after ${this.config.printTimeout}; no final idle marker was observed`, [this.config.agyPath], null, this.#ptyOutput)), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([guarded, this.#cancelWait.then(() => "cancelled" as const), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Record the on-disk content of the paths a reported edit covers, so
   * end-of-turn reconciliation only emits changes the client has *not* been
   * told about. Best effort: a snapshot we fail to refresh at worst re-reports
   * a change the client already has, which is preferable to failing the turn.
   * (See {@link ReportedContent} for how divergence is handled.)
   */
  private async observeReported(
    baseline: WorkingTreeSnapshot | null,
    reported: ReportedContent[]
  ): Promise<void> {
    if (!baseline) return;
    try {
      await observeEditedPaths(baseline, reported);
    } catch (error) {
      console.error(`[agy-acp] WARN: could not record reported edit state: ${(error as Error).message}`);
    }
  }

  /**
   * After a turn, diff the working tree against what the client has been told
   * (see {@link observeReportedEdit}) and reflect any change agy made that
   * never surfaced as a recognized structured edit (shell edits, unrecognized
   * payloads) through ACP: emit a synthetic edit update for every client, and
   * additionally hand the write to the client when it advertises fs
   * capabilities. Discovery failures are best-effort (logged); notification
   * failures propagate so the caller does not go idle after a dropped update.
   * Changes that can't be shown as a text diff (binary/oversized/deletions,
   * files whose pre-turn content was never captured) are reported, not
   * dropped (#76).
   */
  private async reflectUnstructuredEdits(
    baseline: WorkingTreeSnapshot,
    fsBridge: ClientFileSystem | undefined,
    onUpdate: (update: SessionUpdate) => Promise<void>
  ): Promise<void> {
    let reflected: Awaited<ReturnType<typeof reconcileWorkingTree>>["reflected"];
    let unsupported: Awaited<ReturnType<typeof reconcileWorkingTree>>["unsupported"];
    try {
      ({ reflected, unsupported } = await reconcileWorkingTree(baseline));
    } catch (error) {
      // Filesystem scan is best-effort — a transient stat failure shouldn't
      // fail the whole turn after agy already finished.
      console.error(`[agy-acp] WARN: working-tree reconciliation failed: ${(error as Error).message}`);
      return;
    }
    // UUID (not a session-local counter): session/load and session/resume rebuild
    // AgyCliSession via startSession, which would reset a counter and reuse IDs.
    const turnToken = randomUUID();
    let index = 0;
    for (const edit of reflected) {
      if (this.#cancelled) return;
      const update = buildReconcileEditUpdate(edit, index++, this.config.cwd, turnToken);
      // Propagate onUpdate / write-through failures: the ordinary update loop
      // does not swallow them, and going idle after a dropped edit update
      // would leave the client inconsistent with disk.
      const delivered = await this.raceTurnCallback(onUpdate(update));
      if (delivered === "cancelled") return;
      if (fsBridge) {
        // routeEditThroughClient swallows RPC errors and returns false — treat
        // that as a hard failure here so we do not report end_turn after a
        // promised client handoff that never completed. Once routing starts it
        // must finish even if cancellation arrives, because it temporarily
        // restores pre-edit text on disk while the client snapshots it.
        const routed = await routeEditThroughClient(update, fsBridge);
        if (routed !== true) {
          throw new Error(
            `client filesystem write-through failed for reconciled edit ${toDisplayPath(edit.path, this.config.cwd)}`
          );
        }
      }
    }
    if (unsupported.length > 0) {
      // One removed ignore rule can expose a whole directory; name a bounded
      // sample instead of a line with thousands of paths on it.
      const named = unsupported
        .slice(0, UNSUPPORTED_DETAIL_LIMIT)
        .map((change) => `${toDisplayPath(change.path, this.config.cwd)} (${change.reason})`)
        .join(", ");
      const rest = unsupported.length - Math.min(unsupported.length, UNSUPPORTED_DETAIL_LIMIT);
      console.error(
        `[agy-acp] WARN: ${unsupported.length} filesystem change(s) not reflected through ACP: ${named}` +
          (rest > 0 ? `, and ${rest} more` : "")
      );
    }
  }

  private async runPromptCommand(
    command: string[],
    prompt: string,
    onUpdate: (update: SessionUpdate) => Promise<void>,
    fsBridge?: ClientFileSystem,
    admissionBoundary?: AgyAdmissionDispatchBoundary
  ): Promise<PromptOutcome> {
    const [program, ...args] = command;

    // Snapshot existing conversation ids *before* spawning, so the file agy
    // creates for a fresh prompt is guaranteed to look "new" once it appears —
    // spawning after the snapshot would risk racing agy's own DB creation.
    const snapshot = this.#conversationId === null ? conversationSnapshot(this.config.conversationsDir) : null;

    // Same working-tree reconciliation as the interactive path: print-mode
    // turns (`--dangerously-skip-permissions`, `--no-interactive-permissions`,
    // etc.) still need shell / unrecognized edits reflected through ACP.
    let editBaseline: WorkingTreeSnapshot | null = null;
    try {
      editBaseline = await snapshotWorkingTree([this.config.cwd, ...this.config.additionalDirectories]);
    } catch {
      editBaseline = null;
    }
    if (this.#cancelled) return { stopReason: "cancelled" };

    let child: SpawnedProcess | undefined;
    let exitPromise: Promise<[number | null, NodeJS.Signals | null]> | undefined;
    let errorPromise: Promise<[NodeJS.ErrnoException]> | undefined;
    const stderrChunks: Buffer[] = [];

    const bindChild = (nextChild: SpawnedProcess): void => {
      child = nextChild;
      exitPromise = waitForExit(nextChild);
      errorPromise = once(nextChild, "error") as Promise<[NodeJS.ErrnoException]>;
      // agy persists its output to its own conversation database; stdout carries
      // nothing we read, but it must still be drained so the child can't block on
      // a full pipe.
      nextChild.stdout.on("data", () => {});
      nextChild.stderr.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    };

    if (admissionBoundary === undefined) {
      const legacyChild = this.startLegacyPrintProcess(command, program, args);
      bindChild(legacyChild);
      // Cancel may have landed in the gap between snapshot and spawn assignment.
      if (this.#cancelled) {
        if (process.platform === "win32") legacyChild.kill();
        else legacyChild.kill("SIGINT");
        return { stopReason: "cancelled" };
      }
    }

    const poller = new StreamPoller({
      dir: this.config.conversationsDir,
      conversationId: this.#conversationId,
      baseStepIdx: this.#lastStepIdx,
      skipNarration: false,
      cwd: this.config.cwd,
      snapshot
    });

    try {
      if (admissionBoundary !== undefined) {
        const dispatch = this.runAdmittedPromptFreeDispatch(prompt, admissionBoundary, bindChild);
        if (dispatch.state !== "active") {
          markAdmissionDispatchAmbiguous(admissionBoundary);
          throw new AgyPromptFreeDispatchError(
            dispatch.state,
            dispatch.state === "blocked" ? dispatch.reason : undefined
          );
        }
        admissionBoundary.afterPromptWrite();
      } else {
        child?.stdin.end(this.config.promptInArgv ? undefined : prompt);
      }

      if (child === undefined || exitPromise === undefined || errorPromise === undefined) {
        throw new AgyPromptFreeDispatchError("blocked", "process_start_failed");
      }

      const pollOnce = async () => {
        for (const update of poller.poll()) {
          await onUpdate(update);
          // Record what disk holds for the reported paths, so end-of-turn
          // reconciliation only reports what the client has *not* been told.
          // Only completed edits: pending/failed lifecycle updates describe
          // proposed content that may never land.
          const rawUpdate = update as unknown as { status?: string };
          if (isEditToolCall(update) && rawUpdate.status === "completed") {
            await this.observeReported(editBaseline, reportedContents(this.config.cwd, update));
          }
        }
      };

      let polling = true;
      let pollReject: ((reason?: unknown) => void) | undefined;
      const pollErrorPromise = new Promise<never>((_, reject) => {
        pollReject = reject;
      });

      const pollLoop = (async () => {
        try {
          while (polling) {
            await pollOnce();
            if (!polling) break;
            await sleep(POLL_INTERVAL_MS);
          }
        } catch (error) {
          pollReject?.(error);
          await this.cancel();
        }
      })();
      pollLoop.catch(() => {});

      const [exitCode] = child.exitCode === null
        ? await Promise.race([
            this.raceProcessError(exitPromise, errorPromise, command),
            pollErrorPromise
          ])
        : [child.exitCode, null];
      polling = false;
      await pollLoop;

      for (let attempt = 0; attempt < TRAILING_POLL_ATTEMPTS; attempt++) {
        await pollOnce();
        if (attempt < TRAILING_POLL_ATTEMPTS - 1) await sleep(TRAILING_POLL_DELAY_MS);
      }

      if (exitCode && !this.#cancelled) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        throw new AgyCliError(
          `agy exited with status ${exitCode}: ${stderr.trim() || "<no stderr>"}`,
          command,
          exitCode,
          stderr
        );
      }

      // Process exit proves provider termination, but DB rows can still lag it
      // and a terminal tool/lifecycle row is not an assistant deliverable.
      // Keep draining this user turn until background work is done and the
      // same completion predicate as interactive mode has a post-tool answer.
      // Re-arm on DB progress, while bounding silence by printTimeout.
      const needsPostExitDrain = () =>
        poller.hasActiveBackgroundTasks ||
        (poller.hadUpdates && !poller.turnCompleteCandidate);
      if (needsPostExitDrain() && !this.#cancelled) {
        const timeoutMs = parsePrintTimeoutMs(this.config.printTimeout);
        let deadline = Date.now() + timeoutMs;
        let seenRevision = poller.revision;
        while (needsPostExitDrain() && !this.#cancelled) {
          if (Date.now() >= deadline) {
            const waitingFor = poller.hasActiveBackgroundTasks
              ? "background tasks to complete and a final assistant message"
              : "a final assistant message after all tool activity";
            throw new AgyCliError(
              `agy print turn timed out after ${this.config.printTimeout} while waiting for ${waitingFor}`,
              command,
              null,
              Buffer.concat(stderrChunks).toString("utf8")
            );
          }
          await sleep(POLL_INTERVAL_MS);
          // pollOnce (not a bare poll) so edits from background tasks are also
          // observed into the reconciliation baseline.
          await pollOnce();
          if (poller.revision !== seenRevision) {
            seenRevision = poller.revision;
            deadline = Date.now() + timeoutMs;
          }
        }
      }

      if (editBaseline && !this.#cancelled) {
        await this.reflectUnstructuredEdits(editBaseline, fsBridge, onUpdate);
      }

      return { stopReason: this.#cancelled ? "cancelled" : "end_turn" };
    } catch (error) {
      if (admissionBoundary !== undefined && child !== undefined && child.exitCode === null) {
        try {
          if (process.platform === "win32") child.kill();
          else child.kill("SIGINT");
        } catch {
          // The coordinator retains recovery debt when termination is unknown.
        }
      }
      throw error;
    } finally {
      this.#conversationId = poller.conversationId ?? this.#conversationId;
      this.#lastStepIdx = Math.max(this.#lastStepIdx, poller.lastStepIdx);
      this.#lastPromptUserStepIdxs = poller.userStepIdxs;
      poller.close();
      if (child !== undefined && this.#process === child) {
        this.#process = undefined;
      }
    }
  }

  private runAdmittedPromptFreeDispatch(
    prompt: string,
    admissionBoundary: AgyAdmissionDispatchBoundary,
    bindChild: (child: SpawnedProcess) => void
  ): AgyDispatchBoundaryResult<SpawnedProcess, PromptFreeDispatchProcessIdentity> {
    const boundary = new AgyPromptFreeDispatchBoundary<SpawnedProcess, PromptFreeDispatchProcessIdentity>(
      prompt,
      {
        requestId: "admission-boundary",
        leaseId: "admission-boundary",
        generation: 0,
        ownerInstanceId: "admission-boundary"
      },
      {
        spawnPromptFree: () => {
          const process = this.startPromptFreeProcessInternal(prompt);
          bindChild(process.child);
          return this.dispatchProcessForPromptFree(process, prompt);
        },
        persistProcessIdentity: (record) => this.persistAdmittedProcessIdentity(admissionBoundary, record),
        recheckCancellation: (record) => this.recheckAdmittedDispatch(admissionBoundary, record),
        commitDispatchIntent: () => commitAdmissionDispatchIntent(admissionBoundary)
      }
    );
    return boundary.run();
  }

  private dispatchProcessForPromptFree(
    process: AgyPromptFreeProcess<SpawnedProcess>,
    prompt: string
  ): AgyDispatchProcess<SpawnedProcess, PromptFreeDispatchProcessIdentity> {
    const processId = process.child.pid;
    return {
      process: process.child,
      identity: Number.isSafeInteger(processId) && processId !== undefined && processId > 0
        ? { pid: processId }
        : null,
      promptChannel: process.promptChannel,
      writeInitialPrompt: (candidatePrompt) => {
        if (candidatePrompt !== prompt) return { status: "ambiguous" };
        return process.writeBusinessPrompt();
      }
    };
  }

  private persistAdmittedProcessIdentity(
    admissionBoundary: AgyAdmissionDispatchBoundary,
    record: AgyDispatchProcessRecord<PromptFreeDispatchProcessIdentity>
  ): AgyDispatchIdentityPersistenceResult {
    try {
      if (record.processIdentity === null) return { status: "not_recorded" };
      admissionBoundary.prepare(record.processIdentity.pid);
      return { status: "recorded" };
    } catch {
      return { status: "not_recorded" };
    }
  }

  private recheckAdmittedDispatch(
    admissionBoundary: AgyAdmissionDispatchBoundary,
    _record: AgyDispatchProcessRecord<PromptFreeDispatchProcessIdentity>
  ): AgyDispatchCancellationRecheck {
    if (this.#cancelled) {
      return { generationMatches: true, ownerMatches: true, cancelled: true };
    }
    try {
      admissionBoundary.beforePromptWrite();
      return { generationMatches: true, ownerMatches: true, cancelled: false };
    } catch {
      return { generationMatches: false, ownerMatches: false, cancelled: true };
    }
  }

  private async raceProcessError<T>(
    promise: Promise<T>,
    errorPromise: Promise<[NodeJS.ErrnoException]>,
    command: string[]
  ): Promise<T> {
    return Promise.race([
      promise,
      errorPromise.then(([error]) => {
        throw this.errorForSpawnFailure(command, error);
      })
    ]);
  }

  private startLegacyPrintProcess(command: string[], program: string, args: string[]): SpawnedProcess {
    try {
      const child = launchAgyProcess(
        this.config.startupLauncher,
        "model_turn",
        () => this.spawnProcess(program, args, this.spawnOptions())
      );
      this.#process = child;
      return child;
    } catch (error) {
      throw this.errorForSpawnFailure(command, error as NodeJS.ErrnoException);
    }
  }

  private shouldInstallAfterError(error: unknown): boolean {
    return this.config.autoInstall &&
      this.config.agyPath === "agy" &&
      error instanceof AgyCliError &&
      error.exitCode === null &&
      isMissingExecutableError(error);
  }

  private async installAgy(): Promise<void> {
    const installed = await ensureAgyInstalled({
      env: this.config.env,
      installBinDir: this.config.installBinDir,
      warn: (message) => console.error(message),
      startupLauncher: this.config.startupLauncher
    });
    if (!installed) {
      throw new AgyCliError(
        "agy executable not found and auto-install failed. Install the Google Antigravity CLI " +
          "or add its directory to PATH.",
        [this.config.agyPath],
        null,
        ""
      );
    }
  }

  private spawnOptions(): SpawnOptions {
    const env = this.spawnEnv();
    return env ? { cwd: this.config.cwd, env } : { cwd: this.config.cwd };
  }

  private verifiedAgyBinaryForPromptFreeProcess(): VerifiedAgyBinary {
    const identity = this.config.verifiedAgyBinary;
    if (identity === undefined) {
      throw new Error("prompt-free process requires a verified identity for the configured agy binary");
    }
    if (!isVerifiedAgyBinary(identity, this.config.agyPath)) {
      throw new Error("prompt-free process requires a verified identity for the configured agy binary");
    }
    return identity;
  }

  /**
   * Prompt-free startup uses an explicit copied environment so an accidental
   * prompt-bearing value cannot be inherited by the child process.
   */
  private promptFreeEnvironment(prompt: string): Record<string, string> {
    const source = this.spawnEnv() ?? process.env;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (
        prompt.length > 0 &&
        (key.includes(prompt) || value?.includes(prompt))
      ) {
        continue;
      }
      if (typeof value === "string") env[key] = value;
    }
    return env;
  }

  private spawnEnv(): NodeJS.ProcessEnv | undefined {
    const baseEnv = this.config.env;
    if (!this.#extraPath) {
      return baseEnv;
    }
    const source = baseEnv ?? process.env;
    const currentPath = source.PATH ?? "";
    const nextPath = currentPath
      ? `${this.#extraPath}${path.delimiter}${currentPath}`
      : this.#extraPath;
    return { ...source, PATH: nextPath };
  }

  private errorForSpawnFailure(command: string[], error: NodeJS.ErrnoException): AgyCliError {
    const executable = command[0];
    if (error.code === "ENOENT") {
      const hint = executable === this.config.agyPath && executable === "agy"
        ? "Install the Google Antigravity CLI or add its directory to PATH."
        : `Check the configured executable path: ${executable}.`;
      return new AgyCliError(`${executable} executable not found. ${hint}`, command, null, error.message);
    }
    return new AgyCliError(`${executable} failed to start: ${error.message}`, command, null, error.message);
  }

  async cancel(): Promise<void> {
    // Always mark cancelled first: a print-mode turn may still be in its
    // pre-spawn working-tree snapshot, or draining background task rows after
    // the child already exited — both loops only check `#cancelled` (the
    // process handle alone is no longer enough to interrupt them).
    this.#cancelled = true;
    if (this.#cancelTurn) {
      this.#cancelTurn();
      // Interactive turns have a PTY to stop. Print turns also have a cancel
      // waiter now, but must continue below and signal their child process.
      if (this.#pty) {
        await this.stopPty();
        return;
      }
    }
    if (this.#pty) {
      await this.stopPty();
      return;
    }
    const child = this.#process;
    if (!child || child.exitCode !== null) {
      return;
    }
    const exitPromise = once(child, "exit");
    // SIGINT (rather than SIGTERM) gives agy a chance to flush its last
    // conversation-database write before exiting. Windows has no real SIGINT,
    // so fall back to an ungraceful kill there.
    if (process.platform === "win32") {
      child.kill();
    } else {
      child.kill("SIGINT");
    }
    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);
    try {
      if (child.exitCode === null) {
        await exitPromise;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async stopPty(): Promise<void> {
    const pty = this.#pty;
    const exit = this.#ptyExit;
    if (this.#ptyPermissionRenderTimer) clearTimeout(this.#ptyPermissionRenderTimer);
    this.#ptyPermissionRenderTimer = undefined;
    this.#ptyPermissionRender = "";
    this.#ptyPermissionMarkerTail = "";
    this.#ptyPermissionPanelVisible = false;
    this.#pty = undefined;
    this.#ptyExit = undefined;
    if (pty) {
      try { pty.kill(); } catch {}
      if (exit) {
        const exited = await Promise.race([exit.then(() => true), sleep(2_000).then(() => false)]);
        if (!exited) {
          try { pty.kill("SIGKILL"); } catch {}
          await Promise.race([exit, sleep(500)]);
        }
      }
    }
  }

  private flushPermissionRender(): void {
    const marker = "Yes, and always allow";
    const output = this.#ptyPermissionMarkerTail + this.#ptyPermissionRender;
    const visible = output.includes(marker);
    this.#ptyPermissionMarkerTail = markerPrefixTail(output, marker);
    if (visible) {
      this.#ptyPermissionMarkerCount++;
      this.#ptyPermissionPanelVisible = true;
    }
    this.#ptyPermissionRender = "";
    this.#ptyPermissionRenderTimer = undefined;
  }

  private async writePermissionKeys(keys: string, deadline: number): Promise<boolean> {
    if (!await this.waitForPermissionPanel(deadline)) {
      if (this.#cancelled) return false;
      throw new AgyCliError(
        "agy permission panel did not settle before applying the permission response",
        [this.config.agyPath],
        null,
        this.#ptyOutput
      );
    }

    const down = "\x1b[B";
    let offset = 0;
    while (keys.startsWith(down, offset)) {
      const renderCount = this.#ptyPermissionMarkerCount;
      this.#pty?.write(down);
      if (!await this.waitForPermissionRenderAfter(renderCount, deadline)) {
        if (this.#cancelled) return false;
        throw new AgyCliError(
          "agy permission panel did not redraw after menu navigation",
          [this.config.agyPath],
          null,
          this.#ptyOutput
        );
      }
      offset += down.length;
    }
    this.#pty?.write(keys.slice(offset));
    return true;
  }

  private async waitForPermissionPanel(deadline: number): Promise<boolean> {
    const expires = Math.min(deadline, Date.now() + PERMISSION_REDRAW_TIMEOUT_MS);
    while (
      (!this.#ptyPermissionPanelVisible || this.#ptyPermissionRenderTimer !== undefined) &&
      !this.#cancelled &&
      Date.now() < expires
    ) {
      await sleep(5);
    }
    return this.#ptyPermissionPanelVisible && this.#ptyPermissionRenderTimer === undefined;
  }

  private async waitForPermissionRenderAfter(renderCount: number, deadline: number): Promise<boolean> {
    const expires = Math.min(deadline, Date.now() + PERMISSION_REDRAW_TIMEOUT_MS);
    while (this.#ptyPermissionMarkerCount <= renderCount && !this.#cancelled && Date.now() < expires) {
      await sleep(5);
    }
    return this.#ptyPermissionMarkerCount > renderCount;
  }

  async close(): Promise<void> {
    await this.cancel();
  }

  private shouldSkipPermissions(): boolean {
    return this.config.skipPermissions || this.config.mode === "dangerously-skip-permissions";
  }

  private shouldUseInteractivePermissions(): boolean {
    return this.config.interactivePermissions && !this.shouldSkipPermissions();
  }
}

function markerPrefixTail(output: string, marker: string): string {
  const max = Math.min(output.length, marker.length - 1);
  for (let length = max; length > 0; length--) {
    const suffix = output.slice(-length);
    if (marker.startsWith(suffix)) return suffix;
  }
  return "";
}

function ptyProcessId(pty: PtyProcess | undefined): number | undefined {
  const pid = (pty as { pid?: unknown } | undefined)?.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function markAdmissionDispatchAmbiguous(boundary: AgyAdmissionDispatchBoundary): void {
  const bridge = boundary as Partial<AgyAdmissionDispatchAmbiguousBridge>;
  if (typeof bridge.markDispatchAmbiguous !== "function") {
    throw new Error("admission prompt boundary cannot mark dispatch ambiguous");
  }
  bridge.markDispatchAmbiguous();
}

function commitAdmissionDispatchIntent(boundary: AgyAdmissionDispatchBoundary): AgyDispatchIntentCommitResult {
  const bridge = boundary as Partial<AgyAdmissionDispatchIntentBridge>;
  if (typeof bridge.commitDispatchIntent !== "function") {
    return { status: "not_committed" };
  }
  try {
    bridge.commitDispatchIntent();
    return { status: "committed" };
  } catch {
    return { status: "not_committed" };
  }
}

export class AgyCliBackend {
  readonly spawnProcess: SpawnFactory;

  readonly ptyFactory?: PtyFactory;
  constructor(spawnProcess: SpawnFactory = defaultSpawnFactory, ptyFactory?: PtyFactory) {
    this.spawnProcess = spawnProcess;
    this.ptyFactory = ptyFactory;
  }

  async startSession(config: AgyCliConfig): Promise<AgyCliSession> {
    return new AgyCliSession(config, this.spawnProcess, this.ptyFactory);
  }

  /**
   * Starts the dispatcher-owned prompt-free stdin primitive without consuming
   * its business-prompt capability. The caller owns persistence, intent, and
   * the sole later write through the returned handle.
   */
  startPromptFreeProcess(
    config: AgyCliConfig,
    businessPrompt: string
  ): AgyPromptFreeProcess<SpawnedProcess> {
    return new AgyCliSession(config, this.spawnProcess, this.ptyFactory)
      .startPromptFreeProcess(businessPrompt);
  }

  async listModels(config: AgyCliConfig): Promise<string[]> {
    const command = [config.agyPath, "models"];
    let child: SpawnedProcess;
    try {
      child = launchAgyProcess(
        config.startupLauncher,
        "auxiliary",
        () => this.spawnProcess(command[0], command.slice(1), { cwd: config.cwd, env: config.env }),
        "child_process"
      );
    } catch (error) {
      throw errorForSpawnFailure(command, error as NodeJS.ErrnoException);
    }
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const exitPromise = waitForExit(child);
    const stdoutDone = once(child.stdout, "end").catch(() => undefined);
    const stderrDone = once(child.stderr, "end").catch(() => undefined);
    const errorPromise = once(child, "error") as Promise<[NodeJS.ErrnoException]>;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, config.modelListTimeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    try {
      const [exitCode] = child.exitCode === null
        ? await raceProcessError(exitPromise, errorPromise, command)
        : [child.exitCode, null];
      if (timedOut) {
        throw new AgyCliError("agy models timed out", command, null, "");
      }
      if (exitCode) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        throw new AgyCliError(
          `agy models exited with status ${exitCode}: ${stderr.trim() || "<no stderr>"}`,
          command,
          exitCode,
          stderr
        );
      }
      await Promise.allSettled([stdoutDone, stderrDone]);
    } finally {
      clearTimeout(timeout);
    }

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    return parseAgyModels(stdout);
  }
}

export function configFromEnv(input: AgyCliConfigInput): AgyCliConfig {
  const env = input.env ?? process.env;
  const argv = input.argv ?? [];

  let sandbox = true;
  if (argv.includes("--no-sandbox")) {
    sandbox = false;
  }
  if (argv.includes("--sandbox")) {
    sandbox = true;
  }

  let mode: SessionModeId = argv.includes("--dangerously-skip-permissions")
    ? "dangerously-skip-permissions"
    : "default";
  const modeFlagIdx = argv.indexOf("--mode");
  if (modeFlagIdx >= 0) {
    const modeArg = argv[modeFlagIdx + 1];
    if (modeArg && isSessionModeId(modeArg)) {
      mode = modeArg;
    }
  }

  const skipPermissions = mode === "dangerously-skip-permissions";
  // Interactive permission forwarding is the normal execution path. The
  // explicit dangerous bypass selects print mode because there is no
  // permission request to forward when agy auto-approves everything.
  const interactiveDisabled = argv.includes("--no-interactive-permissions");
  const interactivePermissions = !skipPermissions && !interactiveDisabled;

  return {
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories ?? [],
    agyPath: optional(env.AGY_BIN) ?? "agy",
    model: undefined,
    effort: undefined,
    mode,
    project: undefined,
    printTimeout: "5m0s",
    sandbox,
    skipPermissions,
    interactivePermissions,
    logFile: undefined,
    promptInArgv: true,
    autoInstall: false,
    installBinDir: defaultInstallBinDir(env),
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    conversationsDir: input.conversationsDir ?? DEFAULT_CONVERSATIONS_DIR,
    env
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnFactory(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export async function defaultPtyFactory(): Promise<PtyFactory> {
  if (process.platform !== "win32") {
    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("node-pty"))));
    const nativeDirs = [
      path.join(packageRoot, "build", "Release"),
      path.join(packageRoot, "build", "Debug"),
      path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`)
    ];
    const nativeDir = nativeDirs.find((dir) => existsSync(path.join(dir, "pty.node")));
    const helper = nativeDir && path.join(nativeDir, "spawn-helper");
    const helperMode = helper && existsSync(helper) ? statSync(helper).mode : undefined;
    if (helper && helperMode !== undefined && (helperMode & 0o111) === 0) {
      // node-pty 1.1.0's npm tarball loses this executable bit on some npm
      // clients. Its native addon invokes the helper directly, so repair the
      // packaged mode before the first spawn.
      try {
        chmodSync(helper, helperMode | 0o111);
      } catch (error) {
        throw new Error(`node-pty spawn-helper is not executable and could not be repaired at ${helper}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const pty = await import("node-pty");
  return { spawn: (command, args, options) => pty.spawn(command, args, { ...options, name: "xterm-256color" }) };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Parse Go duration forms used by agy (for example 5m0s and 30s). */
function parsePrintTimeoutMs(value: string): number {
  const source = value.trim();
  let total = 0;
  let consumed = "";
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    consumed += match[0];
    const scale = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
    total += Number(match[1]) * scale;
  }
  return consumed === source && total > 0 ? total : 5 * 60_000;
}

export function parseAgyModels(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isAgyStatusLine(line));
  return dedupe(lines);
}

function unsupportedInteractionDetail(
  toolName: string,
  toolCall: SessionUpdate,
  options?: { hasElicitation?: boolean }
): string {
  if (toolName === "ask_question") {
    const ask = parseAskQuestion(toolCall);
    if (!ask) return "ask_question payload could not be parsed";
    if (ask.questionCount === 0) return "ask_question has no questions";
    if (ask.questions.some((q) => q.options.length === 0)) return "ask_question has a question with no selectable options";
    return "ask_question could not be bridged";
  }
  return "only standard permission menus (run_command, ask_permission, manage_task, file read/write) and ask_question can be bridged safely";
}

function isAgyStatusLine(line: string): boolean {
  return line === "Fetching available models..." ||
    /^[IWEF]\d{4}\s/.test(line) ||
    line.includes("You are not logged into Antigravity") ||
    line.includes("Failed to") ||
    line.startsWith("error ");
}

function waitForExit(child: SpawnedProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
}

function raceProcessError<T>(
  promise: Promise<T>,
  errorPromise: Promise<[NodeJS.ErrnoException]>,
  command: string[]
): Promise<T> {
  return Promise.race([
    promise,
    errorPromise.then(([error]) => {
      throw errorForSpawnFailure(command, error);
    })
  ]);
}

function errorForSpawnFailure(command: string[], error: NodeJS.ErrnoException): AgyCliError {
  const executable = command[0];
  if (error.code === "ENOENT") {
    return new AgyCliError(`${executable} executable not found. Check the configured executable path: ${executable}.`, command, null, error.message);
  }
  return new AgyCliError(`${executable} failed to start: ${error.message}`, command, null, error.message);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isMissingExecutableError(error: AgyCliError): boolean {
  return error.stderr.includes("ENOENT") || error.message.includes("executable not found");
}
