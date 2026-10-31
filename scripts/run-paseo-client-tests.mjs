import { spawnSync } from "node:child_process";
import { selectedClientFixtures } from "./paseo-client-versions.mjs";

for (const fixture of selectedClientFixtures()) {
  const suites = ["tests/paseo-client-compat.test.mjs"];
  if (fixture.version === "0.14.0") suites.push("tests/paseo-daemon-compat.test.mjs");
  const result = spawnSync(process.execPath, ["--test", ...suites], {
    stdio: "inherit",
    env: { ...process.env, PASEO_COMPAT_VERSION: fixture.version,
      PASEO_COMPAT_CLIENT_ROOT: process.env.PASEO_COMPAT_CLIENT_ROOT ?? fixture.root }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
