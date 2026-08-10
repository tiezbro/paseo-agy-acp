export type ProviderFailureCategory =
  | "provider_capacity"
  | "quota"
  | "auth"
  | "permission"
  | "timeout"
  | "transport"
  | "unknown";

export interface ProviderFailureInput {
  httpStatus?: number;
  code?: string;
  reason?: string;
  timeout?: boolean;
}

export interface ClassifiedProviderFailure {
  category: ProviderFailureCategory;
  httpStatus: number | undefined;
  code: string | undefined;
  reason: string | undefined;
}

const SAFE_CODES = new Set([
  "UNAVAILABLE",
  "MODEL_CAPACITY_EXHAUSTED",
  "QUOTA_EXHAUSTED",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED"
]);

/**
 * Classify the few provider signals v2 can safely retain. Unknown source text
 * is deliberately discarded before an event or report can persist it.
 */
export function classifyProviderFailure(input: ProviderFailureInput): ClassifiedProviderFailure {
  const httpStatus = validHttpStatus(input.httpStatus);
  const code = safeSignal(input.code);
  const reason = safeSignal(input.reason);

  if (httpStatus === 503 && (isCapacitySignal(code) || isCapacitySignal(reason))) {
    return classified("provider_capacity", httpStatus, code, reason);
  }
  if (httpStatus === 429 && (code === "QUOTA_EXHAUSTED" || reason === "QUOTA_EXHAUSTED")) {
    return classified("quota", httpStatus, code, reason);
  }
  if (httpStatus === 401 || code === "UNAUTHENTICATED" || reason === "UNAUTHENTICATED") {
    return classified("auth", httpStatus, code, reason);
  }
  if (httpStatus === 403 || code === "PERMISSION_DENIED" || reason === "PERMISSION_DENIED") {
    return classified("permission", httpStatus, code, reason);
  }
  if (httpStatus !== undefined) return classified("transport", httpStatus, undefined, undefined);
  if (input.timeout === true) return classified("timeout", httpStatus, code, reason);
  return classified("unknown", undefined, undefined, undefined);
}

function classified(
  category: ProviderFailureCategory,
  httpStatus: number | undefined,
  code: string | undefined,
  reason: string | undefined
): ClassifiedProviderFailure {
  return { category, httpStatus, code, reason };
}

function validHttpStatus(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value! >= 100 && value! <= 599 ? value : undefined;
}

function safeSignal(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_CODES.has(value) ? value : undefined;
}

function isCapacitySignal(value: string | undefined): boolean {
  return value === "UNAVAILABLE" || value === "MODEL_CAPACITY_EXHAUSTED";
}
