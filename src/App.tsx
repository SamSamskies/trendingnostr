import { useEffect, useRef, useState } from "react";
import { NoteContent } from "./NoteContent";
import { Avatar } from "./Avatar";
import {
  NoteMenuIcon,
  OpenInDialog,
  type OpenInTarget,
} from "./OpenInDialog";
import {
  addIdentities,
  collectMentionIdentities,
  isUnmodifiedLeftClick,
  njumpHref,
  profileLabel,
} from "./mentions";
import { encodeNpub, type Kind0Profile } from "./identity";
import { encodeNevent } from "./nostr-clients";
import {
  fetchTrendingNotes,
  formatCreateAtDate,
  getKind0Profiles,
  WINDOW_PAGE_SIZE,
  type LocatedEvent,
} from "./nostr";

function NoteAuthor({
  pubkey,
  createdAt,
  profile,
  onOpenProfile,
}: {
  pubkey: string;
  createdAt: number;
  profile?: Kind0Profile;
  onOpenProfile: (code: string) => void;
}) {
  const code = encodeNpub(pubkey);
  const name = profileLabel(pubkey, profile?.displayName);
  const timestamp = (
    <time dateTime={new Date(createdAt * 1000).toISOString()}>
      {formatCreateAtDate(createdAt)}
    </time>
  );

  const body = (
    <>
      <Avatar src={profile?.picture} />
      <span className="note-author-copy">
        <span className="note-author-name">{name}</span>
        {timestamp}
      </span>
    </>
  );

  if (!code) {
    return <div className="note-author">{body}</div>;
  }

  return (
    <a
      className="note-author"
      href={njumpHref(code)}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (!isUnmodifiedLeftClick(event)) return;
        event.preventDefault();
        onOpenProfile(code);
      }}
    >
      {body}
    </a>
  );
}

export default function App() {
  const [events, setEvents] = useState<LocatedEvent[]>([]);
  const [currentDataLength, setCurrentDataLength] = useState(0);
  const [profiles, setProfiles] = useState<Record<string, Kind0Profile>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openTarget, setOpenTarget] = useState<OpenInTarget | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setCurrentDataLength(0);
      setEvents([]);

      try {
        const notes = await fetchTrendingNotes();
        if (cancelled) return;
        setEvents(notes);
        setCurrentDataLength(Math.min(WINDOW_PAGE_SIZE, notes.length));
        if (notes.length === 0) {
          setError("No trending notes right now. Try refreshing the page.");
        }
      } catch (err) {
        if (cancelled) return;
        setEvents([]);
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
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || currentDataLength >= events.length) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      setCurrentDataLength((prev) =>
        prev + WINDOW_PAGE_SIZE < events.length
          ? prev + WINDOW_PAGE_SIZE
          : events.length
      );
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [currentDataLength, events.length]);

  const visibleEvents = events.slice(0, currentDataLength);

  useEffect(() => {
    const visible = events.slice(0, currentDataLength);
    if (visible.length === 0) return;

    const identities = addIdentities(
      collectMentionIdentities(visible.map((note) => note.content)),
      visible.map((note) => ({
        pubkey: note.pubkey,
        relayHints: note.seenOn.filter((url) => url.startsWith("wss://")),
      }))
    );

    let cancelled = false;
    void getKind0Profiles(identities.map((id) => id.pubkey)).then((found) => {
      if (cancelled) return;
      setProfiles((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [pubkey, profile] of Object.entries(found)) {
          if (prev[pubkey] === profile) continue;
          next[pubkey] = profile;
          changed = true;
        }
        return changed ? next : prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [events, currentDataLength]);

  return (
    <main className="page">
      <header className="hero">
        <h1>Trending Nostr</h1>
        <a
          className="hero-github"
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
      </header>

      {loading ? (
        <p className="status" role="status">
          Loading trending notes…
        </p>
      ) : null}

      {!loading && error ? (
        <p className="status status-error" role="status">
          {error}
        </p>
      ) : null}

      {!loading && visibleEvents.length > 0 ? (
        <>
          <ol className="results">
            {visibleEvents.map((note) => (
              <li key={note.id} className="note">
                <button
                  type="button"
                  className="note-menu"
                  aria-haspopup="dialog"
                  aria-label="Open this note in…"
                  title="Open this note in…"
                  onClick={() => {
                    try {
                      setOpenTarget({
                        kind: "note",
                        code: encodeNevent(note),
                      });
                    } catch {
                      /* ignore encode errors */
                    }
                  }}
                >
                  <NoteMenuIcon />
                </button>
                <NoteAuthor
                  pubkey={note.pubkey}
                  createdAt={note.created_at}
                  profile={profiles[note.pubkey.toLowerCase()]}
                  onOpenProfile={(code) =>
                    setOpenTarget({ kind: "profile", code })
                  }
                />
                <div className="note-body">
                  <NoteContent
                    content={note.content}
                    tags={note.tags}
                    profiles={profiles}
                    onOpen={(kind, code) => setOpenTarget({ kind, code })}
                  />
                </div>
              </li>
            ))}
          </ol>
          <div ref={sentinelRef} className="sentinel" aria-hidden="true" />
        </>
      ) : null}

      {openTarget ? (
        <OpenInDialog
          target={openTarget}
          onClose={() => setOpenTarget(null)}
        />
      ) : null}
    </main>
  );
}
