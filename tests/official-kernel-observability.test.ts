import { describe, expect, it } from "vitest";
import { createKernelDiagnostics } from "../ACP Connector/official-kernel/observability.js";

describe("kernel diagnostics", () => {
  it("默认关闭且不写入接收端", () => {
    const lines: string[] = [];
    createKernelDiagnostics({ write: line => lines.push(line) }).event("startup");
    expect(lines).toEqual([]);
  });

  it("fake clock 测量真实阶段耗时，只写允许字段和散列 ID", () => {
    let now = 10;
    const lines: string[] = [];
    const diagnostics = createKernelDiagnostics({ env: { AGY_ACP_DIAGNOSTICS: "1" }, now: () => now, write: line => lines.push(line) });
    const finish = diagnostics.start("initialize", { requestId: "secret-request", sessionId: "secret-session" });
    now = 55;
    finish();
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({ component: "official-kernel", event: "initialize", elapsedMs: 45, durationMs: 45 });
    expect(record.request).toMatch(/^[a-f0-9]{16}$/);
    expect(record.session).toMatch(/^[a-f0-9]{16}$/);
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]?.endsWith("\n")).toBe(true);
  });

  it("拒绝非法耗时并隔离诊断写入失败", () => {
    const lines: string[] = [];
    const diagnostics = createKernelDiagnostics({ env: { AGY_ACP_DIAGNOSTICS: "1" }, write: line => lines.push(line) });
    diagnostics.event("turn_fail", { durationMs: NaN });
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("durationMs");
    expect(() => createKernelDiagnostics({ env: { AGY_ACP_DIAGNOSTICS: "1" }, write: () => { throw new Error("closed"); } }).event("startup")).not.toThrow();
  });
});
