import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AvailableCommand {
  name: string;
  description: string;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) return {};
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return {};

  const frontmatter = content.slice(3, endIdx).trim();
  const lines = frontmatter.split("\n");
  let name: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^name:\s*/.test(line)) {
      name = line.replace(/^name:\s*/, "").trim().replace(/^["']|["']$/g, "");
    } else if (/^description:\s*/.test(line)) {
      let desc = line.replace(/^description:\s*/, "").trim();
      if (desc === ">-" || desc === ">" || desc === "|") {
        const descLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s+/.test(lines[j])) {
            descLines.push(lines[j].trim());
            i = j;
          } else {
            break;
          }
        }
        desc = descLines.join(" ");
      }
      description = desc.replace(/^["']|["']$/g, "").trim();
    }
  }

  return { name, description };
}

function resolveSkillRoots(cwd?: string): string[] {
  const roots = new Set<string>();
  const home = homedir();

  // 1. Check ~/.gemini/config/skills.json
  const skillsJsonPath = path.join(home, ".gemini/config/skills.json");
  if (existsSync(skillsJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(skillsJsonPath, "utf-8")) as {
        entries?: Array<{ path: string }>;
      };
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (entry.path) {
            const resolved = entry.path.startsWith("~/")
              ? path.join(home, entry.path.slice(2))
              : entry.path;
            if (existsSync(resolved)) roots.add(resolved);
          }
        }
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 2. Default global paths
  const defaultGlobal = [
    path.join(home, ".codex/skills"),
    path.join(home, ".agents/skills")
  ];
  for (const dir of defaultGlobal) {
    if (existsSync(dir)) roots.add(dir);
  }

  // 3. Workspace cwd paths if provided
  if (cwd && existsSync(cwd)) {
    const wsCodex = path.join(cwd, ".codex/skills");
    const wsAgents = path.join(cwd, ".agents/skills");
    if (existsSync(wsCodex)) roots.add(wsCodex);
    if (existsSync(wsAgents)) roots.add(wsAgents);
  }

  return Array.from(roots);
}

export function discoverSkillCommands(cwd?: string): AvailableCommand[] {
  const roots = resolveSkillRoots(cwd);
  const commands = new Map<string, AvailableCommand>();

  for (const root of roots) {
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const skillDir = path.join(root, entry.name);
          const skillFile = path.join(skillDir, "SKILL.md");
          if (existsSync(skillFile)) {
            try {
              const content = readFileSync(skillFile, "utf-8");
              const { name, description } = parseFrontmatter(content);
              const commandName = name && name.length > 0 ? name : entry.name;
              if (!commands.has(commandName)) {
                commands.set(commandName, {
                  name: commandName,
                  description:
                    description && description.length > 0
                      ? description
                      : `Skill: ${commandName}`
                });
              }
            } catch {
              // Ignore file read errors
            }
          }
        }
      }
    } catch {
      // Ignore readdir errors
    }
  }

  return Array.from(commands.values());
}

export function augmentAvailableCommands(
  existingCommands: AvailableCommand[] | undefined,
  cwd?: string
): AvailableCommand[] {
  const result = new Map<string, AvailableCommand>();

  if (Array.isArray(existingCommands)) {
    for (const cmd of existingCommands) {
      if (cmd && typeof cmd.name === "string") {
        result.set(cmd.name, cmd);
      }
    }
  }

  const skills = discoverSkillCommands(cwd);
  for (const skill of skills) {
    if (!result.has(skill.name)) {
      result.set(skill.name, skill);
    }
  }

  return Array.from(result.values());
}
