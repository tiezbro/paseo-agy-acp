import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  type ClassifiedProviderFailure,
  type ProviderFailureCategory,
  type ProviderFailureInput
} from "../ACP Connector/admission/errors.js";

type StructuredTerminalCase = {
  name: string;
  input: ProviderFailureInput;
  category: ProviderFailureCategory;
};

const timeoutStates = [false, true] as const;

function signalCases(
  category: ProviderFailureCategory,
  httpStatus: number | undefined,
  signals: readonly string[]
): StructuredTerminalCase[] {
  return signals.flatMap((signal) =>
    (["code", "reason"] as const).flatMap((field) =>
      timeoutStates.map((timeout) => ({
        name: `${httpStatus ?? "no status"} ${signal} in ${field}; timeout=${timeout}`,
        input:
          field === "code"
            ? { httpStatus, code: signal, timeout }
            : { httpStatus, reason: signal, timeout },
        category
      }))
    )
  );
}

function statusCases(category: ProviderFailureCategory, httpStatus: number): StructuredTerminalCase[] {
  return timeoutStates.map((timeout) => ({
    name: `${httpStatus} status; timeout=${timeout}`,
    input: { httpStatus, timeout },
    category
  }));
}

const structuredTerminalCases: StructuredTerminalCase[] = [
  ...signalCases("provider_capacity", 503, ["UNAVAILABLE", "MODEL_CAPACITY_EXHAUSTED"]),
  ...signalCases("quota", 429, ["QUOTA_EXHAUSTED"]),
  ...statusCases("auth", 401),
  ...signalCases("auth", undefined, ["UNAUTHENTICATED"]),
  ...statusCases("permission", 403),
  ...signalCases("permission", undefined, ["PERMISSION_DENIED"])
];

const fallbackCases: Array<{
  name: string;
  input: ProviderFailureInput;
  expected: ClassifiedProviderFailure;
}> = [
  {
    name: "a valid provider transport status",
    input: { httpStatus: 500, timeout: true },
    expected: { category: "transport", httpStatus: 500, code: undefined, reason: undefined }
  },
  {
    name: "only a local timeout",
    input: { timeout: true },
    expected: { category: "timeout", httpStatus: undefined, code: undefined, reason: undefined }
  },
  {
    name: "an invalid status and a local timeout",
    input: { httpStatus: 600, timeout: true },
    expected: { category: "timeout", httpStatus: undefined, code: undefined, reason: undefined }
  }
];

describe("provider failure classification", () => {
  it.each(structuredTerminalCases)("gives $name structured terminal evidence precedence", ({ input, category }) => {
    expect(classifyProviderFailure(input)).toEqual({
      category,
      httpStatus: input.httpStatus,
      code: input.code,
      reason: input.reason
    });
  });

  it.each(fallbackCases)("uses timeout only after $name is absent", ({ input, expected }) => {
    expect(classifyProviderFailure(input)).toEqual(expected);
  });

  it("does not persist unknown raw error text, including when timeout is also set", () => {
    const rawCode = "internal failure: Authorization: Bearer should-not-leak";
    const rawReason = "request body was: secret business prompt";
    const result = classifyProviderFailure({
      httpStatus: 500,
      code: rawCode,
      reason: rawReason,
      timeout: true
    });

    expect(result).toEqual({
      category: "transport",
      httpStatus: 500,
      code: undefined,
      reason: undefined
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawCode);
    expect(serialized).not.toContain(rawReason);
  });
});
