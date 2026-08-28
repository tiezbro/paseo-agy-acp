export type KernelCompatTargetName = "modelSelection" | "proxyServer" | "serverControl";

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
  profileId: "rc01",
  parSha256: "46b5925100903a23e0ec7da8b8a218c224494dfffeb3fd30fcd84e91acbc8b07",
  externalHarnessSha256: "8a8d8efc8dcf1f8cb87db6c932957ecf14684cd7d71ee5670b5515c16a685404",
  targets: Object.freeze({
    modelSelection: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py",
      preimageSha256: "2dabcfcbb7e165cdd4fb73e05c08a8b01230837d818f39a0a13cd3cfbca87b71",
      patchable: true
    }),
    proxyServer: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/ccpa_connection/proxy_server.py",
      preimageSha256: "e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de",
      patchable: true
    }),
    serverControl: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/server.py",
      preimageSha256: "8ede74f3cec50e0a76796ef1af91840bab16b7ee36664a2499f07d3119013d7b",
      patchable: false
    })
  })
});

export const KERNEL_COMPAT_TARGET_NAMES: readonly KernelCompatTargetName[] = Object.freeze([
  "modelSelection",
  "proxyServer",
  "serverControl"
]);
