import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import {
  encodeNaddr,
  highlightSourceFromTags,
  KIND_HIGHLIGHT,
  KIND_LONG_FORM,
  readLongFormMeta,
} from "./articleMeta";
import { encodeNpub, type Kind0Profile } from "./identity";
import {
  isUnmodifiedLeftClick,
  njumpHref,
  noteRefLabel,
  profileLabel,
  type NoteRef,
} from "./mentions";
import type { OpenInKind } from "./nostr-clients";
import {
  fetchEventByAddress,
  fetchEventById,
  formatCreateAtDate,
  getKind0Profiles,
  readCachedKind0Profiles,
} from "./nostr";

type Source =
  | { kind: "article"; code: string; title: string }
  | { kind: "url"; href: string; label: string };

type Status =
  | { kind: "loading" }
  | {
      kind: "ready";
      content: string;
      pubkey: string;
      createdAt: number;
      profile?: Kind0Profile;
      source?: Source;
    }
  | { kind: "fallback" };

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

function ArticleIcon() {
  return (
    <svg
      className="note-highlight-source-icon"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M2.5 1.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Zm1 2v1h5v-1h-5Zm0 2.5v1h5v-1h-5Zm0 2.5v1h3.5v-1H3.5Z"
      />
    </svg>
  );
}

async function resolveSource(
  tags: string[][],
  relayHints: readonly string[]
): Promise<Source | undefined> {
  const { address, url } = highlightSourceFromTags(tags);

  if (address) {
    const hints = [...address.relayHints, ...relayHints];
    const article = await fetchEventByAddress(
      KIND_LONG_FORM,
      address.pubkey,
      address.identifier,
      hints
    );
    const code = encodeNaddr(
      KIND_LONG_FORM,
      address.pubkey,
      address.identifier,
      hints
    );
    if (code) {
      const title =
        (article ? readLongFormMeta(article).title : null) ||
        address.identifier;
      return { kind: "article", code, title };
    }
  }

  if (url) {
    try {
      return { kind: "url", href: url, label: new URL(url).hostname };
    } catch {
      return { kind: "url", href: url, label: url };
    }
  }

  return undefined;
}

export function QuotedHighlight({
  noteRef,
  profiles = {},
  onOpen,
}: {
  noteRef: NoteRef;
  profiles?: Record<string, Kind0Profile>;
  onOpen?: (kind: OpenInKind, code: string) => void;
}) {
  const [status, setStatus] = useState<Status>(() => {
    if (noteRef.kind !== undefined && noteRef.kind !== KIND_HIGHLIGHT) {
      return { kind: "fallback" };
    }
    return { kind: "loading" };
  });

  useEffect(() => {
    if (noteRef.kind !== undefined && noteRef.kind !== KIND_HIGHLIGHT) {
      setStatus({ kind: "fallback" });
      return;
    }

    let cancelled = false;
    setStatus({ kind: "loading" });

    void fetchEventById(noteRef.id, noteRef.relayHints).then(async (event) => {
      if (cancelled) return;
      if (!event || event.kind !== KIND_HIGHLIGHT) {
        setStatus({ kind: "fallback" });
        return;
      }

      const pubkey = event.pubkey.toLowerCase();
      const cached =
        profiles[pubkey] ?? readCachedKind0Profiles([pubkey])[pubkey];
      const source = await resolveSource(event.tags, noteRef.relayHints);
      if (cancelled) return;

      setStatus({
        kind: "ready",
        content: event.content,
        pubkey,
        createdAt: event.created_at,
        profile: cached,
        source,
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

  const { content, pubkey, createdAt, source } = status;
  const profile = profiles[pubkey] ?? status.profile;
  const name = profileLabel(pubkey, profile?.displayName);
  const npub = encodeNpub(pubkey);

  const nameEl = npub ? (
    <a
      className="note-quote-author-name"
      href={njumpHref(npub)}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (!onOpen) return;
        if (!isUnmodifiedLeftClick(event)) return;
        event.preventDefault();
        onOpen("profile", npub);
      }}
    >
      {name}
    </a>
  ) : (
    <span className="note-quote-author-name">{name}</span>
  );

  return (
    <div className="note-quote note-highlight">
      <div className="note-quote-author">
        <Avatar src={profile?.picture} pubkey={pubkey} />
        <span className="note-quote-author-copy">
          {nameEl}
          <time dateTime={new Date(createdAt * 1000).toISOString()}>
            {formatCreateAtDate(createdAt)}
          </time>
        </span>
      </div>
      <blockquote className="note-highlight-quote">{content}</blockquote>
      {source?.kind === "article" ? (
        <p className="note-highlight-source">
          From <ArticleIcon />{" "}
          <span className="note-highlight-source-kind">Article</span>{" "}
          <a
            className="note-highlight-source-link"
            href={njumpHref(source.code)}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!onOpen) return;
              if (!isUnmodifiedLeftClick(event)) return;
              event.preventDefault();
              onOpen("address", source.code);
            }}
          >
            {source.title}
          </a>
        </p>
      ) : null}
      {source?.kind === "url" ? (
        <p className="note-highlight-source">
          From{" "}
          <a
            className="note-highlight-source-link"
            href={source.href}
            target="_blank"
            rel="noreferrer"
          >
            {source.label}
          </a>
        </p>
      ) : null}
    </div>
  );
}
