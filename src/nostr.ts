import { SimplePool, type Event } from "nostr-tools";
import { parseKind0Profile, type Kind0Profile } from "./identity";

export type LocatedEvent = Event & { seenOn: string[] };

export const TRENDING_RELAY = "wss://trending.relays.land";

export const PROFILE_RELAYS = [
  "wss://relay.vertexlab.io",
  "wss://purplepag.es",
] as const;

export const RELAY_MAX_WAIT_MS = 4500;
/** How many times to retry a failed trending-relay connection. */
export const TRENDING_FETCH_ATTEMPTS = 3;
/** Initial notes shown; more reveal as the sentinel scrolls into view. */
export const WINDOW_PAGE_SIZE = 5;
export const AUTHOR_CHUNK_SIZE = 100;

const EOSE_CLOSE_REASON = "closed automatically on eose";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toLocatedEvents(events: Event[]): LocatedEvent[] {
  const ordered: LocatedEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    ordered.push({ ...event, seenOn: [TRENDING_RELAY] });
  }
  return ordered;
}

/**
 * querySync resolves with [] on connection failure, which the UI used to treat
 * as an empty feed. Track the close reason so we can retry real failures.
 */
function queryTrendingOnce(): Promise<{
  events: Event[];
  closeReason: string;
}> {
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;

  return new Promise((resolve) => {
    const events: Event[] = [];
    pool.subscribeEose(
      [TRENDING_RELAY],
      { kinds: [1] },
      {
        maxWait: RELAY_MAX_WAIT_MS,
        onevent(event) {
          events.push(event);
        },
        onclose(reasons) {
          const closeReason = reasons[0]?.reason ?? "unknown";
          pool.destroy();
          resolve({ events, closeReason });
        },
      }
    );
  });
}

export const formatCreateAtDate = (unixTimestamp: number) => {
  const date = new Date(unixTimestamp * 1000);
  const formattedDate = date.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const formattedTime = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `${formattedDate} @ ${formattedTime}`;
};

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunkedArray: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunkedArray.push(array.slice(i, i + chunkSize));
  }
  return chunkedArray;
}

/**
 * Fetch trending kind 1 notes, preserving relay arrival order (do not sort
 * by created_at — that is the trending ranking). Takes the full stream until
 * EOSE; the UI windows what it renders.
 *
 * Retries when the relay WebSocket fails to connect — SimplePool otherwise
 * returns an empty array and the UI looks like an empty feed.
 */
export async function fetchTrendingNotes(): Promise<LocatedEvent[]> {
  let lastCloseReason = "unknown";

  for (let attempt = 0; attempt < TRENDING_FETCH_ATTEMPTS; attempt++) {
    const { events, closeReason } = await queryTrendingOnce();
    lastCloseReason = closeReason;

    if (events.length > 0) {
      return toLocatedEvents(events);
    }

    // Genuine empty reply from a healthy subscription.
    if (closeReason === EOSE_CLOSE_REASON) {
      return [];
    }

    if (attempt < TRENDING_FETCH_ATTEMPTS - 1) {
      await sleep(250 * (attempt + 1));
    }
  }

  throw new Error(
    `Could not connect to the trending relay (${lastCloseReason}). Try again.`
  );
}

type Kind0Record = {
  profile: Kind0Profile;
  created_at: number;
};

/**
 * Load kind 0 profiles from Vertex + purplepag.es in parallel; keep newest
 * per pubkey.
 */
export async function getKind0Profiles(
  pubkeys: string[]
): Promise<Record<string, Kind0Profile>> {
  const unique = [
    ...new Set(
      pubkeys
        .map((p) => p.trim().toLowerCase())
        .filter((p) => /^[0-9a-f]{64}$/.test(p))
    ),
  ];
  if (unique.length === 0) return {};

  const byPubkey = new Map<string, Kind0Record>();
  const pool = new SimplePool();

  try {
    for (const authors of chunkArray(unique, AUTHOR_CHUNK_SIZE)) {
      const settled = await Promise.allSettled(
        PROFILE_RELAYS.map((relay) =>
          pool.querySync([relay], { kinds: [0], authors, limit: authors.length }, {
            maxWait: RELAY_MAX_WAIT_MS,
          })
        )
      );

      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const event of result.value) {
          const pubkey = event.pubkey.toLowerCase();
          const prev = byPubkey.get(pubkey);
          if (prev && prev.created_at >= event.created_at) continue;
          byPubkey.set(pubkey, {
            profile: parseKind0Profile(event),
            created_at: event.created_at,
          });
        }
      }
    }
  } catch {
    // Return whatever we collected.
  } finally {
    pool.destroy();
  }

  const found: Record<string, Kind0Profile> = {};
  for (const [pubkey, record] of byPubkey) {
    found[pubkey] = record.profile;
  }
  return found;
}
