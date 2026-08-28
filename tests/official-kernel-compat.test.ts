import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const compatModule = path.join(
  repositoryRoot,
  "assets",
  "official-kernel-compat",
  "rc01",
  "paseo_model_compat.py"
);
const fixturePath = path.join(repositoryRoot, "tests", "fixtures", "official-kernel-compat", "tool-histories.json");

const PYTHON_RUNNER = String.raw`
import copy
import importlib.util
import json
import sys

module_path, model_id, mode = sys.argv[1:]
spec = importlib.util.spec_from_file_location("paseo_model_compat", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
body = json.load(sys.stdin)
before = copy.deepcopy(body)
result = module.transform_request(model_id, body)
payload = {
    "catalog": module.is_catalog_model(model_id),
    "inputUnchanged": body == before,
    "result": result,
    "sameObject": result is body,
    "supported": sorted(module.SUPPORTED_NON_GEMINI_MODEL_IDS),
}
if mode == "twice":
    first_result = copy.deepcopy(result)
    first_result_object = result
    result = module.transform_request(model_id, result)
    payload["firstResult"] = first_result
    payload["result"] = result
    payload["sameObject"] = result is body
    payload["secondInputUnchanged"] = result == first_result
    payload["secondSameObject"] = result is first_result_object
print(json.dumps(payload, sort_keys=True))
`;

interface TransformResult {
  catalog: boolean;
  inputUnchanged: boolean;
  result: unknown;
  sameObject: boolean;
  supported: string[];
}

interface RepeatedTransformResult extends TransformResult {
  firstResult: unknown;
  secondInputUnchanged: boolean;
  secondSameObject: boolean;
}

