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
