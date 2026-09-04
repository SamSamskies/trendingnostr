/** True when the entire trimmed body is a JSON object or array. */
export declare function isJsonOnlyContent(content: string): boolean;

/** Blank / whitespace-only or JSON-only kind 1 bodies — common spam. */
export declare function hasDisplayableNoteContent(note: {
  content: string;
}): boolean;
