import { SimplePool, type Event } from "nostr-tools";
import {
  HIDDEN_AUTHOR_PUBKEYS,
  SPAM_REPORTER_PUBKEY,
} from "../lib/hiddenAuthors.js";
import {
  isEligibleTrendingNote,
} from "../lib/noteContent.js";
import {
  TRENDING_RELAY,
  WINE_TRENDING_API,
  WINE_TRENDING_LIMIT,
  TRENDING_FEED_NOTE_LIMIT,
  TRENDING_FEED_NOTE_LIMIT_4H,
  TRENDING_FEED_NOTE_LIMIT_12H,
  RELAY_ALIGNED_TRENDING_HOURS,
  WINE_MIN_REQUEST_INTERVAL_MS,
  EVENT_HYDRATION_RELAYS,
  ENGAGEMENT_RELAYS,
  ENGAGEMENT_BACKFILL_MAX,
  ENGAGEMENT_ID_CHUNK_SIZE,
  ENGAGEMENT_QUERY_LIMIT,
  RELAY_MAX_WAIT_MS,
  TRENDING_FETCH_ATTEMPTS,
  VERTEX_PROFILE_RELAY,
  FALLBACK_PROFILE_RELAYS,
  PROFILE_RELAYS,
  RANK_MISSING_VERTEX_PROFILE_FACTOR,
  RANK_EXCESS_HASHTAG_FACTOR,
  RANK_EXCESS_HTTP_LINK_FACTOR,
  RANK_DOWNRANKED_LINK_HOST_FACTOR,
  chunkArray,
  excessHashtagRankFactor,
  excessHttpLinkRankFactor,
  trendingFeedNoteLimit,
  scoreTrendingNote,
  rankTrendingNotes,
  limitTrendingFeed,
  type NoteEngagement,
} from "../lib/trendingShared.js";
import { fetchVertexProfilePubkeys } from "../lib/vertexProfiles.js";
import { isPrivateOrLocalHostname, parseKind0Profile, type Kind0Profile } from "./identity";
import { PAYTO_KIND } from "./paymentTargets";
import {
  FAYAN_CONCURRENCY,
  fetchFayanUsers,
  revealedNotesPrefix,
  uniquePubkeysInOrder,
  type FayanUserMap,
} from "./fayan";
import {
  isFayanFilterEnabled,
  type TrendingHours,
} from "./settings";

export type LocatedEvent = Event & { seenOn: string[] };

export {
  TRENDING_RELAY,
  WINE_TRENDING_API,
  WINE_TRENDING_LIMIT,
  TRENDING_FEED_NOTE_LIMIT,
  TRENDING_FEED_NOTE_LIMIT_4H,
  TRENDING_FEED_NOTE_LIMIT_12H,
  trendingFeedNoteLimit,
  RELAY_ALIGNED_TRENDING_HOURS,
  WINE_MIN_REQUEST_INTERVAL_MS,
  EVENT_HYDRATION_RELAYS,
  ENGAGEMENT_RELAYS,
  ENGAGEMENT_BACKFILL_MAX,
  ENGAGEMENT_ID_CHUNK_SIZE,
  ENGAGEMENT_QUERY_LIMIT,
  RELAY_MAX_WAIT_MS,
  TRENDING_FETCH_ATTEMPTS,
  VERTEX_PROFILE_RELAY,
  FALLBACK_PROFILE_RELAYS,
  PROFILE_RELAYS,
  RANK_MISSING_VERTEX_PROFILE_FACTOR,
  RANK_EXCESS_HASHTAG_FACTOR,
  RANK_EXCESS_HTTP_LINK_FACTOR,
  RANK_DOWNRANKED_LINK_HOST_FACTOR,
  chunkArray,
  excessHashtagRankFactor,
  excessHttpLinkRankFactor,
  scoreTrendingNote,
  rankTrendingNotes,
  limitTrendingFeed,
};
export { fetchVertexProfilePubkeys } from "../lib/vertexProfiles.js";
export {
  countHashtagTags,
  countHashtagsInContent,
  countNoteHashtags,
  countHttpLinks,
  hasDownrankedLinkHost,
  hasBannedLinkHost,
  isEligibleTrendingNote,
  MAX_HASHTAG_TAGS,
  MAX_HTTP_LINKS,
  DOWNRANKED_LINK_HOSTS,
  BANNED_LINK_HOSTS,
} from "../lib/noteContent.js";
export type { NoteEngagement };

/** Per-relay cap when fetching kind-1984 spam reports for feed note ids. */
const SPAM_REPORT_QUERY_LIMIT = 200;

/** Initial notes shown; more reveal as the sentinel scrolls into view. */
export const WINDOW_PAGE_SIZE = 5;
/** Extra Fayan-approved notes to keep ready ahead of the visible window. */
export const WINDOW_PREFETCH_AHEAD = 10;
export const AUTHOR_CHUNK_SIZE = 100;
/** Revalidate kind 0 entries after this age; stale cache is still served instantly. */
export const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;
const PROFILE_CACHE_STORAGE_KEY = "trendingnostr:kind0-profiles-v2";
const PROFILE_CACHE_MAX_ENTRIES = 500;

const EOSE_CLOSE_REASON = "closed automatically on eose";

export type TrendingRelayErrorCode = "rate_limited" | "connection_failed";

export class TrendingRelayError extends Error {
  readonly code: TrendingRelayErrorCode;

