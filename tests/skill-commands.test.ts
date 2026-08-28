import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentAvailableCommands,
  discoverSkillCommands
} from "../ACP Connector/official-kernel/skill-commands.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe("Skill Commands Discovery", () => {
  it("discovers skills from workspace skills directory", () => {
    const ws = tempDir("ws-skills-");
    const codexSkills = path.join(ws, ".codex/skills");
    const skillA = path.join(codexSkills, "my-skill");
    mkdirSync(skillA, { recursive: true });
    writeFileSync(
      path.join(skillA, "SKILL.md"),
      `---
name: my-skill
description: Custom test skill
---
# My Skill
`
    );

    const commands = discoverSkillCommands(ws);
    const found = commands.find((c) => c.name === "my-skill");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Custom test skill");
  });

  it("augments existing available commands without duplicating", () => {
    const ws = tempDir("ws-skills-");
    const codexSkills = path.join(ws, ".codex/skills");
    const skillA = path.join(codexSkills, "plan");
    const skillB = path.join(codexSkills, "extra-skill");
    mkdirSync(skillA, { recursive: true });
    mkdirSync(skillB, { recursive: true });
    writeFileSync(
      path.join(skillA, "SKILL.md"),
      `---\nname: plan\ndescription: Custom plan override\n---\n`
    );
    writeFileSync(
      path.join(skillB, "SKILL.md"),
      `---\nname: extra-skill\ndescription: Extra skill description\n---\n`
    );

    const initial = [{ name: "plan", description: "Official plan" }];
    const augmented = augmentAvailableCommands(initial, ws);

    // Initial commands are preserved and not overridden
    expect(augmented.find((c) => c.name === "plan")?.description).toBe("Official plan");
    // Extra skills are appended
    expect(augmented.find((c) => c.name === "extra-skill")?.description).toBe(
      "Extra skill description"
    );
  });
});
