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

function missingTargets(markdown: string, targets: string[]): string[] {
  const links = markdownTargets(markdown);
  return targets.filter((target) => !links.includes(target));
}

describe("v2.0.0.0 closeout documentation contract", () => {
  it("moves README authority pointers from the old design to the Scheme and accepted Stage 2 artifacts", () => {
    const failures: string[] = [];

    for (const [label, contents] of [
      ["README.md", readDoc("README.md")],
      ["README.zh-CN.md", readDoc("README.zh-CN.md")]
    ] as const) {
      if (markdownTargets(contents).includes(OLD_DESIGN_PATH)) {
        failures.push(`${label} still links ${OLD_DESIGN_PATH}`);
      }
      if (!markdownTargets(contents).includes(SCHEME_PATH)) {
        failures.push(`${label} does not link the confirmed Scheme`);
      }
      for (const target of missingTargets(contents, STAGE2_ARTIFACTS)) {
        failures.push(`${label} does not link accepted artifact ${target}`);
      }
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
