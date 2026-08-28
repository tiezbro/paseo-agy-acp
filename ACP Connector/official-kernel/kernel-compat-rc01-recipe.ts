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
      find: "if not ccpa_id.startswith(\"gemini\"):",
      replacement: "if not is_catalog_model(ccpa_id):"
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
    })
  ])
});