  constructor(code: TrendingRelayErrorCode, message: string) {
    super(message);
    this.name = "TrendingRelayError";
    this.code = code;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drop blank/JSON-only bodies and notes linking banned hosts. */
function filterEmptyContentNotes<T extends { content: string }>(notes: T[]): T[] {
  return notes.filter(isEligibleTrendingNote);
}

function isRateLimitedCloseReason(reason: string): boolean {
  return /rate[-_ ]?limited/i.test(reason);
}

function toLocatedEvents(
  events: Event[],
  seenOn: readonly string[]
): LocatedEvent[] {
  const ordered: LocatedEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (HIDDEN_AUTHOR_PUBKEYS.has(event.pubkey.toLowerCase())) continue;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    ordered.push({ ...event, seenOn: [...seenOn] });
  }
  return ordered;
}

type WineTrendingItem = {
  event_id?: unknown;
  reactions?: unknown;
  replies?: unknown;
  reposts?: unknown;
  zap_amount?: unknown;
};

type WineTrendingPayload = {
  ids: string[];
  engagementById: Record<string, NoteEngagement>;
};

function isEventId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function asNonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * querySync resolves with [] on connection failure, which the UI used to treat
 * as an empty feed. Track the close reason so we can retry real failures.
 */
type RelayFilter = {
  kinds?: number[];
  ids?: string[];
  authors?: string[];
  "#d"?: string[];
  limit?: number;
};

function queryRelayOnce(
  relays: readonly string[],
  filter: RelayFilter
): Promise<{
  events: Event[];
  closeReason: string;
}> {
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;

  return new Promise((resolve) => {
    const events: Event[] = [];
    pool.subscribeEose([...relays], filter, {
      maxWait: RELAY_MAX_WAIT_MS,
      onevent(event) {
        events.push(event);
      },
      onclose(reasons) {
        const closeReason = reasons[0]?.reason ?? "unknown";
        pool.destroy();
        resolve({ events, closeReason });
      },
    });
  });
}

/** Serialize wine calls and space them ≥1s so window switches cannot 429. */
let wineGate: Promise<void> = Promise.resolve();
let wineLastStartedAt = 0;

async function withWineRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const previous = wineGate;
  let release!: () => void;
  wineGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    const waitMs = Math.max(
      0,
      WINE_MIN_REQUEST_INTERVAL_MS - (Date.now() - wineLastStartedAt)
    );
    if (waitMs > 0) await sleep(waitMs);
    wineLastStartedAt = Date.now();
    return await fn();
  } finally {
    release();
  }
}

async function fetchWineTrending(
  hours: TrendingHours
): Promise<WineTrendingPayload> {
  return withWineRateLimit(async () => {
    const url = new URL(WINE_TRENDING_API);
    url.searchParams.set("limit", String(WINE_TRENDING_LIMIT));
    url.searchParams.set("hours", String(hours));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`nostr.wine trending API HTTP ${response.status}`);
    }

    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("nostr.wine trending API returned a non-array body.");
    }

    const ids: string[] = [];
    const engagementById: Record<string, NoteEngagement> = {};
    const seen = new Set<string>();
    for (const item of data as WineTrendingItem[]) {
      const id = item?.event_id;
      if (!isEventId(id)) continue;
      const normalized = id.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      ids.push(normalized);
      engagementById[normalized] = {
        reactions: asNonNegInt(item.reactions),
        replies: asNonNegInt(item.replies),
        reposts: asNonNegInt(item.reposts),
        zapAmount: asNonNegInt(item.zap_amount),
      };
    }
    return { ids, engagementById };
  });
}

/**
 * Ranking from wine HTTP API, full notes from public relays (wine order preserved).
 */
async function hydrateTrendingNotesFromWine(
  wine: WineTrendingPayload
): Promise<LocatedEvent[]> {
  const { ids } = wine;
  if (ids.length === 0) return [];

  const { events, closeReason } = await queryRelayOnce(EVENT_HYDRATION_RELAYS, {
    ids,
    kinds: [1],
  });

  if (events.length === 0) {
    throw new Error(
      `Could not hydrate trending notes from backup relays (${closeReason}).`
    );
  }

  const byId = new Map(events.map((event) => [event.id.toLowerCase(), event]));
  const ordered: Event[] = [];
  for (const id of ids) {
    const event = byId.get(id);
    if (event) ordered.push(event);
  }
  return toLocatedEvents(ordered, EVENT_HYDRATION_RELAYS);
}

const eventByIdCache = new Map<string, Promise<Event | null>>();
const eventByAddressCache = new Map<string, Promise<Event | null>>();

function mergeHydrationRelays(relayHints: readonly string[]): string[] {
  return [
    ...EVENT_HYDRATION_RELAYS,
    ...relayHints
      .map((url) => url.replace(/\/+$/, ""))
      .filter(
        (url) =>
          url.startsWith("wss://") &&
          url !== "wss://relay.nostr.band" &&
          !(EVENT_HYDRATION_RELAYS as readonly string[]).includes(url)
      ),
  ];
}

/**
 * Fetch a single event by id for quote embeds. Merges optional NIP-19 relay
 * hints with the usual hydration relays. Callers check `event.kind`.
 * Module-level cache like link previews; misses are dropped so a remount can
 * retry.
 */
