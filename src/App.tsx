import { useEffect, useMemo, useRef, useState } from "react";
import { NoteBody } from "./NoteBody";
import { NoteContent } from "./NoteContent";
import { Avatar } from "./Avatar";
import {
  NoteMenuIcon,
  OpenInDialog,
  type OpenInTarget,
} from "./OpenInDialog";
import { SettingsDialog } from "./SettingsDialog";
import { MuteAuthorDialog } from "./MuteAuthorDialog";
import {
  addIdentities,
  collectMentionIdentities,
  isUnmodifiedLeftClick,
  njumpHref,
  profileLabel,
} from "./mentions";
import {
  encodeNpub,
  isBlockedAuthorProfile,
  type Kind0Profile,
} from "./identity";
import { encodeNevent } from "./nostr-clients";
import {
  AskAiButton,
  AskAiPanel,
  type AskAiPanelHandle,
} from "./AskAiPanel";
import {
  fetchTrendingFeed,
  formatCreateAtDate,
  getKind0Profiles,
  readCachedKind0Profiles,
  WINDOW_PAGE_SIZE,
  type LocatedEvent,
  type NoteEngagement,
} from "./nostr";
import {
  muteAuthor,
  setTrendingHours,
  TRENDING_HOURS_OPTIONS,
  useMutedAuthors,
  useTrendingHours,
} from "./settings";

const SKELETON_LINE_COUNTS = [3, 2, 4, 2, 3] as const;

function filterHiddenAuthors(
  notes: LocatedEvent[],
  profiles: Record<string, Kind0Profile>,
  mutedPubkeys: ReadonlySet<string>
): LocatedEvent[] {
  return notes.filter((note) => {
    const pubkey = note.pubkey.toLowerCase();
    if (mutedPubkeys.has(pubkey)) return false;
    return !isBlockedAuthorProfile(profiles[pubkey]);
  });
}

function visiblePageLength(eventCount: number, currentLength: number): number {
  if (eventCount === 0) return 0;
  const capped = Math.min(currentLength, eventCount);
  if (capped < WINDOW_PAGE_SIZE) {
    return Math.min(WINDOW_PAGE_SIZE, eventCount);
  }
  return capped;
}

/** Compact counts for engagement labels (e.g. 1.2k, 3.4M). */
function formatEngagementCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    const rounded =
      thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
    return `${rounded}k`;
  }
  const millions = value / 1_000_000;
  const rounded =
    millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10;
  return `${rounded}M`;
}

function ReplyIcon() {
  return (
    <svg className="note-stat-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 18.5 4 21.5V7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v7a2.5 2.5 0 0 1-2.5 2.5H7.5Z"
      />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg className="note-stat-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13 3 5.5 13.5H12l-1 7.5L18.5 10.5H12L13 3Z"
      />
    </svg>
  );
}

function ReactionIcon() {
  return (
    <svg className="note-stat-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 20.3S4.5 15.4 4.5 9.9A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.5 2.7c0 5.5-7.5 10.4-7.5 10.4Z"
      />
    </svg>
  );
}

function RepostIcon() {
  return (
    <svg className="note-stat-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 7h9.5A2.5 2.5 0 0 1 19 9.5V13M17 5l2 2-2 2M17 17H7.5A2.5 2.5 0 0 1 5 14.5V11M7 19l-2-2 2-2"
      />
    </svg>
  );
}

