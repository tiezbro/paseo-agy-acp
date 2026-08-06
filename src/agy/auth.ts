// Antigravity CLI authentication helpers for ACP authMethods / authenticate / logout.
//
// Login is interactive (Google AI Pro web code paste, or API key) inside the agy TUI.
// ACP terminal auth launches `agy-acp --login`, which runs interactive `agy` with
// inherited stdio so the user can complete that flow. A background poll watches for
// the resulting keyring login (via `agy models`) and closes the terminal as soon as
// it succeeds, so the user isn't left sitting inside agy's own chat TUI afterward.
// Logout maps to TUI `/logout` via a short-lived PTY, then re-probes with `agy models`.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { AuthMethod as V1AuthMethod } from "@agentclientprotocol/sdk";
import type { AuthMethod as V2AuthMethod } from "@agentclientprotocol/sdk/experimental/v2";
import {
  AgyCliBackend,
  AgyCliError,
  configFromEnv,
  defaultPtyFactory,
  type AgyCliConfig,
  type PtyFactory,
  type PtyProcess
} from "./cli.js";
import { ensureAgyInstalled } from "./installer.js";

/** ACP method id for interactive terminal login (client runs agent binary with --login). */
export const AUTH_METHOD_TERMINAL_LOGIN = "agy-login";

/**
 * `_meta["terminal-auth"]` payload some clients (e.g. Zed, prior to the native
 * `type: "terminal"` auth method stabilizing) look for instead of the native
 * mechanism: `{ label, command, args, env }` describing exactly what to spawn in
 * a terminal. Without this, such clients silently skip opening any terminal at
 * all and just re-call `authenticate`, which can never succeed.
 * `env` is intentionally omitted: the terminal already inherits a normal shell
 * environment, and forwarding this process's full `process.env` over the wire
 * would risk leaking secrets into client logs.
 */
function terminalAuthMeta(): { "terminal-auth": { label: string; command: string; args: string[] } } {
  return {
    "terminal-auth": {
      label: "agy /login",
      command: process.execPath,
      args: [...process.argv.slice(1), "--login"]
    }
  };
}

const NOT_LOGGED_IN_RE = /not logged into antigravity|not logged in|authentication required|please log in|login required/i;
const IDLE_MARKER = "for shortcuts";
/** How often to probe `agy models` in the background during interactive login. */
const LOGIN_POLL_INTERVAL_MS = 3_000;
/** Grace period after SIGTERM before escalating to SIGKILL once login succeeds. */
const LOGIN_KILL_GRACE_MS = 3_000;
const LOGOUT_SETTLE_MS = 1_500;
const LOGOUT_IDLE_TIMEOUT_MS = 20_000;

export function v1AuthMethods(): V1AuthMethod[] {
  return [
    {
      type: "terminal",
      id: AUTH_METHOD_TERMINAL_LOGIN,
      name: "Login",
      description:
        "Opens a terminal to sign in with Google AI Pro (web auth + paste code) or an API key. " +
        "The terminal closes automatically once sign-in succeeds; no need to exit agy yourself.",
      args: ["--login"],
      _meta: terminalAuthMeta()
    }
  ];
}

export function v2AuthMethods(): V2AuthMethod[] {
  return [
    {
      type: "terminal",
      methodId: AUTH_METHOD_TERMINAL_LOGIN,
      name: "Login",
      description:
        "Opens a terminal to sign in with Google AI Pro (web auth + paste code) or an API key. " +
        "The terminal closes automatically once sign-in succeeds; no need to exit agy yourself.",
      args: ["--login"],
      _meta: terminalAuthMeta()
    }
  ];
}

export function isKnownAuthMethodId(methodId: string): boolean {
  return methodId === AUTH_METHOD_TERMINAL_LOGIN;
}

/**
 * User-facing text shown next to the Login method whenever auth is required.
 * Deliberately not agy's raw probe error (exit codes / "<no stderr>" are
 * meaningless to an end user); the real reason is still logged server-side by
 * callers for debugging.
 */
export const AUTH_REQUIRED_MESSAGE = "By continuing, you agree to https://antigravity.google/terms";

/**
 * True when `agy models` succeeds with at least one model.
 * Treats explicit "not logged in" errors as unauthenticated; other failures
 * also count as not ready for sessions (caller surfaces the message).
 */
export async function isAgyAuthenticated(
  backend: AgyCliBackend,
  config: AgyCliConfig
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const models = await backend.listModels(config);
    if (models.length === 0) {
      return { ok: false, reason: "agy models returned no models (sign in may be required)." };
    }
    return { ok: true };
  } catch (error) {
    const reason = formatAuthProbeError(error);
    return { ok: false, reason };
  }
}

