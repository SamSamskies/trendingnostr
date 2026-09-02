import { Fragment, useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { isSafeHttpUrl, type Kind0Profile } from "./identity";
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
  profileLabel,
  type NoteRef,
} from "./mentions";
import { coalesceMedia, type NoteContentToken } from "./noteMedia";
import type { OpenInKind } from "./nostr-clients";
import {
  fetchEventById,
  formatCreateAtDate,
  getKind0Profiles,
  readCachedKind0Profiles,
} from "./nostr";

type Status =
  | { kind: "loading" }
  | {
      kind: "ready";
      content: string;
      tags: string[][];
      pubkey: string;
      createdAt: number;
      profile?: Kind0Profile;
    }
  | { kind: "fallback" };

const customEmojiRegex = /(:[A-Za-z0-9_-]+:)/g;
const SHORTCODE = /^[A-Za-z0-9_-]+$/;
const wavlakeRegex =
  /(https?:\/\/(?:player\.|www\.)?wavlake\.com\/(?!top|new|artists|account|activity|login|preferences|feed|profile|shows)(?:(?:track|album)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-z-]+))/gi;

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

function FallbackLink({
  code,
  onOpen,
}: {
  code: string;
  onOpen?: (kind: OpenInKind, code: string) => void;
}) {
  return (
    <a
      className="note-mention"
      href={njumpHref(code)}
      target="_blank"
      rel="noreferrer"
      title={code}
      onClick={(event) => {
        if (!onOpen) return;
        if (!isUnmodifiedLeftClick(event)) return;
        event.preventDefault();
        onOpen("note", code);
      }}
    >
      {noteRefLabel(code)}
    </a>
  );
}

function openQuotedNote(
  event: { preventDefault: () => void },
  code: string,
  onOpen?: (kind: OpenInKind, code: string) => void
) {
  if (!onOpen) {
    window.open(njumpHref(code), "_blank", "noopener,noreferrer");
    return;
  }
  event.preventDefault();
  onOpen("note", code);
}

/** Quote card body: media + embeds like notes; no nested quotes or link unfurls. */
function QuoteBody({
  content,
  tags,
  profiles,
  onOpen,
}: {
  content: string;
  tags: string[][];
  profiles: Record<string, Kind0Profile>;
  onOpen?: (kind: OpenInKind, code: string) => void;
}) {
  const emojis = parseEmojiTags(tags);
  const parts = content.split(
    new RegExp(
      `(?:${newlineRegex.source}|${nostrUriRegex.source}|${hyperlinkRegex.source}${
        emojis.size > 0 ? `|${customEmojiRegex.source}` : ""
      })`,
      "gi"
    )
  );

  const tokens: NoteContentToken[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined || part === "") continue;

    if (part.match(newlineRegex)) {
      tokens.push({ type: "ws", node: <br key={index} /> });
      continue;
    }

    if (/^\s+$/.test(part)) {
      tokens.push({
        type: "ws",
        node: <Fragment key={index}>{part}</Fragment>,
      });
      continue;
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
      tokens.push({
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
      });
      continue;
    }

    const emojiMatch = /^:([A-Za-z0-9_-]+):$/.exec(part);
    const emojiUrl = emojiMatch
      ? emojis.get(emojiMatch[1].toLowerCase())
      : undefined;
    if (emojiUrl && emojiMatch) {
      tokens.push({
        type: "node",
        node: (
          <img
            key={index}
            className="note-emoji"
            src={emojiUrl}
            alt={`:${emojiMatch[1]}:`}
            title={`:${emojiMatch[1]}:`}
            referrerPolicy="no-referrer"
            decoding="async"
            loading="lazy"
          />
        ),
      });
      continue;
    }

    if (/^https?:\/\//i.test(part)) {
      const youtubeEmbed = youtubeEmbedUrl(part);
      if (youtubeEmbed) {
        tokens.push({
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
        });
        continue;
      }

      if (part.match(wavlakeRegex)) {
        const convertedUrl = part.replace(
          /(?:player\.|www\.)?wavlake\.com/,
          "embed.wavlake.com"
        );
        tokens.push({
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
        });
        continue;
      }

      const url = normalizeHttpUrl(part);
      const media = classifyUrl(url, tags);
      if (media === "image" || media === "video") {
        tokens.push({
          type: "media",
          item: { kind: media, url },
          key: index,
        });
        continue;
      }

      tokens.push({
        type: "node",
        node: (
          <a key={index} href={url} target="_blank" rel="noreferrer">
            {part}
          </a>
        ),
      });
      continue;
    }

    tokens.push({
      type: "node",
      node: <Fragment key={index}>{part}</Fragment>,
    });
  }

  return <>{coalesceMedia(tokens)}</>;
}

