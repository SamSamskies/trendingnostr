/**
 * Soft demotion starts above this many distinct hashtags (`t` tags or `#…`
 * in content).
 */
export declare const MAX_HASHTAG_TAGS: number;

/** Soft demotion starts above this many http(s) URLs in note content. */
export declare const MAX_HTTP_LINKS: number;

/** Cap kind-1 `content` in API / Runtime Cache payloads. */
export declare const MAX_CACHED_NOTE_CONTENT_CHARS: number;

/** True when the entire trimmed body is a JSON object or array. */
export declare function isJsonOnlyContent(content: string): boolean;

/** Blank / whitespace-only or JSON-only kind 1 bodies — common spam. */
export declare function hasDisplayableNoteContent(note: {
  content?: unknown;
}): boolean;

/** Distinct non-empty `t` tag values on a kind 1 event (NIP-12 hashtags). */
export declare function countHashtagTags(tags: string[][] | undefined): number;

/** Distinct `#hashtag` tokens in kind 1 content (lowercase). */
export declare function countHashtagsInContent(
  content: string | undefined
): number;

/**
 * Hashtag count for ranking demotion: max of NIP-12 `t` tags and `#…` in content.
 */
export declare function countNoteHashtags(note: {
  tags?: string[][];
  content?: string;
}): number;

/** Count of http(s) URLs in kind 1 content (occurrence count, not distinct). */
export declare function countHttpLinks(content: string | undefined): number;

/**
 * Truncate oversized note content for cache/API payloads.
 * Ranking must run on the full body before this (link demotion).
 */
export declare function trimNoteContentForCache<T extends { content?: string }>(
  note: T
): T;
