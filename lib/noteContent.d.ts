/** Soft demotion starts above this many distinct `t` (hashtag) tags. */
export declare const MAX_HASHTAG_TAGS: number;

/** True when the entire trimmed body is a JSON object or array. */
export declare function isJsonOnlyContent(content: string): boolean;

/** Blank / whitespace-only or JSON-only kind 1 bodies — common spam. */
export declare function hasDisplayableNoteContent(note: {
  content?: unknown;
}): boolean;

/** Distinct non-empty `t` tag values on a kind 1 event (NIP-12 hashtags). */
export declare function countHashtagTags(tags: string[][] | undefined): number;
