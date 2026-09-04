import { SimplePool, type Event } from "nostr-tools";
import {
  HIDDEN_AUTHOR_PUBKEYS,
  SPAM_REPORTER_PUBKEY,
} from "../lib/hiddenAuthors.js";
import { parseKind0Profile, type Kind0Profile } from "./identity";
import {
  FAYAN_CONCURRENCY,
  fetchFayanUsers,
  revealedNotesPrefix,
  uniquePubkeysInOrder,
  type FayanUserMap,
} from "./fayan";
import {
  isFayanFilterEnabled,
  isHashtagFilterEnabled,
  type TrendingHours,
} from "./settings";

export type LocatedEvent = Event & { seenOn: string[] };

export const TRENDING_RELAY = "wss://trending.relays.land";

/** Public HTTP ranking API (same source the trending relay mirrors). */
export const WINE_TRENDING_API = "https://api.nostr.wine/trending";
export const WINE_TRENDING_LIMIT = 200;
/**
 * Window that matches the trending relay's candidate set. Wine's API max is 48h;
 * its default (4h) misses most relay-ranked notes.
 */
export const RELAY_ALIGNED_TRENDING_HOURS = 48;
/** nostr.wine trending API allows 1 request per second. */
export const WINE_MIN_REQUEST_INTERVAL_MS = 1000;

/**
 * Relays used to hydrate kind 1 events by id after a wine API lookup.
 * Note: `wss://nostr.wine` is payment-gated and rejects anonymous sockets (403).
 */
export const EVENT_HYDRATION_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.ditto.pub",
] as const;

export const PROFILE_RELAYS = [
  "wss://relay.vertexlab.io",
  "wss://relay.primal.net",
  "wss://relay.ditto.pub",
] as const;

/** Same relays as event hydration — used to count engagement when wine lacks a note. */
export const ENGAGEMENT_RELAYS = EVENT_HYDRATION_RELAYS;
/** Caps relay backfill latency (chunked `#e` queries). */
export const ENGAGEMENT_BACKFILL_MAX = 40;
export const ENGAGEMENT_ID_CHUNK_SIZE = 40;
/** Per-relay cap so kind-1 reply floods cannot stall EOSE. */
export const ENGAGEMENT_QUERY_LIMIT = 400;

/** Per-relay cap when fetching kind-1984 spam reports for feed note ids. */
const SPAM_REPORT_QUERY_LIMIT = 200;

/**
 * Notes with this many or more distinct `t` (hashtag) tags are hidden.
 * Spammers often bury hashtags in tags without putting them in content.
 */
const MAX_HASHTAG_TAGS = 3;

export const RELAY_MAX_WAIT_MS = 4500;
/** How many times to retry a failed trending-relay connection. */
export const TRENDING_FETCH_ATTEMPTS = 3;
/** Initial notes shown; more reveal as the sentinel scrolls into view. */
export const WINDOW_PAGE_SIZE = 5;
export const AUTHOR_CHUNK_SIZE = 100;
/** Revalidate kind 0 entries after this age; stale cache is still served instantly. */
export const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_CACHE_STORAGE_KEY = "trendingnostr:kind0-profiles";
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

/** Distinct non-empty `t` tag values on a kind 1 event (NIP-12 hashtags). */
export function countHashtagTags(tags: string[][]): number {
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "t") continue;
    const value = typeof tag[1] === "string" ? tag[1].trim().toLowerCase() : "";
    if (value) seen.add(value);
  }
  return seen.size;
}

function filterExcessHashtagNotes<T extends { tags: string[][] }>(
  notes: T[]
): T[] {
  return notes.filter((note) => countHashtagTags(note.tags) <= MAX_HASHTAG_TAGS);
}

/** Blank / whitespace-only kind 1 bodies — common spam; media notes put URLs in content. */
function hasNoteContent(note: { content: string }): boolean {
  return note.content.trim().length > 0;
}

