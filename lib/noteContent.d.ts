/** Notes with this many or more distinct `t` (hashtag) tags are hidden. */
export declare const MAX_HASHTAG_TAGS: number;

/** True when the entire trimmed body is a JSON object or array. */
export declare function isJsonOnlyContent(content: string): boolean;

/** Blank / whitespace-only or JSON-only kind 1 bodies — common spam. */
export declare function hasDisplayableNoteContent(note: {
  content: string;
}): boolean;

/** Distinct non-empty `t` tag values on a kind 1 event (NIP-12 hashtags). */
export declare function countHashtagTags(tags: string[][]): number;

/** Drop notes with more than MAX_HASHTAG_TAGS distinct hashtag tags. */
export declare function filterExcessHashtagNotes<T extends { tags?: string[][] }>(
  notes: T[]
): T[];
