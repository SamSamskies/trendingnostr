import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  classifyUrl,
  hyperlinkRegex,
  newlineRegex,
  normalizeHttpUrl,
  youtubeEmbedUrl,
} from "./media";
import {
  isUnmodifiedLeftClick,
  mentionLabel,
  njumpHref,
  noteRefLabel,
  nostrUriRegex,
  parseNostrEntity,
} from "./mentions";
import { isSafeHttpUrl, type Kind0Profile } from "./identity";
import { LinkPreview } from "./LinkPreview";
import {
  MediaGrid,
  type NoteMediaItem,
} from "./MediaGrid";
import type { OpenInKind } from "./nostr-clients";

const wavlakeRegex =
  /(https?:\/\/(?:player\.|www\.)?wavlake\.com\/(?!top|new|artists|account|activity|login|preferences|feed|profile|shows)(?:(?:track|album)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-z-]+))/gi;

/** NIP-30 shortcodes: `:name:` with alphanumeric, hyphen, or underscore. */
const customEmojiRegex = /(:[A-Za-z0-9_-]+:)/g;
const SHORTCODE = /^[A-Za-z0-9_-]+$/;

function parseEmojiTags(tags: string[][]): Map<string, string> {
  const emojis = new Map<string, string>();
  for (const tag of tags) {
    if (tag[0] !== "emoji") continue;
    const shortcode = tag[1]?.trim();
    const url = tag[2]?.trim();
    if (!shortcode || !SHORTCODE.test(shortcode)) continue;
    if (!url || !isSafeHttpUrl(url)) continue;
    emojis.set(shortcode.toLowerCase(), url);
  }
  return emojis;
}

function CustomEmoji({
  shortcode,
  src,
}: {
  shortcode: string;
  src: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const token = `:${shortcode}:`;
  if (failed) return token;

  return (
    <img
      className="note-emoji"
      src={src}
      alt={token}
      title={token}
      referrerPolicy="no-referrer"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function renderStandaloneMedia(item: NoteMediaItem, key: number): ReactNode {
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

type ContentToken =
  | { type: "media"; item: NoteMediaItem; key: number }
  /** Newlines or whitespace-only text — keep unless between consecutive media. */
  | { type: "ws"; node: ReactNode }
  | { type: "node"; node: ReactNode };

function peekNonWs(
  tokens: ContentToken[],
  from: number
): ContentToken | undefined {
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].type !== "ws") return tokens[i];
  }
  return undefined;
}

/**
 * Consecutive image/video URLs separated only by whitespace or newlines become
 * one media grid. Embeds, link previews, and text keep media groups apart.
 */
function coalesceMedia(tokens: ContentToken[]): ReactNode[] {
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

function classifyPart(
  part: string,
  index: number,
  tags: string[][],
  emojis: Map<string, string>,
  profiles: Record<string, Kind0Profile>,
  onOpen?: (kind: OpenInKind, code: string) => void
): ContentToken | null {
  if (part === undefined || part === "") {
    return null;
  }

  if (part.match(newlineRegex)) {
    return { type: "ws", node: <br key={index} /> };
  }

  if (/^\s+$/.test(part)) {
    return { type: "ws", node: <Fragment key={index}>{part}</Fragment> };
  }

  const entity = parseNostrEntity(part);
  if (entity) {
    const kind: OpenInKind =
      entity.type === "profile"
        ? "profile"
        : entity.type === "address"
          ? "address"
          : "note";
    const label =
      entity.type === "profile"
        ? mentionLabel(entity.pubkey, profiles[entity.pubkey]?.displayName)
        : entity.type === "address"
          ? entity.code
          : noteRefLabel(entity.code);

    return {
      type: "node",
      node: (
        <a
          key={index}
          className={entity.type === "address" ? undefined : "note-mention"}
          href={njumpHref(entity.code)}
          target="_blank"
          rel="noreferrer"
          title={part}
          onClick={(event) => {
            if (!onOpen) return;
            if (!isUnmodifiedLeftClick(event)) return;
            event.preventDefault();
            onOpen(kind, entity.code);
          }}
        >
          {label}
        </a>
      ),
    };
  }

  if (/^https?:\/\//i.test(part)) {
    const youtubeEmbed = youtubeEmbedUrl(part);
    if (youtubeEmbed) {
      return {
        type: "node",
        node: (
          <iframe
            key={index}
            className="note-embed"
            src={youtubeEmbed}
            loading="lazy"
            title="YouTube video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        ),
      };
    }

    if (part.match(wavlakeRegex)) {
      const convertedUrl = part.replace(
        /(?:player\.|www\.)?wavlake\.com/,
        "embed.wavlake.com"
      );

      return {
        type: "node",
        node: (
          <iframe
            key={index}
            className="note-embed"
            src={convertedUrl}
            loading="lazy"
            title="WavLake Embed"
          />
        ),
      };
    }
  }

  const emojiMatch = /^:([A-Za-z0-9_-]+):$/.exec(part);
  const emojiUrl = emojiMatch
    ? emojis.get(emojiMatch[1].toLowerCase())
    : undefined;
  if (emojiUrl && emojiMatch) {
    return {
      type: "node",
      node: (
        <CustomEmoji
          key={index}
          shortcode={emojiMatch[1]}
          src={emojiUrl}
        />
      ),
    };
  }

  if (!/^https?:\/\//i.test(part)) {
    return { type: "node", node: <Fragment key={index}>{part}</Fragment> };
  }

  const url = normalizeHttpUrl(part);
  const media = classifyUrl(url, tags);

  if (media === "image" || media === "video") {
    return {
      type: "media",
      item: { kind: media, url },
      key: index,
    };
  }

  if (part.match(hyperlinkRegex)) {
    return {
      type: "node",
      node: <LinkPreview key={index} url={url} label={part} />,
    };
  }

  return { type: "node", node: <Fragment key={index}>{part}</Fragment> };
}

export const NoteContent = ({
  content,
  tags = [],
  profiles = {},
  onOpen,
}: {
  content: string;
  tags?: string[][];
  profiles?: Record<string, Kind0Profile>;
  onOpen?: (kind: OpenInKind, code: string) => void;
}) => {
  const emojis = parseEmojiTags(tags);
  const parts = content.split(
    new RegExp(
      `(?:${newlineRegex.source}|${nostrUriRegex.source}|${hyperlinkRegex.source}${
        emojis.size > 0 ? `|${customEmojiRegex.source}` : ""
      })`,
      "gi"
    )
  );

  const tokens: ContentToken[] = [];
  for (let index = 0; index < parts.length; index++) {
    const token = classifyPart(
      parts[index],
      index,
      tags,
      emojis,
      profiles,
      onOpen
    );
    if (token) tokens.push(token);
  }

  return <>{coalesceMedia(tokens)}</>;
};
