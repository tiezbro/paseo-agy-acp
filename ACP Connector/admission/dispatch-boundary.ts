/**
 * Request-scoped stdin write fence used by Admission around one official
 * `session/prompt` dispatch. The official kernel owns process creation; this
 * boundary only sequences prepare → write → settle.
 */
export interface AgyAdmissionDispatchBoundary {
  prepare(processId: number): void;
  beforePromptWrite(): void;
  afterPromptWrite(): void;
}

export class AgyCliError extends Error {
  readonly command: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, command: string[], exitCode: number | null, stderr: string) {
    super(message);
    this.name = "AgyCliError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Provider failure proven terminal by the official kernel or a classified 5xx. */
export class AgyTerminalProviderError extends AgyCliError {}
