/**
 * Kind-1 content gates shared by client (`src/nostr.ts`) and server (`lib/trendingFeed.js`).
 */

/**
 * Soft demotion starts above this many distinct hashtags (`t` tags or `#…`
 * in content). Spammers dump either tags-only or content-only hashtag farms.
 */
export const MAX_HASHTAG_TAGS = 3;

/**
 * Soft demotion starts above this many http(s) URLs in note content.
 * Link-farm / SEO dumps pad kind 1s with dozens of promotional URLs.
 */
export const MAX_HTTP_LINKS = 3;

/**
 * Hostnames whose links heavily demote a note in ranking (spam / promo dumps).
 * Matched case-insensitively, including subdomains (`www.` stripped first).
 */
export const DOWNRANKED_LINK_HOSTS = new Set(["theboard.world"]);

/**
 * Cap kind-1 `content` in API / Runtime Cache payloads.
 * SEO dumps can be hundreds of KB; write units track bytes.
 */
export const MAX_CACHED_NOTE_CONTENT_CHARS = 2000;

const CACHED_NOTE_CONTENT_TRUNCATE_SUFFIX = "\n\n… (content truncated)";

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

/**
 * Distinct `#hashtag` tokens in kind 1 content (lowercase).
 * Requires a start/whitespace/punctuation boundary so URL fragments are skipped.
 */
export function countHashtagsInContent(content) {
  if (typeof content !== "string" || !content) return 0;
  const seen = new Set();
  // Fresh /g regex each call so lastIndex cannot leak across notes.
  const re = /(?:^|[\s([{'"“‘])#([a-zA-Z0-9_]+)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const value = match[1].toLowerCase();
    if (value) seen.add(value);
  }
  return seen.size;
}

/**
 * Hashtag count for ranking demotion: max of NIP-12 `t` tags and `#…` in content.
 */
export function countNoteHashtags(note) {
  return Math.max(
    countHashtagTags(note?.tags),
    countHashtagsInContent(note?.content)
  );
}

/** Count of http(s) URLs in kind 1 content (occurrence count, not distinct). */
export function countHttpLinks(content) {
  if (typeof content !== "string" || !content) return 0;
  // Fresh /g regex each call so lastIndex cannot leak across notes.
  const matches = content.match(/https?:\/\/[^\s<>"']+/gi);
  return matches ? matches.length : 0;
}

/**
 * Strip trailing punctuation often glued onto URLs in prose (`.`, `)`, etc.).
 * Keeps balanced `)`, `]`, `}` that belong to the path (e.g. Wikipedia).
 */
function stripTrailingUrlPunctuation(raw) {
  let url = raw;
  while (url.length > 0) {
    const ch = url.at(-1);
    if (".,;:!?\"'".includes(ch)) {
      url = url.slice(0, -1);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      const opens = url.split(open).length - 1;
      const closes = url.split(ch).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}

/**
 * True when content has an http(s) URL whose host is in DOWNRANKED_LINK_HOSTS
 * (exact match or subdomain).
 */
export function hasDownrankedLinkHost(content) {
  if (typeof content !== "string" || !content) return false;
  const matches = content.match(/https?:\/\/[^\s<>"']+/gi);
  if (!matches) return false;
  for (const raw of matches) {
    try {
      const host = new URL(stripTrailingUrlPunctuation(raw)).hostname
        .replace(/^www\./i, "")
        .replace(/\.$/, "")
        .toLowerCase();
      for (const blocked of DOWNRANKED_LINK_HOSTS) {
        if (host === blocked || host.endsWith(`.${blocked}`)) return true;
      }
    } catch {
      // Malformed URL fragment in content — ignore.
    }
  }
  return false;
}

/**
 * Truncate oversized note content for cache/API payloads.
 * Prefer cutting on a newline so URLs are less often bisected.
 * Ranking must run on the full body before this (link demotion).
 *
 * @template {{ content?: string }} T
 * @param {T} note
 * @returns {T}
 */
export function trimNoteContentForCache(note) {
  if (!note || typeof note.content !== "string") return note;
  if (note.content.length <= MAX_CACHED_NOTE_CONTENT_CHARS) return note;

  const budget = Math.max(
    0,
    MAX_CACHED_NOTE_CONTENT_CHARS - CACHED_NOTE_CONTENT_TRUNCATE_SUFFIX.length
  );
  let cut = note.content.slice(0, budget);
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > budget * 0.5) cut = cut.slice(0, lastNl);
  return { ...note, content: cut + CACHED_NOTE_CONTENT_TRUNCATE_SUFFIX };
}
