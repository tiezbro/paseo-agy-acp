// Narration filtering: agy interleaves short "I will …" planning lines into the
// agent's text stream. When narration is suppressed, those lines are dropped so
// the transcript reads as prose.

const NARRATION_PREFIXES = ["I will", "I'll", "I’ll"];

/** True if every non-empty line is a narration line ("I will …" / "I'll …"). */
export function isNarration(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => {
    const line = l.replace(/^\s+/, "");
    return NARRATION_PREFIXES.some((p) => line.startsWith(p));
  });
}

/** Join parts, dropping narration-only ones. Returns null if nothing remains. */
export function filterNarration(parts: string[]): string | null {
  const text = parts.filter((p) => !isNarration(p)).join("\n");
  return text.length > 0 ? text : null;
}
