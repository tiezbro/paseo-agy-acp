import type { KernelCompatPatchPlan } from "./kernel-compat-lifecycle.js";

// These exact markers are intentionally small. They carry no copied source context.
export const RC01_KERNEL_COMPAT_PATCH_PLAN: KernelCompatPatchPlan = Object.freeze({
  edits: Object.freeze([
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