export function fetchEventById(
  id: string,
  relayHints: readonly string[] = [],
  authorHint?: string
): Promise<Event | null> {
  const normalized = id.trim().toLowerCase();
  if (!isEventId(normalized)) return Promise.resolve(null);
  const candidateAuthor = authorHint?.trim().toLowerCase();
  const normalizedAuthor =
    candidateAuthor && isEventId(candidateAuthor) ? candidateAuthor : undefined;
  const cacheKey = normalizedAuthor
    ? `${normalized}:${normalizedAuthor}`
    : normalized;

  const existing = eventByIdCache.get(cacheKey);
  if (existing) return existing;

  const hydrationRelays = mergeHydrationRelays(relayHints);
  const pending = queryRelayOnce(hydrationRelays, {
    ids: [normalized],
  })
    .then(async ({ events }) => {
      const match =
        events.find((event) => event.id.toLowerCase() === normalized) ?? null;
      if (match) return match;

      const outboxMatch =
        normalizedAuthor
          ? await fetchEventFromAuthorOutbox(
              normalized,
              normalizedAuthor,
              hydrationRelays
            )
          : null;
      if (!outboxMatch && eventByIdCache.get(cacheKey) === pending) {
        eventByIdCache.delete(cacheKey);
      }
      return outboxMatch;
    })
    .catch(() => {
      if (eventByIdCache.get(cacheKey) === pending) {
        eventByIdCache.delete(cacheKey);
      }
      return null;
    });

  eventByIdCache.set(cacheKey, pending);
  return pending;
}

/**
 * Fetch a parameterized replaceable event (e.g. kind 30023 long-form) by
 * author + `d` identifier. Cache key is `kind:pubkey:identifier`.
 */
export function fetchEventByAddress(
  kind: number,
  pubkey: string,
  identifier: string,
  relayHints: readonly string[] = []
): Promise<Event | null> {
  const author = pubkey.trim().toLowerCase();
  const d = identifier.trim();
  if (!author || !d || !Number.isInteger(kind) || kind < 0) {
    return Promise.resolve(null);
  }

  const cacheKey = `${kind}:${author}:${d}`;
  const existing = eventByAddressCache.get(cacheKey);
  if (existing) return existing;

  const pending = queryRelayOnce(mergeHydrationRelays(relayHints), {
    kinds: [kind],
    authors: [author],
    "#d": [d],
    limit: 1,
  })
    .then(({ events }) => {
      const match =
        events.find(
          (event) =>
            event.kind === kind &&
            event.pubkey.toLowerCase() === author &&
            event.tags.some((tag) => tag[0] === "d" && tag[1] === d)
        ) ?? null;
      if (!match && eventByAddressCache.get(cacheKey) === pending) {
        eventByAddressCache.delete(cacheKey);
      }
      return match;
    })
    .catch(() => {
      if (eventByAddressCache.get(cacheKey) === pending) {
        eventByAddressCache.delete(cacheKey);
      }
      return null;
    });

  eventByAddressCache.set(cacheKey, pending);
  return pending;
}

function emptyEngagement(): NoteEngagement {
  return { reactions: 0, replies: 0, reposts: 0, zapAmount: 0 };
}

/**
 * Minimal BOLT11 amount parse for zap receipts (lnbc… only). Mirrors
 * nostr-tools nip57 getSatoshisAmountFromBolt11 without the typed export.
 */
function satsFromBolt11(bolt11: string): number {
  if (bolt11.length < 50 || !bolt11.startsWith("lnbc")) return 0;
  const prefix = bolt11.slice(0, 50);
  const sep = prefix.lastIndexOf("1");
  if (sep < 4) return 0;
  const amount = prefix.slice(4, sep);
  if (!amount) return 0;

  const multipliers: Record<string, number> = {
    m: 1e5,
    u: 1e2,
    n: 0.1,
    p: 0.0001,
  };
  const last = amount[amount.length - 1]!;
  if (last in multipliers) {
    const n = Number(amount.slice(0, -1));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n * multipliers[last]!);
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n * 1e8);
}

function zapSatsFromReceipt(event: Event): number {
  const bolt11 = event.tags.find((tag) => tag[0] === "bolt11")?.[1];
  if (!bolt11) return 0;
  try {
    return Math.max(0, satsFromBolt11(bolt11));
  } catch {
    return 0;
  }
}

/** Note ids from `e` tags that are in the wanted set (lowercase). */
function taggedWantedIds(event: Event, wanted: Set<string>): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "e" || !isEventId(tag[1])) continue;
    const id = tag[1].toLowerCase();
    if (!wanted.has(id) || seen.has(id)) continue;
    seen.add(id);
    hits.push(id);
  }
  return hits;
}

/**
 * Count reactions / replies / reposts / zap sats for note ids by querying
 * public relays for events that `#e`-tag them. Incomplete vs wine (relay
 * views only) but enough to rank notes wine never returned.
 */
