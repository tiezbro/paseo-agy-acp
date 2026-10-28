import { describe, expect, it } from "vitest";
import { runOfficialKernel } from "../ACP Connector/official-kernel/run.js";

describe("official kernel admission preflight", () => {
  it("rejects invalid enabled admission before resolving the managed kernel", async () => {
    // No AGY_ACP_STATE_DIR: the preflight must fail before the managed kernel is
    // resolved or downloaded, and before a kernel child is spawned.
    await expect(runOfficialKernel({
      env: { AGY_ACP_ADMISSION_ENABLED: "1", PASEO_AGENT_ID: "preflight-agent" },
      version: "test"
    })).rejects.toThrow(/AGY_ACP_STATE_DIR/);
  });
});