export function formatAuthProbeError(error: unknown): string {
  if (error instanceof AgyCliError) {
    const detail = `${error.message}\n${error.stderr}`.trim();
    if (NOT_LOGGED_IN_RE.test(detail)) {
      return "You are not logged into Antigravity.";
    }
    return error.message;
  }
  if (error instanceof Error) {
    if (NOT_LOGGED_IN_RE.test(error.message)) {
      return "You are not logged into Antigravity.";
    }
    return error.message;
  }
  return String(error);
}

export function looksUnauthenticated(reason: string): boolean {
  return NOT_LOGGED_IN_RE.test(reason) || /sign in may be required/i.test(reason);
}

/** Spawns the interactive login child process (default: real `agy`, inherited stdio). */
export type InteractiveLoginSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
) => ChildProcess;

function defaultInteractiveLoginSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): ChildProcess {
  return spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
}

/**
 * Interactive login for `agy-acp --login` (terminal auth method).
 * Runs `agy` with inherited stdio so the user can complete API key or web+code flow.
 *
 * A background poll probes `agy models` every few seconds; once it succeeds, the
 * child is terminated automatically so the caller doesn't need to manually exit
 * agy's own chat TUI to return control to the ACP client. If the child exits on
 * its own first (user quit, or login abandoned), its exit code is returned as-is.
 */
export async function runInteractiveAgyLogin(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv?: string[];
  backend?: AgyCliBackend;
  spawnLogin?: InteractiveLoginSpawn;
  pollIntervalMs?: number;
  killGraceMs?: number;
}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  await ensureAgyInstalled({
    env,
    warn: (message) => console.error(message)
  });

  const config = configFromEnv({ cwd, env, argv: options.argv ?? [] });
  const backend = options.backend ?? new AgyCliBackend();
  const spawnLogin = options.spawnLogin ?? defaultInteractiveLoginSpawn;
  const pollIntervalMs = options.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS;
  const killGraceMs = options.killGraceMs ?? LOGIN_KILL_GRACE_MS;

  const child = spawnLogin(config.agyPath, [], { cwd, env: config.env ?? env });

  let settled = false;
  let autoClosed = false;

  const exitPromise = once(child, "exit").then(([code]) =>
    typeof code === "number" ? code : null
  );

  const pollForCompletion = (async () => {
    while (!settled) {
      await sleep(pollIntervalMs);
      if (settled) return;
      const status = await isAgyAuthenticated(backend, config).catch(
        (): { ok: false; reason: string } => ({ ok: false, reason: "" })
      );
      if (!status.ok || settled) continue;

      autoClosed = true;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      const killedPromptly = await Promise.race([
        once(child, "exit").then(() => true),
        sleep(killGraceMs).then(() => false)
      ]);
      if (!killedPromptly) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }
      return;
    }
  })();

  const exitCode = await exitPromise;
  settled = true;
  pollForCompletion.catch(() => {
    // Background probe may still be mid-flight when the child exits on its
    // own; nothing left to act on once the outer promise has resolved.
  });

  return autoClosed ? 0 : exitCode ?? 1;
}

/**
 * Best-effort logout: start interactive agy, wait for idle UI, send `/logout`, stop.
 * Tokens are stored in the OS keyring by agy; we do not scrape files ourselves.
 */
export async function logoutAgyViaSlashCommand(options: {
  backend: AgyCliBackend;
  config: AgyCliConfig;
  ptyFactory?: PtyFactory;
}): Promise<void> {
  const factory = options.ptyFactory ?? options.backend.ptyFactory ?? (await defaultPtyFactory());
  const env = {
    ...(options.config.env ?? process.env),
    TERM: "xterm-256color"
  };

  let output = "";
  let idleCount = 0;
  let idleTail = "";
  let exited = false;

  const pty: PtyProcess = factory.spawn(options.config.agyPath, [], {
    cwd: options.config.cwd,
    env,
    cols: 120,
    rows: 40
  });

  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    pty.onExit((event) => {
      exited = true;
      resolve({ exitCode: event.exitCode });
    });
  });

  pty.onData((chunk) => {
    output += chunk;
    if (output.length > 64_000) output = output.slice(-32_000);
    const combined = idleTail + chunk;
    const matches = combined.match(new RegExp(IDLE_MARKER, "g"));
    if (matches) idleCount += matches.length;
    idleTail = combined.length > IDLE_MARKER.length ? combined.slice(-IDLE_MARKER.length) : combined;
  });

  const deadline = Date.now() + LOGOUT_IDLE_TIMEOUT_MS;
  while (!exited && idleCount < 1 && Date.now() < deadline) {
    await sleep(50);
  }

  if (!exited) {
    // Bracketed paste is unnecessary for a single-line slash command.
    pty.write("/logout\r");
    await sleep(LOGOUT_SETTLE_MS);
  }

  if (!exited) {
    try {
      pty.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  await Promise.race([exitPromise, sleep(3_000)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
