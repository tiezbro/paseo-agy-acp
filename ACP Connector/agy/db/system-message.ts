// System message filtering: agy appends internal `<SYSTEM_MESSAGE>` task completion
// notifications into step type 15 (agentText). When translated, these should be
// suppressed so background notifications and command outputs do not render as regular
// assistant response text in ACP clients.

/**
 * True if the text matches an internal agy system message envelope
 * (starts with `<SYSTEM_MESSAGE>\n[Message]`).
 */
export function isSystemMessage(text: string): boolean {
  return /^\s*<SYSTEM_MESSAGE>\s*\n\[Message\]\s+/i.test(text);
}

/**
 * True while a growing text value could still become an internal system
 * message envelope. Streaming callers defer these prefixes until they can be
 * classified, avoiding emission of a partial internal marker.
 */
export function isSystemMessagePrefix(text: string): boolean {
  const tag = "<SYSTEM_MESSAGE>";
  const marker = "[Message]";
  const trimmed = text.trimStart();
  const tagCandidate = trimmed.slice(0, Math.min(trimmed.length, tag.length));
  if (tagCandidate.toLowerCase() !== tag.slice(0, tagCandidate.length).toLowerCase()) return false;
  if (trimmed.length <= tag.length) return true;

  const afterTag = trimmed.slice(tag.length);
  const markerStart = afterTag.search(/\S/);
  if (markerStart === -1) return true;
  if (markerStart === 0 || afterTag[markerStart - 1] !== "\n") return false;

  const markerCandidate = afterTag.slice(markerStart);
  return (
    markerCandidate.length <= marker.length &&
    markerCandidate.toLowerCase() === marker.slice(0, markerCandidate.length).toLowerCase()
  );
}
