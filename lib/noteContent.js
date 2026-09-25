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
export const DOWNRANKED_LINK_HOSTS = new Set([
  "theboard.world",
  "yesodi.com",
  "t.me",
  "telegram.me",
]);

/**
 * Hostnames whose links hard-drop a note from the trending feed (malware /
 * scam / known-bad promo). Same matching rules as DOWNRANKED_LINK_HOSTS.
 */
export const BANNED_LINK_HOSTS = new Set([
  "luckywavebet-uk.com",
  "playfinabet-si.com",
  "wildzplay-nz.com",
  "cowboys777.com",
  "ivibetgira-pt.com",
  "targat.bet",
  "swiftcasinouk.com",
  "extremecasinobet-ca.com",
  "mtproto.cloud",
  "bloggersminds.com",
]);

/**
 * Hashtags that hard-drop a note from the trending feed (NIP-12 `t` tags or
 * `#…` in content). Case-insensitive. Sourced from Gleasonator AntiPornPolicy:
 * https://jsr.io/@gleasonator/policy/0.9.8/policies/AntiPornPolicy.ts
 */
export const BANNED_HASHTAGS = new Set([
  "adult",
  "ass",
  "assworship",
  "boobs",
  "boobies",
  "butt",
  "cock",
  "dick",
  "dickpic",
  "explosionloli",
  "femboi",
  "femboy",
  "fetish",
  "fuck",
  "freeporn",
  "girls",
  "loli",
  "milf",
  "nude",
  "nudity",
  "nsfw",
  "pantsu",
  "pussy",
  "porn",
  "porno",
  "porntube",
  "pornvideo",
  "sex",
  "sexpervertsyndicate",
  "sexporn",
  "sexy",
  "slut",
  "teen",
  "tits",
  "teenporn",
  "teens",
  "transnsfw",
  "xxx",
  "うちの子を置くとみんながうちの子に対する印象をリアクションしてくれるタグ",
]);

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
 * True when `host` equals an entry in `hosts` or is a subdomain of one.
 * @param {string} host Lowercased hostname with `www.` already stripped.
 * @param {ReadonlySet<string>} hosts
 */
function hostMatchesSet(host, hosts) {
  for (const blocked of hosts) {
    if (host === blocked || host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

/**
 * True when content has an http(s) URL whose host is in `hosts`
 * (exact match or subdomain).
 * @param {string | undefined} content
 * @param {ReadonlySet<string>} hosts
 */
function contentHasLinkHostIn(content, hosts) {
  if (typeof content !== "string" || !content || hosts.size === 0) return false;
  const matches = content.match(/https?:\/\/[^\s<>"']+/gi);
  if (!matches) return false;
  for (const raw of matches) {
    try {
      const host = new URL(stripTrailingUrlPunctuation(raw)).hostname
        .replace(/^www\./i, "")
        .replace(/\.$/, "")
        .toLowerCase();
      if (hostMatchesSet(host, hosts)) return true;
    } catch {
      // Malformed URL fragment in content — ignore.
    }
  }
  return false;
}

/**
 * True when content has an http(s) URL whose host is in DOWNRANKED_LINK_HOSTS
 * (exact match or subdomain).
 */
export function hasDownrankedLinkHost(content) {
  return contentHasLinkHostIn(content, DOWNRANKED_LINK_HOSTS);
}

/**
 * True when content has an http(s) URL whose host is in BANNED_LINK_HOSTS
 * (exact match or subdomain). Those notes are dropped from the feed.
 */
export function hasBannedLinkHost(content) {
  return contentHasLinkHostIn(content, BANNED_LINK_HOSTS);
}

/**
 * True when a note has a hashtag in BANNED_HASHTAGS via NIP-12 `t` tags or
 * `#…` in content. Those notes are dropped from the feed.
 */
export function hasBannedHashtag(note) {
  if (!note || BANNED_HASHTAGS.size === 0) return false;
  if (Array.isArray(note.tags)) {
    for (const tag of note.tags) {
      if (!Array.isArray(tag) || tag[0] !== "t") continue;
      const value = typeof tag[1] === "string" ? tag[1].trim().toLowerCase() : "";
      if (value && BANNED_HASHTAGS.has(value)) return true;
    }
  }
  if (typeof note.content !== "string" || !note.content) return false;
  // Fresh /g regex each call so lastIndex cannot leak across notes.
  const re = /(?:^|[\s([{'"“‘])#([a-zA-Z0-9_]+)/g;
  let match;
  while ((match = re.exec(note.content)) !== null) {
    if (BANNED_HASHTAGS.has(match[1].toLowerCase())) return true;
  }
  // Non-ASCII banned tags (e.g. Japanese) are not matched by the ASCII extractor.
  const lowered = note.content.toLowerCase();
  for (const banned of BANNED_HASHTAGS) {
    if (/^[a-z0-9_]+$/.test(banned)) continue;
    const needle = `#${banned}`;
    let from = 0;
    while (from < lowered.length) {
      const idx = lowered.indexOf(needle, from);
      if (idx === -1) break;
      if (idx === 0 || /[\s([{'"“‘]/.test(note.content[idx - 1])) return true;
      from = idx + 1;
    }
  }
  return false;
}

/**
 * True when a note should enter ranking / feed assembly: displayable body,
 * no banned link host, and no banned hashtag.
 */
export function isEligibleTrendingNote(note) {
  return (
    hasDisplayableNoteContent(note) &&
    !hasBannedLinkHost(note?.content) &&
    !hasBannedHashtag(note)
  );
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