function filterEmptyContentNotes<T extends { content: string }>(notes: T[]): T[] {
  return notes.filter(hasNoteContent);
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

export type NoteEngagement = {
  reactions: number;
  replies: number;
  reposts: number;
  zapAmount: number;
};

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
function queryRelayOnce(
  relays: readonly string[],
  filter: { kinds?: number[]; ids?: string[] }
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

/**
 * Fetch a single kind-1 note by id for quote embeds. Merges optional NIP-19
 * relay hints with the usual hydration relays. Module-level cache like link
 * previews; misses are dropped so a remount can retry.
 */
export function fetchEventById(
  id: string,
  relayHints: readonly string[] = []
): Promise<Event | null> {
  const normalized = id.trim().toLowerCase();
  if (!isEventId(normalized)) return Promise.resolve(null);

  const existing = eventByIdCache.get(normalized);
  if (existing) return existing;

  const relays = [
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

  const pending = queryRelayOnce(relays, {
    ids: [normalized],
    kinds: [1],
  })
    .then(({ events }) => {
      const match =
        events.find((event) => event.id.toLowerCase() === normalized) ?? null;
      if (!match && eventByIdCache.get(normalized) === pending) {
        eventByIdCache.delete(normalized);
      }
      return match;
    })
    .catch(() => {
      if (eventByIdCache.get(normalized) === pending) {
        eventByIdCache.delete(normalized);
      }
      return null;
    });

  eventByIdCache.set(normalized, pending);
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

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunkedArray: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunkedArray.push(array.slice(i, i + chunkSize));
  }
  return chunkedArray;
}

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
 * Client-side trending score weights. Wine's default ranking is reply-heavy, so
 * reactions/reposts outrank replies; zaps use log scale to limit whale skew.
 */
export const RANK_WEIGHT_REACTIONS = 1;
export const RANK_WEIGHT_REPLIES = 0.75;
export const RANK_WEIGHT_REPOSTS = 2.5;
/** Multiplier on log10(1 + zap sats). */
export const RANK_ZAP_LOG_SCALE = 4;
/** Hours added to age before gravity (HN-style floor). */
export const RANK_AGE_OFFSET_HOURS = 2;
export const RANK_GRAVITY = 1.35;

function engagementPoints(engagement: NoteEngagement): number {
  return (
    RANK_WEIGHT_REACTIONS * engagement.reactions +
    RANK_WEIGHT_REPLIES * engagement.replies +
    RANK_WEIGHT_REPOSTS * engagement.reposts +
    RANK_ZAP_LOG_SCALE * Math.log10(1 + engagement.zapAmount)
  );
}

/**
 * HN-style score: weighted wine engagement decayed by note age.
 * Missing / zero engagement scores 0 (sorted after scored notes).
 */
export function scoreTrendingNote(
  note: Pick<Event, "created_at">,
  engagement: NoteEngagement | undefined,
  nowSec = Math.floor(Date.now() / 1000)
): number {
  if (!engagement) return 0;
  const points = engagementPoints(engagement);
  if (points <= 0) return 0;
  const ageHours = Math.max(0, (nowSec - note.created_at) / 3600);
  return points / (ageHours + RANK_AGE_OFFSET_HOURS) ** RANK_GRAVITY;
}

/**
 * Re-rank relay/wine candidates with our composite score. Stable for ties.
 * If no engagement metadata is available, keeps source order.
 */
export function rankTrendingNotes(
  notes: LocatedEvent[],
  engagementById: Record<string, NoteEngagement>,
  nowSec = Math.floor(Date.now() / 1000)
): LocatedEvent[] {
  if (notes.length < 2 || Object.keys(engagementById).length === 0) {
    return notes;
  }

  return notes
    .map((note, index) => ({
      note,
      index,
      score: scoreTrendingNote(
        note,
        engagementById[note.id.toLowerCase()],
        nowSec
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.note);
}

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
  engagementById: Record<string, NoteEngagement>
): Promise<TrendingFeedResult> {
  const withContent = filterEmptyContentNotes(notes);
  const [engagement, spamIds] = await Promise.all([
    enrichEngagementFromRelays(withContent, engagementById),
    fetchSpamReportedEventIds(withContent.map((note) => note.id)),
  ]);

  let visible =
    spamIds.size === 0
      ? withContent
      : withContent.filter((note) => !spamIds.has(note.id.toLowerCase()));

  if (isHashtagFilterEnabled()) {
    visible = filterExcessHashtagNotes(visible);
  }

  // Rank before Fayan so reveal waves follow feed order.
  const ranked: TrendingFeed = {
    notes: rankTrendingNotes(visible, engagement),
    engagementById: engagement,
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
 * Fayan / hashtag filters depend on local settings — apply after the shared
 * server blob (which already ranked + spam-filtered).
 */
async function applyClientFeedFilters(
  feed: TrendingFeed
): Promise<TrendingFeedResult> {
  // Also drop empties on the API path so stale CDN blobs clear immediately.
  let visible = filterEmptyContentNotes(feed.notes);

  if (isHashtagFilterEnabled()) {
    visible = filterExcessHashtagNotes(visible);
  }

  const next: TrendingFeed = {
    notes: visible,
    engagementById: feed.engagementById,
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
    return applyClientFeedFilters(cached);
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
        wine?.engagementById ?? {}
      );
    }

    // Genuine empty reply from a healthy subscription.
    if (closeReason === EOSE_CLOSE_REASON) {
      const wine = await winePromise;
      return toTrendingFeed([], wine?.engagementById ?? {});
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
      wine.engagementById
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
    wine.engagementById
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

/**
 * Load kind 0 profiles from Vertex + Primal in parallel; keep newest
 * per pubkey. Serves localStorage/memory cache first and only queries relays
 * for missing or stale pubkeys.
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
