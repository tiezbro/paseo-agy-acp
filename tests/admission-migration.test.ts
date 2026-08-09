import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectLegacySessionStore,
  LegacyStatePreflightError
} from "../src/admission/migration.js";

const stateDirs: string[] = [];

function stateFile(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-migration-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "sessions.json");
}

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("legacy session preflight", () => {
  it("accepts a missing legacy store without inventing sessions", () => {
    expect(inspectLegacySessionStore(stateFile())).toEqual({ status: "absent", sessions: [] });
  });

  it("normalizes a valid legacy session without retaining the raw disk object", () => {
    const file = stateFile();
    writeFileSync(
      file,
      JSON.stringify({
        sessions: {
          "session-1": {
            cwd: "/work/project",
            workspaces: ["/work/project", "/work/shared"],
            conversationId: "conversation-1",
            lastStepIdx: 42,
            modelId: "claude-opus-4-6-thinking",
            reasoningEffect: "high",
            mode: "dangerously-skip-permissions",
            v2UserMessageIdsByStep: { "42": "message-42" },
            updatedAt: "2026-08-09T00:00:00.000Z"
          }
        }
      })
    );

    expect(inspectLegacySessionStore(file)).toEqual({
      status: "valid",
      sessions: [
        {
          sessionId: "session-1",
          cwd: "/work/project",
          additionalDirectories: ["/work/shared"],
          conversationId: "conversation-1",
          lastStepIdx: 42,
          model: "claude-opus-4-6-thinking",
          reasoningEffort: "high",
          mode: "dangerously-skip-permissions",
          v2UserMessageIdsByStep: { "42": "message-42" },
          updatedAt: "2026-08-09T00:00:00.000Z"
        }
      ]
    });
  });

  it("rejects malformed or structurally invalid legacy state instead of treating it as empty", () => {
    const malformed = stateFile();
    writeFileSync(malformed, "{not json");
    expect(() => inspectLegacySessionStore(malformed)).toThrow(LegacyStatePreflightError);

    const invalid = stateFile();
    writeFileSync(invalid, JSON.stringify({ sessions: { "session-1": { cwd: 42 } } }));
    expect(() => inspectLegacySessionStore(invalid)).toThrow(/cwd/);
  });
});
