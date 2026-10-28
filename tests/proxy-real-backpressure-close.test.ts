import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { AdmissionRuntime } from "../ACP Connector/admission/runtime.js";
import { AdmissionTurnCoordinator } from "../ACP Connector/admission/turn-coordinator.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";

const fixture = fileURLToPath(new URL("./helpers/fake-backpressure-kernel.mjs", import.meta.url));

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}：真实 pipe 关闭超时`)), 3_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

it.skipIf(process.platform !== "linux").each(["close", "EOF", "child SIGTERM"])("真实 child stdout 背压暂停后 %s 仍完成 close 和全部资源清理", async mode => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "real-pipe-close-"));
  const coordinatorClose = vi.spyOn(AdmissionTurnCoordinator.prototype, "close");
  const runtimeClose = vi.spyOn(AdmissionRuntime.prototype, "close");
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const input = new PassThrough();
  let blocking = false;
  let held: (() => void) | undefined;
  let url = "";
  let sessionReady!: () => void;
  const ready = new Promise<void>(resolve => { sessionReady = resolve; });
  const parse = createNdjsonParser(message => {
    if ("result" in message) {
      const result = message.result as { received: { mcpServers: Array<{ name: string; url: string }> } };
      url = result.received.mcpServers.find(server => server.name === "paseo_skills")!.url;
      sessionReady();
    }
  });
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    if (blocking) held = callback;
    else { parse(chunk); callback(); }
  } });
  const proxy = new OfficialKernelProxy({ child, stdin: input, stdout: output, version: "test", env: {
    HOME: directory, PASEO_AGENT_ID: "backpressure-agent", AGY_ACP_ADMISSION_ENABLED: "1", AGY_ACP_STATE_DIR: path.join(directory, "state")
  } });
  let childClosed = false;
  child.once("close", () => { childClosed = true; });
  const running = proxy.start();
  void running.catch(() => {});
  try {
    input.write(encodeNdjson({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: directory } }));
    await bounded(ready, "建立会话");
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).ok).toBe(true);
    blocking = true;
    input.write(encodeNdjson({ jsonrpc: "2.0", method: "test/flood" }));
    await vi.waitFor(() => {
      expect(held).toBeTypeOf("function");
      expect(child.stdout.isPaused()).toBe(true);
      expect(child.stdout.readableLength).toBeGreaterThan(0);
    });
    if (mode === "close") proxy.close();
    else if (mode === "EOF") input.end();
    else child.kill("SIGTERM");
    // 故意不恢复 client drain：start 只有真正 child close、MCP/Admission 清理后才能完成。
    // 外部 SIGTERM 可截断尾帧而报协议错误；主动 close/EOF 则应正常完成。
    await bounded(mode === "child SIGTERM" ? running.then(() => undefined, () => undefined) : running, mode);
    expect(childClosed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
    expect(coordinatorClose).toHaveBeenCalledTimes(1);
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    await expect(fetch(url, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  } finally {
    // 失败路径才恢复 pipe，避免旧版本复现让测试进程永久挂起。
    blocking = false;
    held?.();
    child.stdout.resume();
    child.kill("SIGKILL");
    input.end();
    try { await bounded(running.catch(() => {}), "测试清理"); }
    finally {
      coordinatorClose.mockRestore(); runtimeClose.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

it.skipIf(process.platform !== "linux")("真实 adapter 收到 SIGTERM 后退出，即使 client 永远不 drain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "adapter-signal-close-"));
  const kernel = path.join(directory, "fake-kernel.mjs");
  await copyFile(fixture, kernel);
  await chmod(kernel, 0o755);
  const harness = fileURLToPath(new URL("./helpers/run-backpressure-adapter.mjs", import.meta.url));
  const runModule = new URL("../dist/ACP%20Connector/official-kernel/run.js", import.meta.url).href;
  const adapter = spawn(process.execPath, [harness, runModule], { detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: {
    ...process.env, HOME: directory, PASEO_HOME: directory, PASEO_AGENT_ID: "signal-agent",
    PASEO_AGY_ACP_OFFICIAL_BIN: kernel, AGY_ACP_ADMISSION_ENABLED: "1", AGY_ACP_STATE_DIR: path.join(directory, "state")
  } });
  adapter.stdout!.resume(); adapter.stderr!.resume();
  const exited = once(adapter, "exit");
  const messages = new Map<string, { event: string; url?: string }>();
  const waiters = new Map<string, (message: { event: string; url?: string }) => void>();
  adapter.on("message", message => {
    const event = message as { event: string; url?: string };
    messages.set(event.event, event);
    waiters.get(event.event)?.(event);
  });
  const waitFor = (event: string) => bounded(messages.has(event) ? Promise.resolve(messages.get(event)!) :
    new Promise<{ event: string; url?: string }>(resolve => waiters.set(event, resolve)), `adapter ${event}`);
  try {
    adapter.stdin!.write(encodeNdjson({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: directory } }));
    const session = await waitFor("session");
    expect((await fetch(session.url!, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).ok).toBe(true);
    adapter.stdin!.write(encodeNdjson({ jsonrpc: "2.0", method: "test/flood" }));
    await waitFor("blocked");
    adapter.kill("SIGTERM");
    await waitFor("cleaned");
    const [code, signal] = await bounded(exited, "adapter exit");
    expect(code).toBe(0); expect(signal).toBeNull();
    expect(messages.has("failed")).toBe(false);
    await expect(fetch(session.url!, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  } finally {
    if (adapter.exitCode === null && adapter.signalCode === null && adapter.pid !== undefined) {
      // 只终止本测试新建的独立进程组，避免失败时遗留 fixture 内核。
      try { process.kill(-adapter.pid, "SIGKILL"); } catch { /* 进程可能刚好退出。 */ }
    }
    await bounded(exited.catch(() => []), "adapter 测试清理");
    await rm(directory, { recursive: true, force: true });
  }
});
