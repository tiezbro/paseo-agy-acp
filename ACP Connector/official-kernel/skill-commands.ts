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

export function resolveSkillRoots(cwd?: string): string[] {
  const configuredRoots = new Set<string>();
  const home = homedir();

  const readSkillsJson = (filePath: string, baseDir: string): void => {
    if (!existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
        entries?: Array<{ path: string }>;
      };
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (entry && typeof entry.path === "string" && entry.path.trim().length > 0) {
            const trimmed = entry.path.trim();
            let resolved: string;
            if (trimmed.startsWith("/")) {
              resolved = trimmed;
            } else if (trimmed.startsWith("~/")) {
              resolved = path.join(home, trimmed.slice(2));
            } else {
              resolved = path.resolve(baseDir, trimmed);
            }
            if (existsSync(resolved)) {
              configuredRoots.add(resolved);
            }
          }
        }
      }
    } catch {
      // Ignore JSON parse errors
    }
  };

  // 1. Workspace declared configs
  if (cwd && existsSync(cwd)) {
    readSkillsJson(path.join(cwd, ".agents/skills.json"), cwd);
    readSkillsJson(path.join(cwd, "skills.json"), cwd);
  }

  // 2. Global declared config (~/.gemini/config/skills.json)
  readSkillsJson(path.join(home, ".gemini/config/skills.json"), home);

  // If user configured any directories, use them
  if (configuredRoots.size > 0) {
    if (cwd && existsSync(cwd)) {
      const wsDefault = path.join(cwd, ".agents/skills");
      if (existsSync(wsDefault)) configuredRoots.add(wsDefault);
    }
    return Array.from(configuredRoots);
  }

  // 3. Fallback: Antigravity default skill locations
  const defaultRoots = new Set<string>();

  if (cwd && existsSync(cwd)) {
    const wsAgents = path.join(cwd, ".agents/skills");
    const wsSkills = path.join(cwd, "skills");
    if (existsSync(wsAgents)) defaultRoots.add(wsAgents);
    if (existsSync(wsSkills)) defaultRoots.add(wsSkills);
  }

  const globalDefaults = [
    path.join(home, ".gemini/config/skills"),
    path.join(home, ".agents/skills")
  ];
  for (const dir of globalDefaults) {
    if (existsSync(dir)) defaultRoots.add(dir);
  }

  return Array.from(defaultRoots);
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
