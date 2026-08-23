/** Tested production default. Override with AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS. */
export const DEFAULT_ADMISSION_ACTIVE_TURNS = 8;
/** Tested production default. Override with AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS. */
export const DEFAULT_ADMISSION_CONCURRENT_STARTS = 8;

export function isAllowedAdmissionActiveTurns(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export function isAllowedAdmissionConcurrentStarts(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