async function fetchRelayEngagement(
  noteIds: string[]
): Promise<Record<string, NoteEngagement>> {
  const wanted = [
    ...new Set(
      noteIds.map((id) => id.toLowerCase()).filter((id) => isEventId(id))
    ),
  ];
  if (wanted.length === 0) return {};

  const wantedSet = new Set(wanted);
  const byId: Record<string, NoteEngagement> = {};
  for (const id of wanted) byId[id] = emptyEngagement();

  const seenEventIds = new Set<string>();
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;

  try {
    for (const chunk of chunkArray(wanted, ENGAGEMENT_ID_CHUNK_SIZE)) {
      const settled = await Promise.allSettled(
        ENGAGEMENT_RELAYS.map((relay) =>
          pool.querySync(
            [relay],
            {
              kinds: [1, 6, 7, 16, 9735],
              "#e": chunk,
              limit: ENGAGEMENT_QUERY_LIMIT,
            },
            { maxWait: RELAY_MAX_WAIT_MS }
          )
        )
      );

      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const event of result.value) {
          if (seenEventIds.has(event.id)) continue;
          seenEventIds.add(event.id);

          for (const target of taggedWantedIds(event, wantedSet)) {
            if (event.id.toLowerCase() === target) continue;
            const eng = byId[target];
            if (!eng) continue;

            if (event.kind === 7) eng.reactions += 1;
            else if (event.kind === 6 || event.kind === 16) eng.reposts += 1;
            else if (event.kind === 9735) eng.zapAmount += zapSatsFromReceipt(event);
            else if (event.kind === 1) eng.replies += 1;
          }
        }
      }
    }
  } finally {
    pool.destroy();
  }

  return byId;
}

/**
 * Fill engagement gaps with relay counts. Wine values win on conflict.
 * Soft-fails: returns the wine map unchanged if relays error.
 */
async function enrichEngagementFromRelays(
  notes: LocatedEvent[],
  engagementById: Record<string, NoteEngagement>
): Promise<Record<string, NoteEngagement>> {
  const missing: string[] = [];
  for (const note of notes) {
    const id = note.id.toLowerCase();
    if (!engagementById[id]) missing.push(id);
  }
  if (missing.length === 0) return engagementById;

  try {
    const relayEngagement = await fetchRelayEngagement(
      missing.slice(0, ENGAGEMENT_BACKFILL_MAX)
    );
    const merged: Record<string, NoteEngagement> = { ...engagementById };
    for (const [id, eng] of Object.entries(relayEngagement)) {
      if (merged[id]) continue;
      if (
        eng.reactions > 0 ||
        eng.replies > 0 ||
        eng.reposts > 0 ||
        eng.zapAmount > 0
      ) {
        merged[id] = eng;
      }
    }
    return merged;
  } catch {
    return engagementById;
  }
}

/** NIP-56: report type is the 3rd tag entry; some clients put a relay URL before it. */
function spamReportedEventIdFromETag(tag: string[]): string | null {
  if (tag[0] !== "e" || !isEventId(tag[1])) return null;
  if (!tag.slice(2).includes("spam")) return null;
  return tag[1].toLowerCase();
}

/**
 * Event ids the spam reporter marked kind-1984 `spam` among `noteIds`.
 * Soft-fails to an empty set if relays error.
 */
async function fetchSpamReportedEventIds(
  noteIds: string[]
): Promise<Set<string>> {
  const wanted = [
    ...new Set(
      noteIds.map((id) => id.toLowerCase()).filter((id) => isEventId(id))
    ),
  ];
  if (wanted.length === 0) return new Set();

  const wantedSet = new Set(wanted);
  const spamIds = new Set<string>();
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;

  try {
    for (const chunk of chunkArray(wanted, ENGAGEMENT_ID_CHUNK_SIZE)) {
      const settled = await Promise.allSettled(
        ENGAGEMENT_RELAYS.map((relay) =>
          pool.querySync(
            [relay],
            {
              kinds: [1984],
              authors: [SPAM_REPORTER_PUBKEY],
              "#e": chunk,
              limit: SPAM_REPORT_QUERY_LIMIT,
            },
            { maxWait: RELAY_MAX_WAIT_MS }
          )
        )
      );

      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const event of result.value) {
          if (event.kind !== 1984) continue;
          if (event.pubkey.toLowerCase() !== SPAM_REPORTER_PUBKEY) continue;
          for (const tag of event.tags) {
            const id = spamReportedEventIdFromETag(tag);
            if (id && wantedSet.has(id)) spamIds.add(id);
          }
        }
      }
    }
  } catch {
    return new Set();
  } finally {
    pool.destroy();
  }

  return spamIds;
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

export type TrendingFeed = {
  notes: LocatedEvent[];
  /** Join key is lowercase event id. Empty when wine metadata is unavailable. */
  engagementById: Record<string, NoteEngagement>;
};

/**
 * When Fayan is on, `feed.notes` are hashtag-filtered candidates. Call
 * `fayanReveal.ensureRevealed(n)` after paint (and again on scroll) to resolve
 * only as many author waves as needed for `n` visible notes.
 */
export type FayanRevealController = {
  /** Fetch waves until at least `minNotes` pass filter, or candidates run out. */
  ensureRevealed: (minNotes: number) => Promise<LocatedEvent[]>;
  /** True while unchecked candidate authors remain. */
  hasMore: () => boolean;
};

export type TrendingFeedResult = {
  feed: TrendingFeed;
  fayanReveal?: FayanRevealController;
};

/**
 * Lazy Fayan gate: resolve author waves on demand so a no-scroll visit only
 * pays for the first page. Failed waves fail-open those authors.
 */