function runTransform(modelId: string, body: unknown, mode: "once" | "twice"): unknown {
  const result = spawnSync("python3", ["-B", "-c", PYTHON_RUNNER, compatModule, modelId, mode], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: JSON.stringify(body)
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");

  return JSON.parse(result.stdout) as unknown;
}

function transform(modelId: string, body: unknown): TransformResult {
  return runTransform(modelId, body, "once") as TransformResult;
}

function transformTwice(modelId: string, body: unknown): RepeatedTransformResult {
  return runTransform(modelId, body, "twice") as RepeatedTransformResult;
}

function historyFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

describe("official kernel RC01 model compatibility profile", () => {
  it("keeps Gemini and unknown model requests as exact identity values", () => {
    const body = {
      generationConfig: { maxOutputTokens: 65535, temperature: 0.7 },
      tools: [{ functionDeclarations: [{ name: "read_file", parametersJsonSchema: { type: "object" } }] }]
    };

    const gemini = transform("gemini-2.5-pro", body);
    const unknown = transform("unrecognized-model", body);

    expect(gemini.catalog).toBe(true);
    expect(unknown.catalog).toBe(false);
    expect(gemini.sameObject).toBe(true);
    expect(unknown.sameObject).toBe(true);
    expect(gemini.inputUnchanged).toBe(true);
    expect(unknown.inputUnchanged).toBe(true);
    expect(gemini.result).toEqual(body);
    expect(unknown.result).toEqual(body);
    expect(gemini.supported).toEqual([
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium"
    ]);
  });

  it("clamps valid profile limits and defaults malformed maxOutputTokens values", () => {
    const claudeMissing = transform("claude-sonnet-4-6", {});
    const claudeClamped = transform("claude-opus-4-6-thinking", {
      generationConfig: { maxOutputTokens: 64001, temperature: 0.4 }
    });
    const claudeBoolean = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: true }
    });
    const claudeFalseBoolean = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: false }
    });
    const claudeSmallInteger = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: 17 }
    });
    const claudeInvalidInteger = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: 0 }
    });
    const claudeNegativeInteger = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: -1 }
    });
    const claudeFloatingPoint = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: 1.5 }
    });
    const claudeString = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: "512" }
    });
    const claudeNull = transform("claude-sonnet-4-6", {
      generationConfig: { maxOutputTokens: null }
    });
    const gpt = transform("gpt-oss-120b-medium", {
      generationConfig: { maxOutputTokens: 40000, temperature: 0.2, topP: 0.9 }
    });
    const gptMalformedConfig = transform("gpt-oss-120b-medium", { generationConfig: "invalid" });
    const gptString = transform("gpt-oss-120b-medium", {
      generationConfig: { maxOutputTokens: "512" }
    });
    const gptNull = transform("gpt-oss-120b-medium", {
      generationConfig: { maxOutputTokens: null }
    });

    expect(claudeMissing.sameObject).toBe(true);
    expect(claudeMissing.inputUnchanged).toBe(false);
    expect(claudeMissing.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(claudeClamped.result).toEqual({
      generationConfig: { maxOutputTokens: 64000, temperature: 0.4 }
    });
    expect(claudeBoolean.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(claudeFalseBoolean.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(claudeSmallInteger.result).toEqual({ generationConfig: { maxOutputTokens: 17 } });
    expect(claudeInvalidInteger.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(claudeNegativeInteger.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(claudeFloatingPoint.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(claudeString.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(claudeNull.result).toEqual({ generationConfig: { maxOutputTokens: 64000 } });
    expect(gpt.result).toEqual({ generationConfig: { maxOutputTokens: 32768 } });
    expect(gptMalformedConfig.result).toEqual({ generationConfig: { maxOutputTokens: 32768 } });
    expect(gptString.result).toEqual({ generationConfig: { maxOutputTokens: 32768 } });
    expect(gptNull.result).toEqual({ generationConfig: { maxOutputTokens: 32768 } });
  });

  it("normalizes mixed tool schemas while canonical parameters take precedence", () => {
    const outcome = transform("claude-sonnet-4-6", {
      tools: [
        {
          functionDeclarations: [
            {
              name: "from_json_schema",
              parametersJsonSchema: {
                $schema: "https://example.invalid/top",
                $id: "preserve-this",
                type: "object",
                properties: {
                  nested: {
                    $schema: "https://example.invalid/nested",
                    items: [{ $schema: "https://example.invalid/item", type: "string", x_vendor: true }],
                    type: "array"
                  }
                }
              }
            },
            {
              name: "existing_parameters",
              parameters: {
                $schema: "https://example.invalid/existing",
                additionalProperties: false,
                properties: { count: { $schema: "https://example.invalid/count", type: "integer" } },
                type: "object"
              }
            },
            {
              name: "both_fields",
              parameters: { $schema: "https://example.invalid/obsolete", type: "string" },
              parametersJsonSchema: {
                $schema: "https://example.invalid/replacement",
                properties: { enabled: { $schema: "https://example.invalid/enabled", type: "boolean" } },
                type: "object"
              }
            }
          ]
        },
        { googleSearch: {} }
      ]
    });

    expect(outcome.sameObject).toBe(true);
    expect(outcome.inputUnchanged).toBe(false);
    expect(outcome.result).toEqual({
      generationConfig: { maxOutputTokens: 64000 },
      tools: [
        {
          functionDeclarations: [
            {
              name: "from_json_schema",
              parameters: {
                $id: "preserve-this",
                type: "object",
                properties: { nested: { items: [{ type: "string", x_vendor: true }], type: "array" } }
              }
            },
            {
              name: "existing_parameters",
              parameters: {
                additionalProperties: false,
                properties: { count: { type: "integer" } },
                type: "object"
              }
            },
            {
              name: "both_fields",
              parameters: { type: "string" }
            }
          ]
        },
        { googleSearch: {} }
      ]
    });
  });

  it("pairs full tool histories by name in FIFO order without synthesizing unmatched response IDs", () => {
    const fixture = historyFixture();
    const outcome = transform("claude-opus-4-6-thinking", fixture.mixedHistory);
    const transformed = outcome.result as {
      contents: Array<{
        parts: Array<{
          functionCall?: { id?: string };
          functionResponse?: { id?: string };
        }>;
      }>;
    };

    expect(outcome.sameObject).toBe(true);
    expect(outcome.inputUnchanged).toBe(false);
    expect(transformed.contents[0].parts.map((part) => part.functionCall?.id)).toEqual(["acp-tool-1"]);
    expect(transformed.contents[1].parts.map((part) => part.functionResponse?.id)).toEqual(["acp-tool-1"]);
    expect(transformed.contents[2].parts.map((part) => part.functionCall?.id)).toEqual([
      "acp-tool-2",
      "acp-tool-3",
      "acp-tool-4"
    ]);
    expect(transformed.contents[3].parts.map((part) => part.functionResponse?.id)).toEqual([
      "acp-tool-4",
      "acp-tool-2",
      "acp-tool-3",
      undefined,
      "preserve-unmatched-id"
    ]);
    expect(transformed.contents[3].parts[3].functionResponse).toEqual({
      name: "missing_call",
      response: { contents: "unmatched" }
    });
  });

  it("is deterministic when an already transformed supported request is transformed again", () => {
    const outcome = transformTwice("gpt-oss-120b-medium", {
      generationConfig: { maxOutputTokens: 40000, temperature: 0.2 },
      tools: [
        {
          functionDeclarations: [
            {
              name: "canonical_schema",
              parameters: {
                $schema: "https://example.invalid/canonical",
                properties: { value: { $schema: "https://example.invalid/value", type: "string" } },
                type: "object"
              },
              parametersJsonSchema: { type: "number" }
            }
          ]
        }
      ],
      contents: [
        { role: "model", parts: [{ functionCall: { name: "canonical_schema" } }] },
        { role: "user", parts: [{ functionResponse: { name: "canonical_schema", response: {} } }] }
      ]
    });

    expect(outcome.sameObject).toBe(true);
    expect(outcome.inputUnchanged).toBe(false);
    expect(outcome.secondSameObject).toBe(true);
    expect(outcome.secondInputUnchanged).toBe(true);
    expect(outcome.result).toEqual(outcome.firstResult);
    expect(outcome.result).toEqual({
      generationConfig: { maxOutputTokens: 32768 },
      tools: [
        {
          functionDeclarations: [
            {
              name: "canonical_schema",
              parameters: { properties: { value: { type: "string" } }, type: "object" }
            }
          ]
        }
      ],
      contents: [
        { role: "model", parts: [{ functionCall: { id: "acp-tool-1", name: "canonical_schema" } }] },
        {
          role: "user",
          parts: [{ functionResponse: { id: "acp-tool-1", name: "canonical_schema", response: {} } }]
        }
      ]
    });
  });

  it("does not let an unmatched response ID reserve generated call IDs", () => {
    const fixture = historyFixture();
    const outcome = transform("claude-sonnet-4-6", fixture.unmatchedResponseDoesNotReserveCallIds);
    const transformed = outcome.result as {
      contents: Array<{
        parts: Array<{
          functionCall?: { id?: string };
          functionResponse?: { id?: string };
        }>;
      }>;
    };

    expect(transformed.contents[0].parts[0].functionResponse?.id).toBe("acp-tool-1");
    expect(transformed.contents[1].parts[0].functionCall?.id).toBe("acp-tool-1");
    expect(transformed.contents[2].parts[0].functionResponse?.id).toBe("acp-tool-1");
  });

  it("leaves a response before its same-name call unmatched", () => {
    const fixture = historyFixture();
    const outcome = transform("claude-sonnet-4-6", fixture.responseBeforeCall);
    const transformed = outcome.result as {
      contents: Array<{
        parts: Array<{
          functionCall?: { id?: string };
          functionResponse?: { id?: string };
        }>;
      }>;
    };

    expect(transformed.contents[0].parts[0].functionResponse).toEqual({
      name: "delayed_tool",
      response: { contents: "before" }
    });
    expect(transformed.contents[1].parts[0].functionCall?.id).toBe("acp-tool-1");
    expect(transformed.contents[2].parts[0].functionResponse?.id).toBe("acp-tool-1");
  });
});
