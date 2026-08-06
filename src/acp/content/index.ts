// ACP Content: map prompt ContentBlock[] (text / image / resource) onto agy input.
// Docs: https://agentclientprotocol.com/protocol/v1/content
//
// Zero prompt injection: every substring forwarded to agy must come from the ACP
// client's session/prompt content (or be agy's native attachment transport for
// client-provided image bytes). Never invent conversational labels, instructions,
// follow-ups ("continue"), or framing prose around client data.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const ATTACHMENTS_DIR = ".agy-acp/attachments";

/**
 * Encode client ContentBlocks into a single agy prompt string.
 *
 * - text → block.text as-is
 * - image / image resource → write bytes, reference with agy `@path` transport
 * - resource_link (non-image) → uri only (client-supplied)
 * - embedded text resource → resource.text only (client-supplied body)
 * - non-image blobs → omitted (no invented "blob omitted" copy)
 *
 * Parts are joined with newlines; empty parts are dropped.
 */
export async function contentBlocksToPrompt(blocks: ContentBlock[], cwd: string): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push(block.text);
      continue;
    }

    if (block.type === "image") {
      const filePath = await writeImageAttachment(
        cwd,
        Buffer.from(block.data, "base64"),
        block.mimeType
      );
      parts.push(agyAttachmentReference(filePath));
      continue;
    }

    if (block.type === "resource_link") {
      if (isImageMimeType(block.mimeType) && block.uri) {
        parts.push(agyAttachmentReference(filePathFromUri(block.uri)));
      } else if (block.uri) {
        // Client-supplied URI only — no adapter prose.
        parts.push(block.uri);
      }
      continue;
    }

    if (block.type === "resource") {
      const encoded = await resourceBlockToPrompt(block, cwd);
      if (encoded.length > 0) parts.push(encoded);
    }
  }
  return parts.join("\n");
}

/** Flatten client content to plain text for display/logging — no invented copy. */
export function contentBlocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push(block.text);
    } else if (block.type === "resource_link") {
      if (block.uri) parts.push(block.uri);
    } else if (block.type === "resource") {
      const text = resourceBlockClientText(block);
      if (text.length > 0) parts.push(text);
    }
    // image blocks have no client text payload for display
  }
  return parts.join("\n");
}

async function resourceBlockToPrompt(
  block: Extract<ContentBlock, { type: "resource" }>,
  cwd: string
): Promise<string> {
  const resource = block.resource;
  if ("blob" in resource && isImageMimeType(resource.mimeType)) {
    const filePath = await writeImageAttachment(
      cwd,
      Buffer.from(resource.blob, "base64"),
      resource.mimeType ?? "application/octet-stream"
    );
    return agyAttachmentReference(filePath);
  }
  return resourceBlockClientText(block);
}

/** Client-authored body only; never wrap with URI labels or omission notices. */
function resourceBlockClientText(block: Extract<ContentBlock, { type: "resource" }>): string {
  const resource = block.resource;
  if ("text" in resource && typeof resource.text === "string") {
    return resource.text;
  }
  return "";
}

/**
 * agy native file-attachment transport for client-provided image bytes.
 * `@` + absolute path is how agy attaches files — not conversational prose.
 */
function agyAttachmentReference(filePath: string): string {
  return `@${path.resolve(filePath)}`;
}

async function writeImageAttachment(
  cwd: string,
  data: Buffer,
  mimeType: string
): Promise<string> {
  const dir = path.join(cwd, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}${extensionForMimeType(mimeType)}`);
  await writeFile(filePath, data);
  return filePath;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/avif":
      return ".avif";
    default:
      return ".img";
  }
}

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

function filePathFromUri(uri: string): string {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  return uri;
}
