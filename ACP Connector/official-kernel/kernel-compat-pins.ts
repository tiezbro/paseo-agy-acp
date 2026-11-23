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
  profileId: "1.5.2",
  parSha256: "f472860b79c4816a32817e589afdb01cec0ca731e5fa428eae873b14be12387f",
  externalHarnessSha256: "072fc497e7814b0e25a7d80109bceddacd815eb351d2e48ce579a05510e0cfdf",
  targets: Object.freeze({
    modelSelection: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py",
      preimageSha256: "c36b9ecb40e14bdc98a79a3e39c4dbc17a3abcdadf7e615bc37fadf0c15c5edb",
      patchable: true
    }),
    proxyServer: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/ccpa_connection/proxy_server.py",
      preimageSha256: "e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de",
      patchable: true
    }),
    proxyAgentConfig: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/proxy_agent_config.py",
      preimageSha256: "3da378d7aa666c554d01d71f1dbdfbd62ddb86078649cee39ed47802ce160aec",
      patchable: true
    }),
    serverControl: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/server.py",
      preimageSha256: "37b415cf1b299f58f6f574eaf277f0cbe5290e775de502cf9a7d634ec21ca82b",
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
