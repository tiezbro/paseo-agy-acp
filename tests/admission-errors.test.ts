import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "../src/admission/errors.js";

describe("provider failure classification", () => {
  it("preserves recognized capacity and quota evidence as typed outcomes", () => {
    expect(
      classifyProviderFailure({ httpStatus: 503, code: "UNAVAILABLE", reason: "MODEL_CAPACITY_EXHAUSTED" })
    ).toEqual({
      category: "provider_capacity",
      httpStatus: 503,
      code: "UNAVAILABLE",
      reason: "MODEL_CAPACITY_EXHAUSTED"
    });
    expect(classifyProviderFailure({ httpStatus: 429, code: "QUOTA_EXHAUSTED" })).toEqual({
      category: "quota",
      httpStatus: 429,
      code: "QUOTA_EXHAUSTED",
      reason: undefined
    });
  });

  it("does not persist unknown raw error text", () => {
    const result = classifyProviderFailure({
      httpStatus: 500,
      code: "internal failure: Authorization: Bearer should-not-leak",
      reason: "request body was: secret business prompt"
    });

    expect(result).toEqual({
      category: "transport",
      httpStatus: 500,
      code: undefined,
      reason: undefined
    });
    expect(JSON.stringify(result)).not.toContain("should-not-leak");
    expect(JSON.stringify(result)).not.toContain("secret business prompt");
  });

  it("classifies explicit local timeout without inventing a provider result", () => {
    expect(classifyProviderFailure({ timeout: true })).toEqual({
      category: "timeout",
      httpStatus: undefined,
      code: undefined,
      reason: undefined
    });
  });
});
