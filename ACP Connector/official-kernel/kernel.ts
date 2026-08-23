export type AcpKernelKind = "official";

const REMOVED_LEGACY_VALUES = new Set(["legacy", "scraper", "pty"]);

export function assertScraperKernelRemoved(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): void {
  const configured = environment.PASEO_AGY_ACP_KERNEL?.trim().toLowerCase();
  if (argv.includes("--legacy-kernel") || (configured !== undefined && REMOVED_LEGACY_VALUES.has(configured))) {
    throw new Error(
      "the PTY/SQLite scraper kernel was removed in 2.1.0.0; official Google ACP is the only kernel. Unset PASEO_AGY_ACP_KERNEL and drop --legacy-kernel."
    );
  }
}

export function resolveAcpKernel(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): AcpKernelKind {
  assertScraperKernelRemoved(environment, argv);
  return "official";
}
