import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfficialKernelCompatLifecycle } from "../ACP Connector/official-kernel/kernel-compat-lifecycle.js";
import { RC01_KERNEL_COMPAT_PATCH_PLAN } from "../ACP Connector/official-kernel/kernel-compat-rc01-recipe.js";
import {
  createKernelCompatP2Fixture,
  removeKernelCompatP2Fixture,
  type KernelCompatP2Fixture
} from "./kernel-compat-p2-fixture.js";

const ACP_SERVER_DIRECTORY = "google3/cloud/developer_experience/antigravity_extensions/acp_server";
const RUNFILES_DIRECTORY = "agy_acp_server.runfiles";
const MODEL_SELECTION_SOURCE = [
  "def _parse_ccpa_response(ccpa_id):",
  '    if not ccpa_id.startswith("gemini"):',
  "        return ccpa_id",
  "    return None",
  ""
].join("\n");
const PROXY_SERVER_SOURCE = [
  "from google3.cloud.developer_experience.antigravity_extensions.acp_server import useragent",
  "",
  "def _proxy_request(match, incoming_json):",
  "    model = match.group(1)",
  "    return incoming_json",
  ""
].join("\n");
const fixtures: KernelCompatP2Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeKernelCompatP2Fixture(fixture);
});

describe("RC01 official kernel compatibility marker recipe", () => {
  it("is a frozen, minimal four-edit plan that P2 applies to RC01 marker snippets", async () => {
    expect(Object.isFrozen(RC01_KERNEL_COMPAT_PATCH_PLAN)).toBe(true);
    expect(Object.isFrozen(RC01_KERNEL_COMPAT_PATCH_PLAN.edits)).toBe(true);
    expect(RC01_KERNEL_COMPAT_PATCH_PLAN.edits.every((edit) => Object.isFrozen(edit))).toBe(true);
    expect(RC01_KERNEL_COMPAT_PATCH_PLAN.edits).toEqual([
      {
        id: "rc01-model-selection-import",
        target: "modelSelection",
        find: "def _parse_ccpa_response(",
        replacement: "from paseo_model_compat import is_catalog_model\n\ndef _parse_ccpa_response("
      },
      {
        id: "rc01-model-selection-catalog",
        target: "modelSelection",
        find: "if not ccpa_id.startswith(\"gemini\"):",
        replacement: "if not is_catalog_model(ccpa_id):"
      },
      {
        id: "rc01-proxy-server-import",
        target: "proxyServer",
        find: "from google3.cloud.developer_experience.antigravity_extensions.acp_server import useragent",
        replacement:
          "from google3.cloud.developer_experience.antigravity_extensions.acp_server import useragent\n" +
          "from paseo_model_compat import transform_request"
      },
      {
        id: "rc01-proxy-server-transform",
        target: "proxyServer",
        find: "    model = match.group(1)\n",
        replacement:
          "    model = match.group(1)\n" +
          "    incoming_json = transform_request(model, incoming_json)\n"
      }
    ]);

    const serialized = JSON.stringify(RC01_KERNEL_COMPAT_PATCH_PLAN);
    expect(serialized).not.toContain("---");
    expect(serialized).not.toContain("+++");
    expect(serialized).not.toContain("@@");

    const sourceByTarget = {
      modelSelection: MODEL_SELECTION_SOURCE,
      proxyServer: PROXY_SERVER_SOURCE
    };
    for (const edit of RC01_KERNEL_COMPAT_PATCH_PLAN.edits) {
      expect(exactOccurrences(sourceByTarget[edit.target], edit.find), edit.id).toBe(1);
    }

    const fixture = createKernelCompatP2Fixture({
      modelSource: MODEL_SELECTION_SOURCE,
      proxySource: PROXY_SERVER_SOURCE
    });
    fixtures.push(fixture);
    const lifecycle = new OfficialKernelCompatLifecycle({ stateRoot: fixture.stateRoot, pins: fixture.pins });
    const prepared = await lifecycle.prepare({
      ...fixture.prepareOptions,
      patchPlan: RC01_KERNEL_COMPAT_PATCH_PLAN
    });
    const runfiles = path.join(prepared.releasePath, RUNFILES_DIRECTORY, ACP_SERVER_DIRECTORY);

    expect(readFileSync(path.join(runfiles, "model_selection.py"), "utf8")).toBe([
      "from paseo_model_compat import is_catalog_model",
      "",
      "def _parse_ccpa_response(ccpa_id):",
      "    if not is_catalog_model(ccpa_id):",
      "        return ccpa_id",
      "    return None",
      ""
    ].join("\n"));
    expect(readFileSync(path.join(runfiles, "ccpa_connection", "proxy_server.py"), "utf8")).toBe([
      "from google3.cloud.developer_experience.antigravity_extensions.acp_server import useragent",
      "from paseo_model_compat import transform_request",
      "",
      "def _proxy_request(match, incoming_json):",
      "    model = match.group(1)",
      "    incoming_json = transform_request(model, incoming_json)",
      "    return incoming_json",
      ""
    ].join("\n"));
  });
});

function exactOccurrences(source: string, marker: string): number {
  let occurrences = 0;
  let start = 0;
  while (true) {
    const index = source.indexOf(marker, start);
    if (index === -1) return occurrences;
    occurrences += 1;
    start = index + marker.length;
  }
}
