import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentAvailableCommands,
  discoverSkillCommands,
  resolveSkillRoots
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
  it("discovers skills from configured skills.json", () => {
    const ws = tempDir("ws-custom-");
    const customSkillDir = tempDir("custom-skill-target-");
    const skillA = path.join(customSkillDir, "custom-declared-skill");
    mkdirSync(skillA, { recursive: true });
    writeFileSync(
      path.join(skillA, "SKILL.md"),
      `---
name: custom-declared-skill
description: Declared from custom skills.json
---
# Declared Skill
`
    );

    // Create workspace skills.json pointing to customSkillDir
    mkdirSync(path.join(ws, ".agents"), { recursive: true });
    writeFileSync(
      path.join(ws, ".agents/skills.json"),
      JSON.stringify({
        entries: [{ path: customSkillDir }]
      })
    );

    const roots = resolveSkillRoots(ws);
    expect(roots).toContain(customSkillDir);

    const commands = discoverSkillCommands(ws);
    const found = commands.find((c) => c.name === "custom-declared-skill");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Declared from custom skills.json");
  });

  it("falls back to default Antigravity skill paths when unconfigured", () => {
    const ws = tempDir("ws-default-");
    const defaultWsSkills = path.join(ws, ".agents/skills/default-skill");
    mkdirSync(defaultWsSkills, { recursive: true });
    writeFileSync(
      path.join(defaultWsSkills, "SKILL.md"),
      `---
name: default-skill
description: Default location skill
---
`
    );

    const commands = discoverSkillCommands(ws);
    const found = commands.find((c) => c.name === "default-skill");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Default location skill");
  });

  it("augments existing available commands without duplicating", () => {
    const ws = tempDir("ws-merge-");
    const skillA = path.join(ws, ".agents/skills/plan");
    const skillB = path.join(ws, ".agents/skills/extra-skill");
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
