#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { selectedClientFixtures } from "./paseo-client-versions.mjs";

// 安装前只解析数据，验证整个依赖树的来源和摘要；不导入外部包。
for (const entry of selectedClientFixtures()) {
  const fixture = path.resolve(process.argv[2] ?? entry.root);
  const readJson = name => JSON.parse(readFileSync(path.join(fixture, name), "utf8"));
  const manifest = readJson("package.json");
  const lock = readJson("package-lock.json");
  const dependencies = { "@getpaseo/server": entry.version };
  assert.equal(manifest.private, true, "compatibility fixture must be private");
  assert.deepEqual(manifest.dependencies, dependencies, "compatibility version must be exact");
  assert.equal(manifest.scripts, undefined, "fixture must not define lifecycle scripts");
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, dependencies);
  assert.equal(lock.packages["node_modules/@getpaseo/server"].version, entry.version);
  const artifacts = Object.entries(lock.packages).filter(([name]) => name !== "");
  assert.ok(artifacts.length > 0, "dependency lock must not be empty");
  for (const [name, entry] of artifacts) {
    assert.equal(entry.link, undefined, "linked dependencies are forbidden: " + name);
    const url = new URL(entry.resolved);
    assert.equal(url.origin, "https://registry.npmjs.org", "unexpected registry: " + name);
    assert.equal(url.username + url.password + url.search + url.hash, "", "artifact URL must not carry credentials or query data: " + name);
    assert.match(url.pathname, /\.tgz$/, "artifact must be a registry tarball: " + name);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "SHA-512 integrity is required: " + name);
    assert.equal(Buffer.from(entry.integrity.slice(7), "base64").length, 64);
  }
  assert.equal(readFileSync(path.join(fixture, ".npmrc"), "utf8"),
    "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n",
    "fixture npm policy must keep installation scripts disabled");
  console.log("compatibility lock " + entry.version + ": PASS (" + artifacts.length + " registry artifacts; SHA-512; install hooks disabled)");
}
