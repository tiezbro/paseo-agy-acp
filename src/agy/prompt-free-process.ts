import path from "node:path";
import {
  REPO_OWNED_AGY_LAUNCH_RUNNER,
  createAgyLaunchSpecification,
  isVerifiedAgyBinary,
  type AgyLaunchSpecification,
  type VerifiedAgyBinary
} from "./launch-spec.js";

/** The only prompt transport this primitive can create. It is never a PTY proof. */
export type AgyPromptFreeProcessPromptChannel = "stdin";

export type AgyPromptFreeProcessWriteResult =
  | { readonly status: "accepted" }
  | { readonly status: "ambiguous" };

export interface AgyPromptFreeProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Minimum child surface used by the request-scoped primitive. */
export interface AgyPromptFreeProcessChild {
  readonly stdin: {
    write(data: string): boolean;
    end(): unknown;
  };
  /** Forwarded unchanged for the separate identity-only stream-json reader. */
  readonly stdout: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): unknown;
  once(event: "exit", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: () => void): unknown;
}

/**
 * A request-scoped child started with no business prompt in its launch data.
 * The dispatcher owns when to consume writeBusinessPrompt after its durable
 * identity, cancellation, and dispatch-intent checks have succeeded.
 */
export interface AgyPromptFreeProcess<TChild extends AgyPromptFreeProcessChild = AgyPromptFreeProcessChild> {
  readonly child: TChild;
  /** The unparsed child stdout stream; this primitive never subscribes to it. */
  readonly stdout: TChild["stdout"];
  readonly launchSpecification: AgyLaunchSpecification;
  readonly promptChannel: AgyPromptFreeProcessPromptChannel;
  readonly exit: Promise<AgyPromptFreeProcessExit>;
  writeBusinessPrompt(): AgyPromptFreeProcessWriteResult;
  cancel(): void;
}

/**
 * Repository-owned construction inputs. There is deliberately no caller
 * runner, canary observation, retry policy, or persistence callback here.
 */
export interface AgyPromptFreeProcessStartInput<TChild extends AgyPromptFreeProcessChild> {
  readonly verifiedAgyBinary: VerifiedAgyBinary;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly processTitle: string;
  readonly temporaryFilePath: string;
  readonly launcherDiagnostics: readonly string[];
  /** Captured only for the once-only stdin capability and launch leak checks. */
  readonly businessPrompt: string;
  readonly start: (launch: AgyLaunchSpecification) => TChild;
}

const ACCEPTED_WRITE: AgyPromptFreeProcessWriteResult = Object.freeze({ status: "accepted" as const });
const AMBIGUOUS_WRITE: AgyPromptFreeProcessWriteResult = Object.freeze({ status: "ambiguous" as const });

/**
 * Starts an exact verified agy stdin child through the repository-owned launch
 * runner. Startup only creates the child and its write capability: it never
 * writes the prompt, persists dispatch state, retries, or invokes a boundary.
 */
export function startAgyPromptFreeProcess<TChild extends AgyPromptFreeProcessChild>(
  input: AgyPromptFreeProcessStartInput<TChild>
): AgyPromptFreeProcess<TChild> {
  const businessPrompt = requiredPrompt(input.businessPrompt);
  const binary = requiredVerifiedBinary(input.verifiedAgyBinary, input.argv);
  const specification = createAgyLaunchSpecification({
    agyVersion: binary.version,
    launcherFingerprint: binary.launcherFingerprint,
    transport: "stdin",
    argv: input.argv,
    environment: input.environment,
    cwd: input.cwd,
    processTitle: input.processTitle,
    temporaryFilePath: input.temporaryFilePath,
    launcherDiagnostics: input.launcherDiagnostics
  });

  const execution = REPO_OWNED_AGY_LAUNCH_RUNNER.run(
    specification,
    input.start,
    businessPrompt.length === 0 ? [] : [businessPrompt]
  );
  const child = requiredChild(execution.child);
  let childTerminal = child.exitCode !== null;
  const exit = observeExit(child, () => { childTerminal = true; });
  let writeAttempted = false;

  return Object.freeze({
    child,
    stdout: child.stdout,
    launchSpecification: execution.launch,
    promptChannel: "stdin" as const,
    exit,
    writeBusinessPrompt: () => {
      if (writeAttempted || childTerminal || child.exitCode !== null) return AMBIGUOUS_WRITE;
      writeAttempted = true;
      try {
        const accepted = child.stdin.write(businessPrompt);
        try {
          child.stdin.end();
        } catch {
          return AMBIGUOUS_WRITE;
        }
        return accepted === true ? ACCEPTED_WRITE : AMBIGUOUS_WRITE;
      } catch {
        try {
          child.stdin.end();
        } catch {}
        return AMBIGUOUS_WRITE;
      }
    },
    cancel: () => {
      if (child.exitCode !== null) return;
      try {
        if (process.platform === "win32") child.kill();
        else child.kill("SIGINT");
      } catch {}
    }
  });
}

function requiredVerifiedBinary(value: unknown, argv: readonly string[]): VerifiedAgyBinary {
  const executable = requiredExecutable(argv);
  if (!path.isAbsolute(executable) || !isVerifiedAgyBinary(value, executable)) {
    throw new Error("prompt-free process requires an exact verified agy binary");
  }
  return value;
}

function requiredExecutable(argv: readonly string[]): string {
  if (!Array.isArray(argv) || typeof argv[0] !== "string" || argv[0].length === 0) {
    throw new Error("prompt-free process requires an executable argv entry");
  }
  return argv[0];
}

function requiredPrompt(value: unknown): string {
  if (typeof value !== "string") throw new Error("prompt-free process requires a business prompt string");
  return value;
}

function requiredChild<TChild extends AgyPromptFreeProcessChild>(value: TChild): TChild {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.stdin?.write !== "function" ||
    typeof value.stdin?.end !== "function" ||
    typeof value.stdout !== "object" ||
    value.stdout === null ||
    typeof value.kill !== "function" ||
    typeof value.once !== "function" ||
    (value.exitCode !== null && typeof value.exitCode !== "number")
  ) {
    throw new Error("prompt-free process child is invalid");
  }
  return value;
}

function observeExit(
  child: AgyPromptFreeProcessChild,
  onTerminal: () => void
): Promise<AgyPromptFreeProcessExit> {
  if (child.exitCode !== null) return Promise.resolve(Object.freeze({ exitCode: child.exitCode, signal: null }));

  return new Promise((resolve) => {
    let observed = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (observed) return;
      observed = true;
      onTerminal();
      resolve(Object.freeze({ exitCode, signal }));
    };
    child.once("exit", (exitCode, signal) => finish(exitCode, signal));
    // Error details can carry provider-controlled text. The primitive records
    // only that no successful exit was observed, never diagnostic text.
    child.once("error", () => finish(child.exitCode, null));
    if (child.exitCode !== null) finish(child.exitCode, null);
  });
}
