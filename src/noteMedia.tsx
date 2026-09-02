import type { ReactNode } from "react";
import { MediaGrid, type NoteMediaItem } from "./MediaGrid";

export type NoteContentToken =
  | { type: "media"; item: NoteMediaItem; key: number }
  /** Newlines or whitespace-only text — keep unless between consecutive media. */
  | { type: "ws"; node: ReactNode }
  | { type: "node"; node: ReactNode };

function peekNonWs(
  tokens: NoteContentToken[],
  from: number
): NoteContentToken | undefined {
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].type !== "ws") return tokens[i];
  }
  return undefined;
}

export function renderStandaloneMedia(
  item: NoteMediaItem,
  key: number
): ReactNode {
  if (item.kind === "image") {
    return (
      <img
        key={key}
        className="note-image"
        src={item.url}
        alt=""
        loading="lazy"
      />
    );
  }

  return (
    <video key={key} className="note-video" src={item.url} controls>
      {item.url}
    </video>
  );
}

/**
 * Consecutive image/video URLs separated only by whitespace or newlines become
 * one media grid. Embeds, link previews, and text keep media groups apart.
 */
export function coalesceMedia(tokens: NoteContentToken[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token.type === "media") {
      const items: NoteMediaItem[] = [];
      const keys: number[] = [];

      while (index < tokens.length) {
        const current = tokens[index];
        if (current.type === "media") {
          items.push(current.item);
          keys.push(current.key);
          index++;
          continue;
        }
        if (
          current.type === "ws" &&
          peekNonWs(tokens, index + 1)?.type === "media"
        ) {
          // Drop interstitial whitespace/newlines between media.
          index++;
          continue;
        }
        break;
      }

      if (items.length >= 2) {
        nodes.push(<MediaGrid key={`media-grid-${keys[0]}`} items={items} />);
      } else {
        nodes.push(renderStandaloneMedia(items[0], keys[0]));
      }
      continue;
    }

    nodes.push(token.node);
    index++;
  }

  return nodes;
}
