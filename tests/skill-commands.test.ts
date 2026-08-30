import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentAvailableCommands,
  discoverSkillCommands,
  parseFrontmatter,
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

describe("Frontmatter Parsing", () => {
  it("parses unquoted, double-quoted, and single-quoted fields cleanly without escape artifacts", () => {
    const content = `---
name: "my-skill"
description: "\\"Review this PR\\""
---
# Skill body`;
    const parsed = parseFrontmatter(content);
    expect(parsed.name).toBe("my-skill");
    expect(parsed.description).toBe('"Review this PR"');
  });

  it("parses single-quoted strings and escaped single quotes", () => {
    const content = `---
name: 'quote-skill'
description: 'Don''t miss this'
---`;
    const parsed = parseFrontmatter(content);
    expect(parsed.name).toBe("quote-skill");
    expect(parsed.description).toBe("Don't miss this");
  });

  it("parses multi-line folded and literal descriptions", () => {
    const folded = `---
name: folded-skill
description: >-
  First line of folded description
  second line of folded description.
---`;
    expect(parseFrontmatter(folded).description).toBe(
      "First line of folded description second line of folded description."
    );

    const literal = `---
name: literal-skill
description: |
  Line 1
  Line 2
---`;
    expect(parseFrontmatter(literal).description).toBe("Line 1\nLine 2");
  });

  it("parses user-invocable flag in boolean and string forms", () => {
    const disabledBool = `---
name: skill-1
user-invocable: false
---`;
    expect(parseFrontmatter(disabledBool).userInvocable).toBe(false);

    const disabledUnderscore = `---
name: skill-2
user_invocable: false
---`;
    expect(parseFrontmatter(disabledUnderscore).userInvocable).toBe(false);

    const disabledStr = `---
name: skill-3
user-invocable: "false"
---`;
    expect(parseFrontmatter(disabledStr).userInvocable).toBe(false);

    const enabled = `---
name: skill-4
user-invocable: true
---`;
    expect(parseFrontmatter(enabled).userInvocable).toBe(true);

    const defaultInvocable = `---
name: skill-5
description: default
---`;
    expect(parseFrontmatter(defaultInvocable).userInvocable).toBeUndefined();
  });
});

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

  it("discovers skills from .codex/skills in workspace", () => {
    const ws = tempDir("ws-codex-");
    const codexSkill = path.join(ws, ".codex/skills/codex-probe");
    mkdirSync(codexSkill, { recursive: true });
    writeFileSync(
      path.join(codexSkill, "SKILL.md"),
      `---
name: codex-probe
description: "Codex skill description"
---
`
    );

    const roots = resolveSkillRoots(ws);
    expect(roots).toContain(path.join(ws, ".codex/skills"));

    const commands = discoverSkillCommands(ws);
    const found = commands.find((c) => c.name === "codex-probe");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Codex skill description");
  });

  it("excludes skills with user-invocable: false", () => {
    const ws = tempDir("ws-invocable-");
    const visibleSkill = path.join(ws, ".agents/skills/visible-skill");
    const hiddenSkill = path.join(ws, ".agents/skills/shadcn");
    mkdirSync(visibleSkill, { recursive: true });
    mkdirSync(hiddenSkill, { recursive: true });

    writeFileSync(
      path.join(visibleSkill, "SKILL.md"),
      `---
name: visible-skill
description: Available to user
---`
    );
    writeFileSync(
      path.join(hiddenSkill, "SKILL.md"),
      `---
name: shadcn
description: Add components
user-invocable: false
---`
    );

    const commands = discoverSkillCommands(ws);
    expect(commands.find((c) => c.name === "visible-skill")).toBeDefined();
    expect(commands.find((c) => c.name === "shadcn")).toBeUndefined();
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

