import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCHEME_PATH = "/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md";
const OLD_DESIGN_PATH = "docs/design/v2.0.0.0-admission-controller.md";

const STAGE2_ARTIFACTS = [
  "docs/design/v2.0.0.0-stage2-handoff.md",
  "docs/design/v2.0.0.0-stage2-503-feasibility.md",
  "docs/design/v2.0.0.0-stage2-acp-source-map.md",
  "docs/design/v2.0.0.0-stage2-admission-source-map.md",
  "docs/design/v2.0.0.0-stage2-architecture.md",
  "docs/design/v2.0.0.0-stage2-domain-model.md",
  "docs/design/v2.0.0.0-stage2-test-contracts.md",
  "docs/design/v2.0.0.0-stage2-spec.md"
];

function readDoc(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function markdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

describe("v2.0.0.0 closeout documentation contract", () => {
  it("keeps product READMEs current, bilingual, and separate from release history", () => {
    const failures: string[] = [];
    const requiredSections = [
      "positioning",
      "value",
      "architecture",
      "requirements",
      "quickstart",
      "configuration",
      "operations",
      "development",
      "license"
    ];
    const requiredTargets = [
      "./README.md",
      "./README.zh-CN.md",
      "./CHANGELOG.md",
      "docs/operations/admission.md",
      "docs/operations/official-kernel-compat-runbook.md",
      "docs/operations/npm-publishing.md"
    ];

    const readmes = [
      ["README.md", readDoc("README.md")],
      ["README.zh-CN.md", readDoc("README.zh-CN.md")]
    ] as const;

    for (const [label, contents] of readmes) {
      const links = markdownTargets(contents);
      for (const target of requiredTargets) {
        if (!links.includes(target)) {
          failures.push(`${label} does not link current target ${target}`);
        }
      }
      for (const section of requiredSections) {
        if (!contents.includes(`<!-- readme:${section} -->`)) {
          failures.push(`${label} lacks bilingual section marker ${section}`);
        }
      }
      for (const historicalTarget of [SCHEME_PATH, OLD_DESIGN_PATH, ...STAGE2_ARTIFACTS]) {
        if (links.includes(historicalTarget)) {
          failures.push(`${label} links historical authority ${historicalTarget}`);
        }
      }
      if (/\/home\/tiezbro\//.test(contents)) {
        failures.push(`${label} contains a maintainer-local absolute path`);
      }
      if (/\b2\.(?:0|1|2)(?:\.\d+){1,2}\b/.test(contents)) {
        failures.push(`${label} contains historical release narration`);
      }
      if (!/\[English\]\(\.\/README\.md\) \| \[中文\]\(\.\/README\.zh-CN\.md\) \| \[Changelog\]\(\.\/CHANGELOG\.md\)/.test(contents)) {
        failures.push(`${label} does not expose Changelog after the language links`);
      }

      const sectionOrder = [...contents.matchAll(/<!-- readme:([^ ]+) -->/g)].map(
        (match) => match[1]
      );
      if (JSON.stringify(sectionOrder) !== JSON.stringify(requiredSections)) {
        failures.push(`${label} section order differs from the bilingual contract`);
      }
    }

    const english = readmes[0][1];
    const chinese = readmes[1][1];
    if (JSON.stringify(markdownTargets(english)) !== JSON.stringify(markdownTargets(chinese))) {
      failures.push("English and Chinese README link targets differ");
    }

    const executableBlocks = (markdown: string) =>
      [...markdown.matchAll(/```(bash|json)\n([\s\S]*?)```/g)].map((match) => ({
        language: match[1],
        body: match[2]
      }));
    if (JSON.stringify(executableBlocks(english)) !== JSON.stringify(executableBlocks(chinese))) {
      failures.push("English and Chinese README executable examples differ");
    }

    expect(failures).toEqual([]);
  });

  it("records the final v2 behavior and Stage 4 release validation without stale claims", () => {
    const changelog = readDoc("CHANGELOG.md");
    const failures: string[] = [];

    for (const stalePattern of [
      /\bschema v1\b/i,
      /\beight business tables\b/i,
      /Reset the Admission database contract to `shared-admission-queue` schema v1/i
    ]) {
      if (stalePattern.test(changelog)) {
        failures.push(`CHANGELOG keeps stale claim ${stalePattern}`);
      }
    }

    for (const requiredFact of [
      "schema v2",
      "policy_state",
      "policy_fingerprint",
      "owner",
      "recovery_required",
      "runtime reaper",
      "production dispatch",
      "auth gate",
      "permission",
      "typed terminal",
      "queue_timeout",
      "provider_capacity",
      "npm test -- --maxWorkers=1",
      "docs/design/receipts/S3-T21/",
      "local `2.0.0.0` tarball",
      "127.0.0.1:6768",
      "STAGE4_ADMISSION_CANARY_OK"
    ]) {
      if (!changelog.includes(requiredFact)) {
        failures.push(`CHANGELOG does not record ${requiredFact}`);
      }
    }

    if (!/Production `127\.0\.0\.1:6767` was not switched or mutated\./.test(changelog)) {
      failures.push("CHANGELOG does not preserve the production connector boundary");
    }

    expect(failures).toEqual([]);
  });

  it("downgrades the old design to historical input with clause-by-clause disposition", () => {
    const design = readDoc(OLD_DESIGN_PATH);
    const failures: string[] = [];
    const firstLines = design.split(/\r?\n/).slice(0, 30).join("\n");

    for (const stalePattern of [/最终方案/, /已确认的开发基线/, /confirmed final authority/i]) {
      if (firstLines.match(stalePattern)) {
        failures.push(`old design header still asserts authority with ${stalePattern}`);
      }
    }

    for (const requiredPointer of [SCHEME_PATH, ...STAGE2_ARTIFACTS]) {
      if (!design.includes(requiredPointer)) {
        failures.push(`old design does not cite ${requiredPointer}`);
      }
    }

    for (let clause = 1; clause <= 10; clause += 1) {
      if (!design.includes(`Clause ${clause}`)) {
        failures.push(`old design lacks disposition for Clause ${clause}`);
      }
    }

    if (!/historical input/i.test(firstLines)) {
      failures.push("old design header does not mark the document as historical input");
    }
    if (/all retained/i.test(design) || /全部保留/.test(design)) {
      failures.push("old design uses an all-retained disposition shortcut");
    }

    expect(failures).toEqual([]);
  });
});