export function QuotedNote({
  noteRef,
  profiles = {},
  onOpen,
}: {
  noteRef: NoteRef;
  profiles?: Record<string, Kind0Profile>;
  onOpen?: (kind: OpenInKind, code: string) => void;
}) {
  const [status, setStatus] = useState<Status>(() => {
    if (noteRef.kind !== undefined && noteRef.kind !== 1) {
      return { kind: "fallback" };
    }
    return { kind: "loading" };
  });

  useEffect(() => {
    if (noteRef.kind !== undefined && noteRef.kind !== 1) {
      setStatus({ kind: "fallback" });
      return;
    }

    let cancelled = false;
    setStatus({ kind: "loading" });

    void fetchEventById(noteRef.id, noteRef.relayHints).then(async (event) => {
      if (cancelled) return;
      if (!event || event.kind !== 1) {
        setStatus({ kind: "fallback" });
        return;
      }

      const pubkey = event.pubkey.toLowerCase();
      const cached =
        profiles[pubkey] ?? readCachedKind0Profiles([pubkey])[pubkey];
      setStatus({
        kind: "ready",
        content: event.content,
        tags: event.tags,
        pubkey,
        createdAt: event.created_at,
        profile: cached,
      });

      if (!cached) {
        const found = await getKind0Profiles([pubkey]);
        if (cancelled) return;
        const profile = found[pubkey];
        if (!profile) return;
        setStatus((prev) =>
          prev.kind === "ready" && prev.pubkey === pubkey
            ? { ...prev, profile }
            : prev
        );
      }
    });

    return () => {
      cancelled = true;
    };
    // `code` encodes id / relays / author; ignore profiles + array identity churn.
  }, [noteRef.code]);

  if (status.kind === "fallback") {
    return <FallbackLink code={noteRef.code} onOpen={onOpen} />;
  }

  if (status.kind === "loading") {
    return (
      <span className="note-quote note-quote-loading" aria-hidden>
        <span className="note-quote-author">
          <span className="avatar avatar-empty" />
          <span className="note-quote-author-copy">
            <span className="note-link-preview-skeleton note-link-preview-skeleton-sm" />
            <span className="note-link-preview-skeleton note-link-preview-skeleton-md" />
          </span>
        </span>
        <span className="note-quote-skeleton-lines">
          <span className="note-link-preview-skeleton" />
          <span className="note-link-preview-skeleton note-link-preview-skeleton-md" />
        </span>
      </span>
    );
  }

  const { content, tags, pubkey, createdAt } = status;
  const profile = profiles[pubkey] ?? status.profile;
  const name = profileLabel(pubkey, profile?.displayName);
  const href = njumpHref(noteRef.code);

  return (
    <div
      className="note-quote"
      role="link"
      tabIndex={0}
      aria-label={`Quoted note by ${name}`}
      data-href={href}
      onClick={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            "a, button, iframe, .note-embed, .note-image, .note-video, .note-media-grid"
          )
        ) {
          return;
        }
        if (!isUnmodifiedLeftClick(event)) return;
        openQuotedNote(event, noteRef.code, onOpen);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openQuotedNote(event, noteRef.code, onOpen);
      }}
    >
      <div className="note-quote-author">
        <Avatar src={profile?.picture} />
        <span className="note-quote-author-copy">
          <span className="note-quote-author-name">{name}</span>
          <time dateTime={new Date(createdAt * 1000).toISOString()}>
            {formatCreateAtDate(createdAt)}
          </time>
        </span>
      </div>
      <div className="note-quote-content">
        <QuoteBody
          content={content}
          tags={tags}
          profiles={profiles}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}