function attachFayanReveal(feed: TrendingFeed): TrendingFeedResult {
  if (feed.notes.length === 0) return { feed };

  const candidates = feed.notes;
  const ordered = uniquePubkeysInOrder(candidates);
  let nextIndex = 0;
  const users: FayanUserMap = new Map();
  const resolved = new Set<string>();
  const passThrough = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();

  const snapshot = () =>
    revealedNotesPrefix(candidates, users, resolved, passThrough);

  const ensureRevealed = (minNotes: number): Promise<LocatedEvent[]> => {
    const run = async () => {
      while (snapshot().length < minNotes && nextIndex < ordered.length) {
        const chunk = ordered.slice(
          nextIndex,
          nextIndex + FAYAN_CONCURRENCY
        );
        nextIndex += chunk.length;
        const batch = await fetchFayanUsers(chunk);
        if (!batch) {
          for (const pubkey of chunk) passThrough.add(pubkey);
        } else {
          for (const pubkey of chunk) resolved.add(pubkey);
          for (const [pubkey, user] of batch) {
            users.set(pubkey, user);
          }
        }
      }
      return snapshot();
    };

    const done = chain.then(run, run);
    chain = done.then(
      () => undefined,
      () => undefined
    );
    return done;
  };

  return {
    feed,
    fayanReveal: {
      ensureRevealed,
      hasMore: () => nextIndex < ordered.length,
    },
  };
}

async function toTrendingFeed(
  notes: LocatedEvent[],
  engagementById: Record<string, NoteEngagement>,
  hours: TrendingHours
): Promise<TrendingFeedResult> {
  const withContent = filterEmptyContentNotes(notes);
  const [engagement, spamIds, vertexProfilePubkeys] = await Promise.all([
    enrichEngagementFromRelays(withContent, engagementById),
    fetchSpamReportedEventIds(withContent.map((note) => note.id)),
    fetchVertexProfilePubkeys(withContent.map((note) => note.pubkey)),
  ]);

  let visible =
    spamIds.size === 0
      ? withContent
      : withContent.filter((note) => !spamIds.has(note.id.toLowerCase()));

  // Rank before Fayan so reveal waves follow feed order.
  const limited = limitTrendingFeed(
    rankTrendingNotes(visible, engagement, { vertexProfilePubkeys }),
    engagement,
    trendingFeedNoteLimit(hours)
  );
  const ranked: TrendingFeed = {
    notes: limited.notes,
    engagementById: limited.engagementById,
  };

  if (!isFayanFilterEnabled()) return { feed: ranked };
  return attachFayanReveal(ranked);
}

