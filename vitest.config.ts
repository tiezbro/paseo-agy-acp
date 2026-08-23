import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    env: {
      PASEO_AGY_ACP_KERNEL: "official",
      PASEO_AGENT_ID: "",
      PASEO_AGENT_CWD: "",
      PASEO_HOME: ""
    }
  }
});