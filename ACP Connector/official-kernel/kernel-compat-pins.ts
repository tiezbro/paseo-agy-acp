export type KernelCompatTargetName = "modelSelection" | "proxyServer" | "proxyAgentConfig" | "serverControl";

export interface KernelCompatTargetPin {
  readonly relativePath: string;
  readonly preimageSha256: string;
  readonly patchable: boolean;
}

export interface KernelCompatPins {
  readonly profileId: string;
  readonly parSha256: string;
  readonly externalHarnessSha256: string;
  readonly targets: Readonly<Record<KernelCompatTargetName, KernelCompatTargetPin>>;
}

// These are public integrity pins, not bundled Google artifacts or source context.
export const PRODUCTION_KERNEL_COMPAT_PINS: KernelCompatPins = Object.freeze({
  profileId: "1.4.5",
  parSha256: "7e7019c8989ca066cbac4d6580552b7a4ad39485dd6b6fd81de9daa9a7b39042",
  externalHarnessSha256: "6c6d28b61a704e9bae4351ea8c4ad4b8b0aba7e1f1027bdf1017401b9c6e18c0",
  targets: Object.freeze({
    modelSelection: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py",
      preimageSha256: "c24afed84c4291fcf24bc9932a6c7e42b52c296addeb13d0a3aab6e32e120fe7",
      patchable: true
    }),
    proxyServer: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/ccpa_connection/proxy_server.py",
      preimageSha256: "e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de",
      patchable: true
    }),
    proxyAgentConfig: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/proxy_agent_config.py",
      preimageSha256: "3a7ca6fa8937c67fa27c54f42ce66095687b735898536afc32e0dc970c4ae182",
      patchable: true
    }),
    serverControl: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/server.py",
      preimageSha256: "9f1c1b8dc8b452cdd12bd15ff10d5da7226d55c05f0478047baf226e03bb95bb",
      patchable: false
    })
  })
});

export const KERNEL_COMPAT_TARGET_NAMES: readonly KernelCompatTargetName[] = Object.freeze([
  "modelSelection",
  "proxyServer",
  "proxyAgentConfig",
  "serverControl"
]);
