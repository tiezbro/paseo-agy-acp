import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentBlocksToPrompt, contentBlocksToText } from "../src/agy/acp/content/index.js";

const PNG_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Adapter must never invent conversational framing around client content. */
const INJECTED_PROSE = [
  /Referenced resource:/i,
  /Resource\s+\S+:/,
  /blob omitted/i,
  /\[image:/i,
  /\bcontinue\b/i,
  /\/fast\b/i
];

function assertNoInjectedProse(prompt: string): void {
  for (const pattern of INJECTED_PROSE) {
    expect(prompt, `must not contain injected prose matching ${pattern}`).not.toMatch(pattern);
  }
}

describe("contentBlocksToPrompt", () => {
  it("passes text blocks through unmodified", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([{ type: "text", text: "hello user" }], cwd);
      expect(prompt).toBe("hello user");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes image blocks to the session workspace and references them for agy", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "describe this" },
        { type: "image", mimeType: "image/png", data: PNG_PIXEL }
      ], cwd);

      expect(prompt).toMatch(/^describe this\n@/);
      const imagePath = prompt.split("\n")[1].slice(1);
      expect(imagePath).toContain(`${path.join(cwd, ".agy-acp", "attachments")}`);
      expect(await readFile(imagePath)).toEqual(Buffer.from(PNG_PIXEL, "base64"));
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("references file image resource links directly", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        {
          type: "resource_link",
          uri: "file:///tmp/example.png",
          name: "example.png",
          mimeType: "image/png"
        }
      ], cwd);

      expect(prompt).toBe(`@${path.resolve("/tmp/example.png")}`);
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forwards non-image resource_link URI without adapter framing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "see also" },
        {
          type: "resource_link",
          uri: "file:///repo/src/main.ts",
          name: "main.ts",
          mimeType: "text/typescript"
        }
      ], cwd);

      expect(prompt).toBe("see also\nfile:///repo/src/main.ts");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forwards embedded resource text body without URI labels", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "review" },
        {
          type: "resource",
          resource: { uri: "file:///repo/notes.md", text: "line one\nline two", mimeType: "text/markdown" }
        }
      ], cwd);

      expect(prompt).toBe("review\nline one\nline two");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("omits non-image blobs instead of inventing omission copy", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prompt-"));
    try {
      const prompt = await contentBlocksToPrompt([
        { type: "text", text: "attach" },
        {
          type: "resource",
          resource: {
            uri: "file:///repo/data.bin",
            blob: Buffer.from("binary").toString("base64"),
            mimeType: "application/octet-stream"
          }
        }
      ], cwd);

      expect(prompt).toBe("attach");
      assertNoInjectedProse(prompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("contentBlocksToText", () => {
  it("joins client text without invented labels", () => {
    expect(contentBlocksToText([
      { type: "text", text: "first" },
      { type: "text", text: "second" }
    ])).toBe("first\nsecond");
  });

  it("uses client URI and resource body only", () => {
    const text = contentBlocksToText([
      {
        type: "resource_link",
        uri: "file:///x.ts",
        name: "x.ts"
      },
      {
        type: "resource",
        resource: { uri: "file:///y.ts", text: "export {}", mimeType: "text/typescript" }
      },
      { type: "image", mimeType: "image/png", data: PNG_PIXEL }
    ]);
    expect(text).toBe("file:///x.ts\nexport {}");
    assertNoInjectedProse(text);
  });
});
