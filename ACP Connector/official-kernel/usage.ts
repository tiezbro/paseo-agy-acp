import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { ensureManagedOfficialKernel } from "./ensure-managed-kernel.js";
import { spawnOfficialKernel } from "./spawn.js";
import { isRecord } from "./json-rpc.js";

export interface QuotaWindow {
  id: string;
  label: string;
  shortLabel: string;
  summary: boolean;
  remainingPct: number | null;
  usedPct: number | null;
  resetsAt: string | null;
  durationSeconds?: number;
}

export type QuotaReport =
  | { status: "available"; windows: QuotaWindow[] }
  | { status: "unavailable"; problem: { kind: "no_quota"; detail: string } };

/** 只解析官方 ACP /usage 的额度段；不把会话 token 数当成账号额度。 */
export function parseAcpQuota(text: string): QuotaReport {
  const section = text.split("### Quota Limits")[1];
  if (section === undefined) throw new Error("ACP /usage 未返回可识别的额度信息");
  if (section.includes("Unable to retrieve quota status")) throw new Error("ACP 内核查询账号额度失败，请检查 ACP 登录状态或稍后刷新");
  const windows: QuotaWindow[] = [];
  let group = "";
  for (const line of section.split(/\r?\n/)) {
    if (/^###\s/.test(line)) break;
    const heading = /^- \*\*(.+)\*\*\s*$/.exec(line);
    if (heading) { group = heading[1].trim(); continue; }
    const bucket = /^\s{2}- \*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (!bucket || !group) continue;
    const [, name, value] = bucket;
    const fraction = /^(\d+(?:\.\d+)?)% remaining\b/.exec(value);
    const disabled = /^Disabled\b/.test(value);
    if (!fraction && !disabled) continue;
    const remaining = disabled ? null : Number(fraction![1]);
    if (remaining !== null && (remaining < 0 || remaining > 100)) throw new Error("ACP 额度百分比超出范围");
    const reset = /\(resets ([^)]+)\)/.exec(value)?.[1];
    const resetMs = reset === undefined ? NaN : Date.parse(reset);
    const weekly = /weekly/i.test(name);
    const fiveHour = /(?:5\s*(?:h|hour)|five\s+hour)/i.test(name);
    const period = weekly ? "Weekly" : fiveHour ? "5h" : name;
    const groupLabel = group.replace(/\s+models$/i, "");
    const id = `${group}:${name}`;
    if (windows.some(window => window.id === id)) throw new Error("ACP 额度窗口标识重复");
    windows.push({ id, label: `${groupLabel} · ${period}${disabled ? " · Disabled" : ""}`,
      shortLabel: `${groupLabel} ${weekly ? "wk" : period}`, summary: weekly && !disabled,
      remainingPct: remaining, usedPct: remaining === null ? null : 100 - remaining,
      resetsAt: Number.isFinite(resetMs) && !disabled ? new Date(resetMs).toISOString() : null,
      ...(weekly ? { durationSeconds: 604800 } : fiveHour ? { durationSeconds: 18000 } : {}) });
  }
  if (windows.length) return { status: "available", windows };
  return { status: "unavailable", problem: { kind: "no_quota", detail: "ACP 当前认证方式未提供可展示的百分比额度" } };
}

/** 独立短会话直接连接 ACP 内核，沿用其登录态，不经 CLI 或业务 prompt 改写。 */
export async function queryOfficialQuota(environment: NodeJS.ProcessEnv, timeoutMs = 16_000): Promise<QuotaReport> {
  const binary = await ensureManagedOfficialKernel(environment);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-acp-quota-"));
  try {
    const child = spawnOfficialKernel({ ...environment, PASEO_AGY_ACP_OFFICIAL_BIN: binary });
    // 查询错误只返回固定提示，避免把内核认证日志或路径带到额度面板。
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let nextId = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const commands = new Map<string, boolean>();
    let notifyCommands: (() => void) | undefined;
    let sessionId: string | undefined;
    let output = "";
    let collecting = false;
    let failed: Error | undefined;
    const fail = (error: Error): void => {
      failed = error;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      notifyCommands?.();
    };
    const timer = setTimeout(() => fail(new Error("ACP 额度查询超时")), timeoutMs);
    child.on("error", () => fail(new Error("ACP 额度内核无法启动")));
    child.on("exit", () => fail(new Error("ACP 额度内核提前退出")));
    child.stdin.on("error", () => fail(new Error("ACP 额度连接已关闭")));
    lines.on("line", line => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!isRecord(message)) return;
      if (typeof message.id === "number" && pending.has(message.id) && !("method" in message)) {
        const request = pending.get(message.id)!;
        pending.delete(message.id);
        if ("error" in message) request.reject(new Error("ACP 拒绝额度查询，请检查 ACP 登录状态和内核版本"));
        else request.resolve(message.result);
      } else if (message.method === "session/update" && isRecord(message.params)) {
        const params = message.params;
        const update = params.update;
        if (typeof params.sessionId !== "string" || !isRecord(update)) return;
        if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
          commands.set(params.sessionId, update.availableCommands.some(command => isRecord(command) && command.name === "usage"));
          notifyCommands?.();
        }
        if (collecting && params.sessionId === sessionId && update.sessionUpdate === "agent_message_chunk" &&
            isRecord(update.content) && update.content.type === "text" && typeof update.content.text === "string") {
          output += update.content.text;
          if (output.length > 1024 * 1024) fail(new Error("ACP 额度响应过大"));
        }
      } else if ("id" in message && "method" in message) {
        // 不允许查询会话访问文件、执行工具或申请权限。
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Quota query client does not support tools" } }) + "\n");
      }
    });
    const request = (method: string, params: unknown): Promise<unknown> => {
      if (failed) return Promise.reject(failed);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };
    try {
      await request("initialize", { protocolVersion: 1, clientInfo: { name: "paseo-agy-acp-quota", version: "1" }, clientCapabilities: {} });
      const session = await request("session/new", { cwd: directory, mcpServers: [] });
      if (!isRecord(session) || typeof session.sessionId !== "string") throw new Error("ACP 未返回额度会话");
      sessionId = session.sessionId;
      if (!commands.has(sessionId)) await new Promise<void>(resolve => { notifyCommands = resolve; });
      if (failed) throw failed;
      // 必须先看见内核声明 /usage，防止旧版本把查询误当成模型请求。
      if (!commands.get(sessionId)) throw new Error("ACP 内核未声明 /usage 命令，请升级内核");
      collecting = true;
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/usage" }] });
      if (!isRecord(result) || result.stopReason !== "end_turn") throw new Error("ACP 额度查询未正常完成");
      return parseAcpQuota(output);
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>(resolve => {
          const killTimer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
          child.once("exit", () => { clearTimeout(killTimer); resolve(); });
        });
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
