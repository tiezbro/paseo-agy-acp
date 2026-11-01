import type { KernelCompatPatchPlan } from "./kernel-compat-lifecycle.js";

// These exact markers are intentionally small. They carry no copied source context.
export const RC01_KERNEL_COMPAT_PATCH_PLAN: KernelCompatPatchPlan = Object.freeze({
  edits: Object.freeze([
    Object.freeze({
      id: "rc01-model-selection-import",
      target: "modelSelection" as const,
      find: "def _parse_ccpa_response(",
      replacement: "from paseo_model_compat import is_catalog_model\n\ndef _parse_ccpa_response("
    }),
    Object.freeze({
      id: "rc01-model-selection-catalog",
      target: "modelSelection" as const,
      // Official 1.4.5 gates non-Gemini models behind `allow_third_party`, which
      // only JetBrains/Zed/Xcode clients satisfy. The replacement keeps the
      // 1.2.1 profile behavior: Gemini plus the locally supported third-party
      // catalog ids, for every client.
      find: "    if not allow_third_party and not ccpa_id.startswith(\n        _GEMINI_MODEL_ID_PREFIX\n    ):\n",
      replacement: "    if not is_catalog_model(ccpa_id):\n"
    }),
    Object.freeze({
      id: "rc01-proxy-server-import",
      target: "proxyServer" as const,
      find: "from google3.cloud.developer_experience.antigravity_extensions.acp_server import useragent",
      replacement:
        "from google3.cloud.developer_experience.antigravity_extensions.acp_server import useragent\n" +
        "from paseo_model_compat import transform_request"
    }),
    Object.freeze({
      id: "rc01-proxy-server-transform",
      target: "proxyServer" as const,
      find: "    model = match.group(1)\n",
      replacement:
        "    model = match.group(1)\n" +
        "    incoming_json = transform_request(model, incoming_json)\n"
    }),
    Object.freeze({
      id: "skills-tool-presentation",
      target: "proxyAgentConfig" as const,
      // 1.4.5 默认将内置技能写入工作区；改用技能工具保留发现和读取能力。
      find: "    harness_config = super()._build_harness_config()\n",
      replacement:
        "    harness_config = super()._build_harness_config()\n" +
        "    harness_config.skills_config.presentation_mode = localharness_pb2.SkillsConfig.TOOL\n"
    })
  ])
});