/** Prefer the CDN-cached `/api/trending` blob; null on miss / error. */
async function fetchTrendingFeedFromApi(
  hours: TrendingHours
): Promise<TrendingFeed | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 50_000);
  try {
    const response = await fetch(`/api/trending?hours=${hours}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return null;
    const record = data as {
      notes?: unknown;
      engagementById?: unknown;
    };
    if (!Array.isArray(record.notes)) return null;
    if (
      !record.engagementById ||
      typeof record.engagementById !== "object" ||
      Array.isArray(record.engagementById)
    ) {
      return null;
    }

    return {
      notes: record.notes as LocatedEvent[],
      engagementById: record.engagementById as Record<string, NoteEngagement>,
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Fayan filter depends on local settings — apply after the shared server blob
 * (already ranked, spam-filtered, and capped per window).
 */
async function applyClientFeedFilters(
  feed: TrendingFeed,
  hours: TrendingHours
): Promise<TrendingFeedResult> {
  // Also drop empties on the API path so stale CDN blobs clear immediately.
  const visible = filterEmptyContentNotes(feed.notes);

  const limited = limitTrendingFeed(
    visible,
    feed.engagementById,
    trendingFeedNoteLimit(hours)
  );
  const next: TrendingFeed = {
    notes: limited.notes,
    engagementById: limited.engagementById,
  };

  if (!isFayanFilterEnabled()) return { feed: next };
  return attachFayanReveal(next);
}

/**
 * Fetch trending kind 1 notes for the given window.
 *
 * Prefers the CDN-cached `/api/trending` blob (warmed by cron). Falls back to
 * the legacy browser path when the API is unavailable (plain Vite, cold fail).
 *
 * For the relay-aligned window (48h): trending relay candidates, re-ranked with
 * wine engagement + age decay. On rate-limit / connect failure, falls back to
 * wine HTTP ids + public-relay hydration.
 *
 * For shorter windows (4h / 12h / 24h): wine HTTP is the candidate source (the
 * trending relay has no hours filter), then the same enrich + re-rank.
 */
export async function fetchTrendingFeed(
  hours: TrendingHours = RELAY_ALIGNED_TRENDING_HOURS
): Promise<TrendingFeedResult> {
  const cached = await fetchTrendingFeedFromApi(hours);
  if (cached) {
    return applyClientFeedFilters(cached, hours);
  }

  if (hours !== RELAY_ALIGNED_TRENDING_HOURS) {
    return fetchTrendingFeedFromWine(hours);
  }

  // Soft-fail: notes still render if wine is down or rate-limited.
  const winePromise = fetchWineTrending(hours).then(
    (payload) => payload,
    () => null
  );

  let lastCloseReason = "unknown";
  let relayError: TrendingRelayError | null = null;

  for (let attempt = 0; attempt < TRENDING_FETCH_ATTEMPTS; attempt++) {
    const { events, closeReason } = await queryRelayOnce([TRENDING_RELAY], {
      kinds: [1],
    });
    lastCloseReason = closeReason;

    if (events.length > 0) {
      const wine = await winePromise;
      return toTrendingFeed(
        toLocatedEvents(events, [TRENDING_RELAY]),
        wine?.engagementById ?? {},
        hours
      );
    }

    // Genuine empty reply from a healthy subscription.
    if (closeReason === EOSE_CLOSE_REASON) {
      const wine = await winePromise;
      return toTrendingFeed([], wine?.engagementById ?? {}, hours);
    }

    if (isRateLimitedCloseReason(closeReason)) {
      relayError = new TrendingRelayError(
        "rate_limited",
        "The trending relay is rate-limiting this connection."
      );
      break;
    }

    if (attempt < TRENDING_FETCH_ATTEMPTS - 1) {
      await sleep(250 * (attempt + 1));
    }
  }

  if (!relayError) {
    relayError = new TrendingRelayError(
      "connection_failed",
      `Could not connect to the trending relay (${lastCloseReason}).`
    );
  }

  try {
    let wine = await winePromise;
    // Parallel request may have failed; retry once (rate gate spaces it).
    if (!wine) {
      wine = await fetchWineTrending(hours);
    }

    // Successful fallback (including empty) is the feed state — don't mask as relay error.
    return toTrendingFeed(
      await hydrateTrendingNotesFromWine(wine),
      wine.engagementById,
      hours
    );
  } catch {
    // Prefer the original relay error if hydration also fails.
  }

  throw new TrendingRelayError(
    relayError.code,
    `${relayError.message} Try again.`
  );
}

async function fetchTrendingFeedFromWine(
  hours: TrendingHours
): Promise<TrendingFeedResult> {
  let wine: WineTrendingPayload;
  try {
    wine = await fetchWineTrending(hours);
  } catch {
    // One retry after the shared rate gate spaces the next call.
    wine = await fetchWineTrending(hours);
  }
  return toTrendingFeed(
    await hydrateTrendingNotesFromWine(wine),
    wine.engagementById,
    hours
  );
}

type Kind0Record = {
  profile: Kind0Profile;
  created_at: number;
};

type CachedKind0 = Kind0Record & {
  cachedAt: number;
};

let profileMemoryCache: Map<string, CachedKind0> | null = null;

function normalizePubkeys(pubkeys: string[]): string[] {
  return [
    ...new Set(
      pubkeys
        .map((p) => p.trim().toLowerCase())
        .filter((p) => /^[0-9a-f]{64}$/.test(p))
    ),
  ];
}

function isFreshCacheEntry(entry: CachedKind0, now = Date.now()): boolean {
  return now - entry.cachedAt < PROFILE_CACHE_TTL_MS;
}

function getProfileMemoryCache(): Map<string, CachedKind0> {
  if (profileMemoryCache) return profileMemoryCache;

  profileMemoryCache = new Map();
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_STORAGE_KEY);
    if (!raw) return profileMemoryCache;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    for (const [pubkey, value] of Object.entries(parsed)) {
      if (!/^[0-9a-f]{64}$/.test(pubkey) || !value || typeof value !== "object") {
        continue;
      }
      const entry = value as Partial<CachedKind0>;
      if (
        typeof entry.created_at !== "number" ||
        typeof entry.cachedAt !== "number" ||
        !entry.profile ||
        typeof entry.profile !== "object"
      ) {
        continue;
      }
      // Drop very old rows so storage cannot grow forever.
      if (now - entry.cachedAt > PROFILE_CACHE_TTL_MS * 7) continue;
      profileMemoryCache.set(pubkey, {
        profile: entry.profile as Kind0Profile,
        created_at: entry.created_at,
        cachedAt: entry.cachedAt,
      });
    }
  } catch {
    // Ignore corrupt / unavailable storage.
  }

  return profileMemoryCache;
}

function persistProfileMemoryCache(): void {
  const cache = getProfileMemoryCache();
  const entries = [...cache.entries()].sort(
    (a, b) => b[1].cachedAt - a[1].cachedAt
  );
  if (entries.length > PROFILE_CACHE_MAX_ENTRIES) {
    for (const [pubkey] of entries.slice(PROFILE_CACHE_MAX_ENTRIES)) {
      cache.delete(pubkey);
    }
  }

  const payload: Record<string, CachedKind0> = {};
  for (const [pubkey, entry] of cache) {
    payload[pubkey] = entry;
  }

  try {
    localStorage.setItem(PROFILE_CACHE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private mode — memory cache still works for the session.
  }
}

function rememberKind0Profiles(records: Map<string, Kind0Record>): void {
  if (records.size === 0) return;

  const cache = getProfileMemoryCache();
  const now = Date.now();
  let changed = false;

  for (const [pubkey, record] of records) {
    const prev = cache.get(pubkey);
    if (prev && prev.created_at >= record.created_at) {
      if (!isFreshCacheEntry(prev, now)) {
        cache.set(pubkey, { ...prev, cachedAt: now });
        changed = true;
      }
      continue;
    }
    cache.set(pubkey, {
      profile: record.profile,
      created_at: record.created_at,
      cachedAt: now,
    });
    changed = true;
  }

  if (changed) persistProfileMemoryCache();
}

/**
 * Synchronous cache read for instant avatars/names before relays respond.
 */
export function readCachedKind0Profiles(
  pubkeys: string[]
): Record<string, Kind0Profile> {
  const cache = getProfileMemoryCache();
  const found: Record<string, Kind0Profile> = {};
  for (const pubkey of normalizePubkeys(pubkeys)) {
    const entry = cache.get(pubkey);
    if (entry) found[pubkey] = entry.profile;
  }
  return found;
}

/** Cache timestamp for tip confirmation freshness; null if missing. */
export function readCachedKind0CachedAt(pubkey: string): number | null {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return null;
  return getProfileMemoryCache().get(author)?.cachedAt ?? null;
}

/**
 * Load kind 0 profiles from Vertex and Primal/Ditto in parallel; keep newest
 * per pubkey. Vertex is queried separately so its curated set stays distinct
 * from display fallbacks. Serves localStorage/memory cache first and only
 * queries relays for missing or stale pubkeys.
 */
export async function getKind0Profiles(
  pubkeys: string[]
): Promise<Record<string, Kind0Profile>> {
  const unique = normalizePubkeys(pubkeys);
  if (unique.length === 0) return {};

  const cache = getProfileMemoryCache();
  const now = Date.now();
  const found: Record<string, Kind0Profile> = {};
  const toFetch: string[] = [];

  for (const pubkey of unique) {
    const entry = cache.get(pubkey);
    if (entry) {
      found[pubkey] = entry.profile;
      if (!isFreshCacheEntry(entry, now)) toFetch.push(pubkey);
    } else {
      toFetch.push(pubkey);
    }
  }

  if (toFetch.length === 0) return found;

  const byPubkey = new Map<string, Kind0Record>();
  const pool = new SimplePool();

  try {
    for (const authors of chunkArray(toFetch, AUTHOR_CHUNK_SIZE)) {
      const filter = { kinds: [0], authors, limit: authors.length };
      const opts = { maxWait: RELAY_MAX_WAIT_MS };

      // Vertex (curated) first in the list; Primal/Ditto fall back — all parallel.
      const settled = await Promise.allSettled([
        pool.querySync([VERTEX_PROFILE_RELAY], filter, opts),
        ...FALLBACK_PROFILE_RELAYS.map((relay) =>
          pool.querySync([relay], filter, opts)
        ),
      ]);

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
    // Return whatever we collected (including cache hits).
  } finally {
    pool.destroy();
  }

  rememberKind0Profiles(byPubkey);

  for (const [pubkey, record] of byPubkey) {
    found[pubkey] = record.profile;
  }
  return found;
}

/**
 * Kind 10133 (NIP-A3 payto) for Tip. Prefer the author's NIP-65 write relays
 * (outbox), then fall back to a small fixed set — many payto events never
 * reach Primal/Ditto.
 */
const RELAY_LIST_KIND = 10002;
const OUTBOX_DISCOVERY_RELAYS = [
  ...FALLBACK_PROFILE_RELAYS,
  "wss://relay.damus.io",
] as const;
const PAYTO_FALLBACK_RELAYS = OUTBOX_DISCOVERY_RELAYS;
const PAYTO_RELAY_CAP = 8;

/** Keep tip reopen snappy; payto rarely changes mid-session. */
const PAYTO_CACHE_TTL_MS = 15 * 60 * 1000;
const PAYTO_CACHE_MAX_ENTRIES = 100;

type PaytoCacheEntry = {
  tags: string[][];
  cachedAt: number;
};

type RelayListCacheEntry = {
  writeRelays: string[];
  cachedAt: number;
};

const paytoMemoryCache = new Map<string, PaytoCacheEntry>();
const paytoInflight = new Map<string, Promise<string[][]>>();
const relayListMemoryCache = new Map<string, RelayListCacheEntry>();
const relayListInflight = new Map<string, Promise<string[]>>();

/** Sync cache hit for Tip drawer initial state; null if missing/stale. */
export function readCachedPaytoTags(pubkey: string): string[][] | null {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return null;
  const entry = paytoMemoryCache.get(author);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > PAYTO_CACHE_TTL_MS) return null;
  return entry.tags;
}

/** Cache timestamp for tip confirmation freshness; null if missing/stale. */
export function readCachedPaytoCachedAt(pubkey: string): number | null {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return null;
  const entry = paytoMemoryCache.get(author);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > PAYTO_CACHE_TTL_MS) return null;
  return entry.cachedAt;
}

function rememberPaytoTags(author: string, tags: string[][]): void {
  paytoMemoryCache.set(author, { tags, cachedAt: Date.now() });
  trimCache(paytoMemoryCache, PAYTO_CACHE_MAX_ENTRIES);
}

function rememberRelayList(author: string, writeRelays: string[]): void {
  relayListMemoryCache.set(author, { writeRelays, cachedAt: Date.now() });
  trimCache(relayListMemoryCache, PAYTO_CACHE_MAX_ENTRIES);
}

function trimCache<T extends { cachedAt: number }>(
  cache: Map<string, T>,
  maxEntries: number
): void {
  if (cache.size <= maxEntries) return;
  const oldest = [...cache.entries()].sort(
    (a, b) => a[1].cachedAt - b[1].cachedAt
  );
  for (const [key] of oldest.slice(0, cache.size - maxEntries)) {
    cache.delete(key);
  }
}

function normalizeRelayUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    // Author outbox hints are fetched on tip hover — wss only, no private hosts.
    if (url.protocol !== "wss:") return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === "relay.nostr.band") return null;
    if (isPrivateOrLocalHostname(host)) return null;
    url.hash = "";
    url.search = "";
    let href = url.href;
    if (href.endsWith("/")) href = href.slice(0, -1);
    return href;
  } catch {
    return null;
  }
}

/** NIP-65 outbox: write-marked and unmarked `r` tags. */
function writeRelaysFromTags(tags: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "r" || typeof tag[1] !== "string") continue;
    const marker = typeof tag[2] === "string" ? tag[2].trim().toLowerCase() : "";
    if (marker === "read") continue;
    const url = normalizeRelayUrl(tag[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function mergePaytoRelays(writeRelays: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const relay of [...writeRelays, ...PAYTO_FALLBACK_RELAYS]) {
    const url = normalizeRelayUrl(relay);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= PAYTO_RELAY_CAP) break;
  }
  return out;
}

async function fetchAuthorWriteRelays(
  pool: SimplePool,
  author: string
): Promise<string[]> {
  const cached = relayListMemoryCache.get(author);
  if (cached && Date.now() - cached.cachedAt <= PAYTO_CACHE_TTL_MS) {
    return cached.writeRelays;
  }

  const pending = relayListInflight.get(author);
  if (pending) return pending;

  const request = (async () => {
    try {
      const settled = await Promise.allSettled(
        OUTBOX_DISCOVERY_RELAYS.map((relay) =>
          pool.querySync(
            [relay],
            { kinds: [RELAY_LIST_KIND], authors: [author], limit: 1 },
            { maxWait: RELAY_MAX_WAIT_MS }
          )
        )
      );

      let newest: Event | null = null;
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const event of result.value) {
          if (event.kind !== RELAY_LIST_KIND) continue;
          if (event.pubkey.toLowerCase() !== author) continue;
          if (!newest || event.created_at > newest.created_at) newest = event;
        }
      }
      const writeRelays = newest ? writeRelaysFromTags(newest.tags) : [];
      rememberRelayList(author, writeRelays);
      return writeRelays;
    } catch {
      rememberRelayList(author, []);
      return [];
    }
  })();

  relayListInflight.set(author, request);
  try {
    return await request;
  } finally {
    relayListInflight.delete(author);
  }
}

async function fetchEventFromAuthorOutbox(
  id: string,
  author: string,
  alreadyQueried: readonly string[]
): Promise<Event | null> {
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;
  try {
    const writeRelays = await fetchAuthorWriteRelays(pool, author);
    const queried = new Set(
      alreadyQueried.map((relay) => normalizeRelayUrl(relay)).filter(Boolean)
    );
    const outboxRelays = writeRelays
      .filter((relay) => !queried.has(relay))
      .slice(0, PAYTO_RELAY_CAP);
    if (outboxRelays.length === 0) return null;

    const settled = await Promise.allSettled(
      outboxRelays.map((relay) =>
        pool.querySync(
          [relay],
          { ids: [id], authors: [author] },
          { maxWait: RELAY_MAX_WAIT_MS }
        )
      )
    );
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const match = result.value.find(
        (event) =>
          event.id.toLowerCase() === id &&
          event.pubkey.toLowerCase() === author
      );
      if (match) return match;
    }
    return null;
  } catch {
    return null;
  } finally {
    pool.destroy();
  }
}

async function queryPaytoOnRelays(
  pool: SimplePool,
  author: string,
  relays: string[]
): Promise<Event | null> {
  if (relays.length === 0) return null;
  const settled = await Promise.allSettled(
    relays.map((relay) =>
      pool.querySync(
        [relay],
        { kinds: [PAYTO_KIND], authors: [author], limit: 1 },
        { maxWait: RELAY_MAX_WAIT_MS }
      )
    )
  );

  let newest: Event | null = null;
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const event of result.value) {
      if (event.kind !== PAYTO_KIND) continue;
      if (event.pubkey.toLowerCase() !== author) continue;
      if (!newest || event.created_at > newest.created_at) newest = event;
    }
  }
  return newest;
}

/** null = query failed; do not cache so a later open can retry. */
async function queryPaytoTags(author: string): Promise<string[][] | null> {
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;
  try {
    const fallbackRelays = mergePaytoRelays([]);
    const fallbackNewest = await queryPaytoOnRelays(
      pool,
      author,
      fallbackRelays
    );
    // Prefer the fast path: most tippable authors already appear on the
    // default set. Only pay the NIP-65 + outbox round trip on a miss.
    if (fallbackNewest) return fallbackNewest.tags;

    const writeRelays = await fetchAuthorWriteRelays(pool, author);
    const fallbackSet = new Set(fallbackRelays);
    const outboxOnly = mergePaytoRelays(writeRelays).filter(
      (relay) => !fallbackSet.has(relay)
    );
    const outboxNewest = await queryPaytoOnRelays(pool, author, outboxOnly);
    return outboxNewest?.tags ?? [];
  } catch {
    return null;
  } finally {
    pool.destroy();
  }
}

export async function fetchPaytoTags(pubkey: string): Promise<string[][]> {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return [];

  const cached = readCachedPaytoTags(author);
  if (cached !== null) return cached;

  const pending = paytoInflight.get(author);
  if (pending) return pending;

  const request = queryPaytoTags(author).then((tags) => {
    if (tags !== null) rememberPaytoTags(author, tags);
    return tags ?? [];
  });
  paytoInflight.set(author, request);
  try {
    return await request;
  } finally {
    paytoInflight.delete(author);
  }
}