function NoteEngagementStats({
  stats,
  onOpen,
}: {
  stats: NoteEngagement;
  onOpen: () => void;
}) {
  // Order matches common Nostr clients (e.g. Primal): reply, zap, reaction, repost.
  const items = [
    {
      key: "replies",
      value: stats.replies,
      label: "replies",
      icon: <ReplyIcon />,
    },
    {
      key: "zaps",
      value: stats.zapAmount,
      label: "sats",
      icon: <ZapIcon />,
    },
    {
      key: "reactions",
      value: stats.reactions,
      label: "reactions",
      icon: <ReactionIcon />,
    },
    {
      key: "reposts",
      value: stats.reposts,
      label: "reposts",
      icon: <RepostIcon />,
    },
  ];

  const summary = items
    .map((item) => `${item.value.toLocaleString()} ${item.label}`)
    .join(", ");

  return (
    <button
      type="button"
      className="note-stats"
      aria-haspopup="dialog"
      aria-label={`Open this note in… Engagement: ${summary}`}
      title="Open this note in…"
      onClick={onOpen}
    >
      {items.map((item) => (
        <span
          key={item.key}
          className="note-stat"
          title={`${item.value.toLocaleString()} ${item.label}`}
        >
          {item.icon}
          <span className="note-stat-value" aria-hidden="true">
            {formatEngagementCount(item.value)}
          </span>
        </span>
      ))}
    </button>
  );
}

function NoteSkeleton({ lines }: { lines: number }) {
  return (
    <li className="note note-skeleton" aria-hidden="true">
      <div className="note-author">
        <span className="skeleton skeleton-avatar" />
        <span className="note-author-copy">
          <span className="skeleton skeleton-name" />
          <span className="skeleton skeleton-time" />
        </span>
      </div>
      <div className="note-skeleton-body">
        {Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            className={
              index === lines - 1
                ? "skeleton skeleton-line skeleton-line-short"
                : "skeleton skeleton-line"
            }
          />
        ))}
      </div>
    </li>
  );
}

function NoteAuthor({
  pubkey,
  createdAt,
  profile,
  onOpenProfile,
  onMute,
}: {
  pubkey: string;
  createdAt: number;
  profile?: Kind0Profile;
  onOpenProfile: (code: string) => void;
  onMute: () => void;
}) {
  const code = encodeNpub(pubkey);
  const name = profileLabel(pubkey, profile?.displayName);
  const timestamp = (
    <time dateTime={new Date(createdAt * 1000).toISOString()}>
      {formatCreateAtDate(createdAt)}
    </time>
  );

  const nameEl = code ? (
    <a
      className="note-author-name"
      href={njumpHref(code)}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (!isUnmodifiedLeftClick(event)) return;
        event.preventDefault();
        onOpenProfile(code);
      }}
    >
      {name}
    </a>
  ) : (
    <span className="note-author-name">{name}</span>
  );

  return (
    <div className="note-author">
      <Avatar src={profile?.picture} />
      <span className="note-author-copy">
        <span className="note-author-heading">
          {nameEl}
          <button
            type="button"
            className="note-mute"
            aria-label={`Mute ${name}`}
            title={`Mute ${name}`}
            onClick={onMute}
          >
            mute
          </button>
        </span>
        {timestamp}
      </span>
    </div>
  );
}

