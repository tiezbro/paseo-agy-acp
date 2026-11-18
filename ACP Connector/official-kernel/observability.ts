import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { type JsonRpcId } from "./json-rpc.js";

export type DiagnosticStage = "startup" | "initialize" | "session_setup" | "daemon_context" | "first_kernel_output" | "turn_end" | "turn_cancel" | "turn_fail";

export interface DiagnosticContext {
  readonly requestId?: JsonRpcId;
  readonly sessionId?: string;
  readonly durationMs?: number;
}

/** 默认关闭。仅输出固定字段和散列关联 ID，不接收 prompt、异常正文或 headers。 */
export function createKernelDiagnostics(options: {
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
  now?: () => number;
} = {}) {
  const enabled = options.env?.AGY_ACP_DIAGNOSTICS === "1";
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const write = options.write ?? ((line: string) => { process.stderr.write(line); });
  const correlate = (value: string | number) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
  const event = (stage: DiagnosticStage, context: DiagnosticContext = {}): void => {
    if (!enabled) return;
    const duration = context.durationMs;
    const record = {
      component: "official-kernel", event: stage, elapsedMs: Math.max(0, now() - startedAt),
      ...(context.requestId === undefined ? {} : { request: correlate(context.requestId) }),
      ...(context.sessionId === undefined ? {} : { session: correlate(context.sessionId) }),
      ...(duration === undefined || !Number.isFinite(duration) ? {} : { durationMs: Math.max(0, duration) })
    };
    // 诊断接收端失效不能中断 ACP 请求。
    try { write(`${JSON.stringify(record)}\n`); } catch { /* 诊断是尽力而为。 */ }
  };
  return {
    event,
    start(stage: DiagnosticStage, context: Omit<DiagnosticContext, "durationMs"> = {}) {
      const beginning = now();
      return () => event(stage, { ...context, durationMs: now() - beginning });
    }
  };
}
