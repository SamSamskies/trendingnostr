/**
 * Shared trending constants + ranking for client (`src/nostr.ts`) and server
 * (`lib/trendingFeed.js`). Keep a single source of truth for relay lists and
 * score weights so the two paths cannot drift.
 */

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
  "wss://relay.primal.net",
  "wss://relay.ditto.pub",
];

/** Same relays as event hydration — used to count engagement when wine lacks a note. */
export const ENGAGEMENT_RELAYS = EVENT_HYDRATION_RELAYS;
/** Caps relay backfill latency (chunked `#e` queries). */
export const ENGAGEMENT_BACKFILL_MAX = 40;
export const ENGAGEMENT_ID_CHUNK_SIZE = 40;
/** Per-relay cap so kind-1 reply floods cannot stall EOSE. */
export const ENGAGEMENT_QUERY_LIMIT = 400;

export const RELAY_MAX_WAIT_MS = 4500;
/** How many times to retry a failed trending-relay connection. */
export const TRENDING_FETCH_ATTEMPTS = 3;

/**
 * Trending score weights. Wine's default ranking is reply-heavy, so
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

export function chunkArray(array, chunkSize) {
  const chunkedArray = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunkedArray.push(array.slice(i, i + chunkSize));
  }
  return chunkedArray;
}

function engagementPoints(engagement) {
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
  note,
  engagement,
  nowSec = Math.floor(Date.now() / 1000)
) {
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
  notes,
  engagementById,
  nowSec = Math.floor(Date.now() / 1000)
) {
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
