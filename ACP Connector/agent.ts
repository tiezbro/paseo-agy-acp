// Public package entrypoint for the ACP Connector module.

export {
  PRODUCT_AGENT_NAME,
  PRODUCT_AGENT_TITLE,
  overlayProductIdentity
} from "./official-kernel/identity.js";
export { resolveAcpKernel } from "./official-kernel/kernel.js";
export { runOfficialLogin } from "./official-kernel/login.js";
export { runOfficialKernel } from "./official-kernel/run.js";
