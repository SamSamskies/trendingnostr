/**
 * Kind-1 content gates shared by client (`src/nostr.ts`) and server (`lib/trendingFeed.js`).
 */

/**
 * Soft demotion starts above this many distinct `t` (hashtag) tags.
 * Spammers often bury hashtags in tags without putting them in content.
 */
export const MAX_HASHTAG_TAGS = 3;

/**
 * Soft demotion starts above this many http(s) URLs in note content.
 * Link-farm / SEO dumps pad kind 1s with dozens of promotional URLs.
 */
export const MAX_HTTP_LINKS = 3;

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

/** Distinct non-empty `t` tag values on a kind 1 event (NIP-12 hashtags). */
export function countHashtagTags(tags) {
  if (!Array.isArray(tags)) return 0;
  const seen = new Set();
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== "t") continue;
    const value = typeof tag[1] === "string" ? tag[1].trim().toLowerCase() : "";
    if (value) seen.add(value);
  }
  return seen.size;
}

/** Count of http(s) URLs in kind 1 content (occurrence count, not distinct). */
export function countHttpLinks(content) {
  if (typeof content !== "string" || !content) return 0;
  // Fresh /g regex each call so lastIndex cannot leak across notes.
  const matches = content.match(/https?:\/\/[^\s<>"']+/gi);
  return matches ? matches.length : 0;
}
