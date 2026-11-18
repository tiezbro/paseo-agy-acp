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
  profileId: "1.5.0",
  parSha256: "8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04",
  externalHarnessSha256: "13dca92307524722a3434cd50baba3f33502d71a24f804f03ee2efbd18b6017d",
  targets: Object.freeze({
    modelSelection: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py",
      preimageSha256: "fe0d0f56986b6c8b795d4576ede929b7043352cb0abc5c64698268f2abd9f6d6",
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
      preimageSha256: "c4a5909af7ba15079309a67012014d071c608ac920ab229f3a2344f21383e4fb",
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