export default function App() {
  const trendingHours = useTrendingHours();
  const mutedAuthors = useMutedAuthors();
  const mutedPubkeys = useMemo(
    () => new Set(mutedAuthors),
    [mutedAuthors]
  );
  const [events, setEvents] = useState<LocatedEvent[]>([]);
  const [engagementById, setEngagementById] = useState<
    Record<string, NoteEngagement>
  >({});
  const [currentDataLength, setCurrentDataLength] = useState(0);
  const [profiles, setProfiles] = useState<Record<string, Kind0Profile>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [openTarget, setOpenTarget] = useState<OpenInTarget | null>(null);
  const [muteConfirm, setMuteConfirm] = useState<{
    pubkey: string;
    authorLabel: string;
  } | null>(null);
  const [askNote, setAskNote] = useState<LocatedEvent | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const askAiRef = useRef<AskAiPanelHandle>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setCurrentDataLength(0);
      setEvents([]);
      setEngagementById({});

      try {
        const feed = await fetchTrendingFeed(trendingHours);
        if (cancelled) return;
        // Seed cached kind 0 so known nostrmag.com authors drop before paint.
        const cached = readCachedKind0Profiles(
          feed.notes.map((note) => note.pubkey)
        );
        if (Object.keys(cached).length > 0) {
          setProfiles((prev) => ({ ...prev, ...cached }));
        }
        setEvents(feed.notes);
        setEngagementById(feed.engagementById);
        setCurrentDataLength(Math.min(WINDOW_PAGE_SIZE, feed.notes.length));
        if (feed.notes.length === 0) {
          setError("No trending notes right now. Try again in a moment.");
        }
      } catch (err) {
        if (cancelled) return;
        setEvents([]);
        setEngagementById({});
        setCurrentDataLength(0);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load trending notes."
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadToken, trendingHours]);

  const displayEvents = useMemo(
    () => filterHiddenAuthors(events, profiles, mutedPubkeys),
    [events, profiles, mutedPubkeys]
  );

  const nonBlockedEvents = useMemo(
    () =>
      events.filter(
        (note) => !isBlockedAuthorProfile(profiles[note.pubkey.toLowerCase()])
      ),
    [events, profiles]
  );

  const allFilteredByMute =
    !loading &&
    !error &&
    displayEvents.length === 0 &&
    nonBlockedEvents.length > 0 &&
    nonBlockedEvents.every((note) =>
      mutedPubkeys.has(note.pubkey.toLowerCase())
    );

  const handleMuteAuthor = (pubkey: string) => {
    muteAuthor(pubkey);
    if (askNote?.pubkey.toLowerCase() === pubkey.toLowerCase()) {
      askAiRef.current?.close();
      setAskNote(null);
    }
  };

  // After profiles arrive and spam authors drop out, clamp the window and
  // top up the first page so the feed does not look sparsely loaded.
  useEffect(() => {
    setCurrentDataLength((prev) =>
      visiblePageLength(displayEvents.length, prev)
    );
  }, [displayEvents.length]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || currentDataLength >= displayEvents.length) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      setCurrentDataLength((prev) =>
        prev + WINDOW_PAGE_SIZE < displayEvents.length
          ? prev + WINDOW_PAGE_SIZE
          : displayEvents.length
      );
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [currentDataLength, displayEvents.length]);

  const visibleEvents = useMemo(
    () =>
      displayEvents.slice(
        0,
        visiblePageLength(displayEvents.length, currentDataLength)
      ),
    [displayEvents, currentDataLength]
  );

  // Prefetch authors + mentions for the full feed so scrolled-in notes already
  // have names/avatars (cache paints instantly; relays fill gaps in the background).
  useEffect(() => {
    if (events.length === 0) return;

    const identities = addIdentities(
      collectMentionIdentities(events.map((note) => note.content)),
      events.map((note) => ({
        pubkey: note.pubkey,
        relayHints: note.seenOn.filter((url) => url.startsWith("wss://")),
      }))
    );

    const pubkeys = identities.map((id) => id.pubkey);
    const mergeProfiles = (
      prev: Record<string, Kind0Profile>,
      found: Record<string, Kind0Profile>
    ) => {
      let changed = false;
      const next = { ...prev };
      for (const [pubkey, profile] of Object.entries(found)) {
        if (prev[pubkey] === profile) continue;
        next[pubkey] = profile;
        changed = true;
      }
      return changed ? next : prev;
    };

    const cached = readCachedKind0Profiles(pubkeys);
    if (Object.keys(cached).length > 0) {
      setProfiles((prev) => mergeProfiles(prev, cached));
    }

    let cancelled = false;
    void getKind0Profiles(pubkeys).then((found) => {
      if (cancelled) return;
      setProfiles((prev) => mergeProfiles(prev, found));
    });

    return () => {
      cancelled = true;
    };
  }, [events]);

  return (
    <main className="page">
      <header className="hero">
        <h1>Trending Nostr</h1>
        <div className="hero-actions">
          <button
            type="button"
            className="hero-action"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.49.49 0 0 0-.59.22L2.77 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.89 14.5a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.39.3.59.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z"
              />
            </svg>
          </button>
          <a
            className="hero-action"
            href="https://github.com/SamSamskies/trendingnostr"
            target="_blank"
            rel="noreferrer"
            aria-label="View source on GitHub"
            title="View source on GitHub"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"
              />
            </svg>
          </a>
        </div>
      </header>

      <div
        className="feed-windows"
        role="group"
        aria-label="Trending time window"
      >
        {TRENDING_HOURS_OPTIONS.map((hours) => (
          <button
            key={hours}
            type="button"
            className="feed-window"
            aria-pressed={trendingHours === hours}
            onClick={() => setTrendingHours(hours)}
          >
            {hours}h
          </button>
        ))}
      </div>

      {loading ? (
        <>
          <p className="visually-hidden" role="status">
            Loading trending notes…
          </p>
          <ol className="results" aria-hidden="true">
            {SKELETON_LINE_COUNTS.map((lines, index) => (
              <NoteSkeleton key={index} lines={lines} />
            ))}
          </ol>
        </>
      ) : null}

      {!loading && (error || displayEvents.length === 0) ? (
        <div className="status status-error" role="status">
          <p>
            {error ??
              (allFilteredByMute
                ? "Every note in this window is from a muted author. Open Settings to manage mutes."
                : "No trending notes right now. Try again in a moment.")}
          </p>
          {allFilteredByMute ? (
            <button
              type="button"
              className="status-retry"
              onClick={() => setSettingsOpen(true)}
            >
              Open settings
            </button>
          ) : (
            <button
              type="button"
              className="status-retry"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              Try again
            </button>
          )}
        </div>
      ) : null}

      {!loading && !error && visibleEvents.length > 0 ? (
        <>
          <ol className="results">
            {visibleEvents.map((note) => {
              const engagement = engagementById[note.id.toLowerCase()];
              const authorProfile = profiles[note.pubkey.toLowerCase()];
              const openNote = () => {
                try {
                  setOpenTarget({
                    kind: "note",
                    code: encodeNevent(note),
                  });
                } catch {
                  /* ignore encode errors */
                }
              };
              const asking = askNote?.id === note.id;
              return (
                <li
                  key={note.id}
                  className={asking ? "note note-asking" : "note"}
                >
                  <button
                    type="button"
                    className="note-menu"
                    aria-haspopup="dialog"
                    aria-label="Open this note in…"
                    title="Open this note in…"
                    onClick={openNote}
                  >
                    <NoteMenuIcon />
                  </button>
                  <NoteAuthor
                    pubkey={note.pubkey}
                    createdAt={note.created_at}
                    profile={authorProfile}
                    onOpenProfile={(code) =>
                      setOpenTarget({ kind: "profile", code })
                    }
                    onMute={() =>
                      setMuteConfirm({
                        pubkey: note.pubkey,
                        authorLabel: profileLabel(
                          note.pubkey,
                          authorProfile?.displayName
                        ),
                      })
                    }
                  />
                  <NoteBody>
                    <NoteContent
                      content={note.content}
                      tags={note.tags}
                      profiles={profiles}
                      onOpen={(kind, code) => setOpenTarget({ kind, code })}
                    />
                  </NoteBody>
                  <div className="note-footer">
                    {engagement ? (
                      <NoteEngagementStats
                        stats={engagement}
                        onOpen={openNote}
                      />
                    ) : null}
                    <AskAiButton
                      pressed={asking}
                      onClick={() => {
                        if (askNote?.id === note.id) {
                          askAiRef.current?.close();
                          return;
                        }
                        setAskNote(note);
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <div ref={sentinelRef} className="sentinel" aria-hidden="true" />
        </>
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          profiles={profiles}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {openTarget ? (
        <OpenInDialog
          target={openTarget}
          onClose={() => setOpenTarget(null)}
        />
      ) : null}

      {muteConfirm ? (
        <MuteAuthorDialog
          authorLabel={muteConfirm.authorLabel}
          onConfirm={() => handleMuteAuthor(muteConfirm.pubkey)}
          onClose={() => setMuteConfirm(null)}
        />
      ) : null}

      {askNote ? (
        <AskAiPanel
          ref={askAiRef}
          note={askNote}
          profile={profiles[askNote.pubkey.toLowerCase()]}
          engagement={engagementById[askNote.id.toLowerCase()]}
          onClose={() => setAskNote(null)}
        />
      ) : null}
    </main>
  );
}
