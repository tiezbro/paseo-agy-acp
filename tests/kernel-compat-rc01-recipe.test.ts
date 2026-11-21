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
  "    if not allow_third_party and not ccpa_id.startswith(",
  "        _GEMINI_MODEL_ID_PREFIX",
  "    ):",
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
const PROXY_AGENT_CONFIG_SOURCE = [
  "class ProxyConnectionStrategy(BaseStrategy):",
  "  def _build_harness_config(self):",
  "    harness_config = super()._build_harness_config()",
  "    return harness_config",
  "  def create_strategy(",
  "      self, *, tool_runner: Any, hook_runner: Any",
  "  ) -> sdk_connection_module.ConnectionStrategy:",
  "    return None",
  ""
].join("\n");
const fixtures: KernelCompatP2Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeKernelCompatP2Fixture(fixture);
});

describe("RC01 official kernel compatibility marker recipe", () => {
  it("refuses a missing step observer marker before publishing a release", async () => {
    const fixture = createKernelCompatP2Fixture({
      modelSource: MODEL_SELECTION_SOURCE,
      proxySource: PROXY_SERVER_SOURCE,
      proxyAgentConfigSource: "class ChangedUpstreamConfig:\n  pass\n"
    });
    fixtures.push(fixture);
    const lifecycle = new OfficialKernelCompatLifecycle({ stateRoot: fixture.stateRoot, pins: fixture.pins });
    await expect(lifecycle.prepare({
      ...fixture.prepareOptions,
      patchPlan: RC01_KERNEL_COMPAT_PATCH_PLAN
    })).rejects.toThrow(/paseo-step-observer in proxyAgentConfig must occur exactly once; found 0/);
  });

  it("applies the frozen proxy and step observer edits to pinned sources", async () => {
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
        find: "    if not allow_third_party and not ccpa_id.startswith(\n        _GEMINI_MODEL_ID_PREFIX\n    ):\n",
        replacement: "    if not is_catalog_model(ccpa_id):\n"
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
      },
      {
        id: "paseo-step-observer",
        target: "proxyAgentConfig",
        find: "  def create_strategy(\n      self, *, tool_runner: Any, hook_runner: Any\n  ) -> sdk_connection_module.ConnectionStrategy:\n",
        replacement:
          "  def create_strategy(\n      self, *, tool_runner: Any, hook_runner: Any\n  ) -> sdk_connection_module.ConnectionStrategy:\n" +
          "    from paseo_model_compat import register_step_observer\n" +
          "    register_step_observer(hook_runner, conversation_id=self.conversation_id)\n"
      }
    ]);

    const serialized = JSON.stringify(RC01_KERNEL_COMPAT_PATCH_PLAN);
    expect(serialized).not.toContain("---");
    expect(serialized).not.toContain("+++");
    expect(serialized).not.toContain("@@");

    const sourceByTarget = {
      modelSelection: MODEL_SELECTION_SOURCE,
      proxyServer: PROXY_SERVER_SOURCE,
      proxyAgentConfig: PROXY_AGENT_CONFIG_SOURCE
    };
    for (const edit of RC01_KERNEL_COMPAT_PATCH_PLAN.edits) {
      expect(exactOccurrences(sourceByTarget[edit.target], edit.find), edit.id).toBe(1);
    }

    const fixture = createKernelCompatP2Fixture({
      modelSource: MODEL_SELECTION_SOURCE,
      proxySource: PROXY_SERVER_SOURCE,
      proxyAgentConfigSource: PROXY_AGENT_CONFIG_SOURCE
    });
    fixtures.push(fixture);
    const lifecycle = new OfficialKernelCompatLifecycle({ stateRoot: fixture.stateRoot, pins: fixture.pins });
    const prepared = await lifecycle.prepare({
      ...fixture.prepareOptions,
      patchPlan: RC01_KERNEL_COMPAT_PATCH_PLAN
    });
    const runfiles = path.join(prepared.releasePath, RUNFILES_DIRECTORY, ACP_SERVER_DIRECTORY);

    expect(readFileSync(path.join(runfiles, "model_selection.py"), "utf8")).toBe([
      "from paseo_model_compat import is_catalog_model", "",
      "def _parse_ccpa_response(ccpa_id):",
      "    if not is_catalog_model(ccpa_id):",
      "        return ccpa_id", "    return None", ""
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
    expect(readFileSync(path.join(runfiles, "proxy_agent_config.py"), "utf8")).not.toContain("presentation_mode");
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
