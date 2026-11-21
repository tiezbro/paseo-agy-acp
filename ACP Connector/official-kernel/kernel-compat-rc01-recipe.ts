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
      // 仅保留上游实际提供且兼容层支持的模型；后续 disabled 检查不变。
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
      // 内核默认向工作区写入内置技能；通过工具呈现，保留发现与读取能力。
      find: "    harness_config = super()._build_harness_config()\n",
      replacement:
        "    harness_config = super()._build_harness_config()\n" +
        "    harness_config.skills_config.presentation_mode = localharness_pb2.SkillsConfig.TOOL\n"
    }),
    Object.freeze({
      id: "paseo-step-observer",
      target: "proxyAgentConfig" as const,
      // 只读 SDK 观察器；上报 SYSTEM error 的 HTTP 状态与 harness 重试决策，
      // 不改内核流程。会话 ID 用于把 stderr 源绑定到这一条连接。
      find: "  def create_strategy(\n      self, *, tool_runner: Any, hook_runner: Any\n  ) -> sdk_connection_module.ConnectionStrategy:\n",
      replacement:
        "  def create_strategy(\n      self, *, tool_runner: Any, hook_runner: Any\n  ) -> sdk_connection_module.ConnectionStrategy:\n" +
        "    from paseo_model_compat import register_step_observer\n" +
        "    register_step_observer(hook_runner, conversation_id=self.conversation_id)\n"
    })
  ])
});
