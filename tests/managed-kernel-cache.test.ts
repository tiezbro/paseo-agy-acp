import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureManagedOfficialKernel, managedStableWrapper } from "../ACP Connector/official-kernel/ensure-managed-kernel.js";
import { digestPatchPlan, OfficialKernelCompatLifecycle } from "../ACP Connector/official-kernel/kernel-compat-lifecycle.js";
import { RC01_KERNEL_COMPAT_PATCH_PLAN } from "../ACP Connector/official-kernel/kernel-compat-rc01-recipe.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it.skipIf(process.platform !== "linux" || process.arch !== "x64").each(["current", "old-recipe", "old-skill-recipe", "old-module", "unverified"])("缓存 %s 按当前补丁和模块决定是否重新准备", async state => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kernel-cache-"));
  directories.push(home);
  const wrapper = managedStableWrapper(home);
  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(wrapper, "fixture", "utf8");
  const moduleHash = createHash("sha256").update(await readFile("assets/official-kernel-compat/rc01/paseo_model_compat.py")).digest("hex");
  const previousPlan = { edits: RC01_KERNEL_COMPAT_PATCH_PLAN.edits.filter(edit =>
    state === "old-skill-recipe" ? edit.id !== "skills-tool-presentation" : edit.target !== "modelSelection") };
  const patchHash = digestPatchPlan(state === "old-recipe" || state === "old-skill-recipe" ? previousPlan : RC01_KERNEL_COMPAT_PATCH_PLAN);
  const artifactId = `1.5.2-f472860b79c4-compat-v1-${state === "old-module" ? "000000000000" : moduleHash.slice(0, 12)}-${patchHash.slice(0, 12)}`;
  vi.spyOn(OfficialKernelCompatLifecycle.prototype, "status").mockResolvedValue({
    stateRoot: path.dirname(wrapper), rootExists: true, rootSecure: true, stagingEntries: [], issues: [],
    current: { artifactId, verified: state !== "unverified" }
  });
  // 旧缓存必须进入重新安装路径；用明确失败的下载替身避免访问网络或真实内核。
  const fetchMock = vi.fn().mockRejectedValue(new Error("rebuild-required"));
  vi.stubGlobal("fetch", fetchMock);
  if (state === "current") {
    await expect(ensureManagedOfficialKernel({ HOME: home })).resolves.toBe(wrapper);
    expect(fetchMock).not.toHaveBeenCalled();
  } else {
    await expect(ensureManagedOfficialKernel({ HOME: home })).rejects.toThrow("rebuild-required");
    expect(fetchMock).toHaveBeenCalledOnce();
  }
});
