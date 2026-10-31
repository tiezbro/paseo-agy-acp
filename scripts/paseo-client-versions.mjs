import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export const clientFixtures = [
  { version: "0.13.2", root: fileURLToPath(new URL("../tests/fixtures/paseo-client/", import.meta.url)) },
  { version: "0.14.0", root: fileURLToPath(new URL("../tests/fixtures/paseo-client-0.14.0/", import.meta.url)) }
];

export function selectedClientFixtures() {
  const version = process.env.PASEO_COMPAT_VERSION;
  if (!version) return clientFixtures;
  const fixture = clientFixtures.find(entry => entry.version === version);
  assert.ok(fixture, "unsupported compatibility version: " + version);
  return [fixture];
}
