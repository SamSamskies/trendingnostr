import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import {
  encodeNaddr,
  KIND_LONG_FORM,
  readLongFormMeta,
  type LongFormMeta,
} from "./articleMeta";
import { encodeNpub, type Kind0Profile } from "./identity";
import {
  isUnmodifiedLeftClick,
  njumpHref,
  noteRefLabel,
  profileLabel,
  type AddressRef,
} from "./mentions";
import type { OpenInKind } from "./nostr-clients";
import {
  fetchEventByAddress,
  formatCreateAtDate,
  getKind0Profiles,
  readCachedKind0Profiles,
} from "./nostr";

type Status =
  | { kind: "loading" }
  | {
      kind: "ready";
      pubkey: string;
      createdAt: number;
      meta: LongFormMeta;
      profile?: Kind0Profile;
      code: string;
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
      href={njumpHref(code)}
      target="_blank"
      rel="noreferrer"
      title={code}
      onClick={(event) => {
        if (!onOpen) return;
        if (!isUnmodifiedLeftClick(event)) return;
        event.preventDefault();
        onOpen("address", code);
      }}
    >
      {noteRefLabel(code)}
    </a>
  );
}

export function QuotedLongForm({
  addressRef,
  profiles = {},
  onOpen,
}: {
  addressRef: AddressRef;
  profiles?: Record<string, Kind0Profile>;
  onOpen?: (kind: OpenInKind, code: string) => void;
}) {
  const [status, setStatus] = useState<Status>(() => {
    if (addressRef.kind !== KIND_LONG_FORM) return { kind: "fallback" };
    return { kind: "loading" };
  });
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (addressRef.kind !== KIND_LONG_FORM) {
      setStatus({ kind: "fallback" });
      return;
    }

    let cancelled = false;
    setStatus({ kind: "loading" });
    setImageFailed(false);

    void fetchEventByAddress(
      KIND_LONG_FORM,
      addressRef.pubkey,
      addressRef.identifier,
      addressRef.relayHints
    ).then(async (event) => {
      if (cancelled) return;
      if (!event || event.kind !== KIND_LONG_FORM) {
        setStatus({ kind: "fallback" });
        return;
      }

      const pubkey = event.pubkey.toLowerCase();
      const cached =
        profiles[pubkey] ?? readCachedKind0Profiles([pubkey])[pubkey];
      const code =
        encodeNaddr(
          KIND_LONG_FORM,
          pubkey,
          addressRef.identifier,
          addressRef.relayHints
        ) ?? addressRef.code;

      setStatus({
        kind: "ready",
        pubkey,
        createdAt: event.created_at,
        meta: readLongFormMeta(event),
        profile: cached,
        code,
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
  }, [addressRef.code]);

  if (status.kind === "fallback") {
    return <FallbackLink code={addressRef.code} onOpen={onOpen} />;
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
        <span className="note-longform-preview note-longform-preview-loading">
          <span className="note-longform-thumb note-link-preview-thumb-empty" />
          <span className="note-longform-body">
            <span className="note-link-preview-skeleton" />
            <span className="note-link-preview-skeleton note-link-preview-skeleton-md" />
          </span>
        </span>
      </span>
    );
  }

  const { pubkey, createdAt, meta, code } = status;
  const profile = profiles[pubkey] ?? status.profile;
  const name = profileLabel(pubkey, profile?.displayName);
  const npub = encodeNpub(pubkey);
  const title = meta.title || addressRef.identifier;
  const showImage = Boolean(meta.image) && !imageFailed;

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
    <div className="note-quote note-longform">
      <div className="note-quote-author">
        <Avatar src={profile?.picture} pubkey={pubkey} />
        <span className="note-quote-author-copy">
          {nameEl}
          <time dateTime={new Date(createdAt * 1000).toISOString()}>
            {formatCreateAtDate(createdAt)}
          </time>
        </span>
      </div>
      <a
        className="note-longform-preview"
        href={njumpHref(code)}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!onOpen) return;
          if (!isUnmodifiedLeftClick(event)) return;
          event.preventDefault();
          onOpen("address", code);
        }}
      >
        {showImage ? (
          <img
            className="note-longform-thumb"
            src={meta.image!}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className="note-longform-thumb note-link-preview-thumb-empty" />
        )}
        <span className="note-longform-body">
          <span className="note-longform-title">{title}</span>
          {meta.summary ? (
            <span className="note-longform-summary">{meta.summary}</span>
          ) : null}
          {meta.tags.length > 0 ? (
            <span className="note-longform-tags">
              {meta.tags.slice(0, 6).map((tag) => (
                <span key={tag} className="note-longform-tag">
                  #{tag}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </a>
    </div>
  );
}
