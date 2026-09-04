/**
 * Kind-1 content gates shared by client (`src/nostr.ts`) and server (`lib/trendingFeed.js`).
 */

/**
 * True when the entire trimmed body is a JSON object or array.
 * Bots/bridges often abuse kind 1 with protocol payloads (chat bridges, telemetry).
 */
export function isJsonOnlyContent(content) {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

/**
 * Blank / whitespace-only or JSON-only kind 1 bodies — common spam.
 * Media notes put URLs in content, so they still pass.
 */
export function hasDisplayableNoteContent(note) {
  if (!note || typeof note.content !== "string") return false;
  const trimmed = note.content.trim();
  if (!trimmed) return false;
  if (isJsonOnlyContent(trimmed)) return false;
  return true;
}
