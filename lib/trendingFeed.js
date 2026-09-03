/**
 * Server-side trending feed builder (wine + relays + spam + rank).
 * Shared by `/api/trending`. Keep in sync with `src/nostr.ts` ranking weights.
 */

import { SimplePool } from "nostr-tools";

export const TRENDING_RELAY = "wss://trending.relays.land";
export const WINE_TRENDING_API = "https://api.nostr.wine/trending";
export const WINE_TRENDING_LIMIT = 200;
export const RELAY_ALIGNED_TRENDING_HOURS = 48;
export const WINE_MIN_REQUEST_INTERVAL_MS = 1000;
export const TRENDING_HOURS_OPTIONS = [4, 12, 24, 48];

export const EVENT_HYDRATION_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.ditto.pub",
];

export const ENGAGEMENT_RELAYS = EVENT_HYDRATION_RELAYS;
export const ENGAGEMENT_BACKFILL_MAX = 40;
export const ENGAGEMENT_ID_CHUNK_SIZE = 40;
export const ENGAGEMENT_QUERY_LIMIT = 400;

const HIDDEN_AUTHOR_PUBKEYS = new Set([
  "567b21e2a428a8f7b67aa03ec21cfa610fae2afc2df5a7513de0d4e69be2077d",
  "d71f47ad20f6a4b9363d8a319a539332e77980f8d52dee9a0073da36c4062369",
  "ae1bbe3a1fe798758b8c708d0b26538f3b9d8475a42e0b07720d1985223fd9fa",
  // Constitute / zone_presence gateway telemetry spam
  "0f92c4a4aab613ff051f2a6e9cde7d0d131faa576a11ffe175ab82b4715c501b",
  // Followers of the constitute gateway key (spam / follow-farm cluster)
  "1ff656b3cd2f4d231d3f6e46c37c0655acffa2da81483b2c9502fbe232f3ef89",
  "232750cfdeae60936ec35e23552f5b5bc45048a42e7743e09ea70f11622bbbf4",
  "4e612ac1231ed3b23aadbccc100f9ba6ee62d120c903d1515a06330662671800",
  "5e385f89d8938640cf6c2cef4e7ba19da898e0850dce6002495ca7545e0b712a",
  "5f0748bffc7552be7b04eb8b0ca1ed6c88633a67f7b5f94199bdd63723fcc1cb",
  "61b983318a97f65947bf7b0b52bd5508776152d5d4af270b20b0b534727c5e77",
  "6c5c8690169bf5879a39ab5651060567f95b6d499b0ed432427049527a925adb",
  "78b512a29311693e5357c4cf2e8a3552ed58af3d8582da439df45ed524df9bfe",
  "7c17b40889d132083dee1f1f08ff7c569526d0da46bfa6f77eb51dd1a52f048a",
  "7f0e64b52ef56bec2b588d460fc63125f567db2c014d1ecce806d8d5b4209e2e",
  "9557955355f5f11d64dc1c2d7d136d5811904fdc592a950cb4091d05417ffba1",
  "b03080d020cdd19a9e5376e7baba0776c2299a4459599c2aa2759ad36d60a59c",
  "b05ddaa79926f85b23723a8938cfe432d84ec0d7a9b3137d979af6d0877da8a7",
  "bb891e7472b001b03aaefc2d6ad1a70a6f053950a92b076e6981830fcca78020",
  "d371a9c9023d5878713244fcc813aa52028ed2b96b365edff59bfa63b5c3753f",
  "f01e4c30f12f10b204618a120346e0b77219b3ec7ab382de0ff5f1bc92e9c717",
]);

const SPAM_REPORTER_PUBKEY =
  "604e96e099936a104883958b040b47672e0f048c98ac793f37ffe4c720279eb2";
const SPAM_REPORT_QUERY_LIMIT = 200;

export const RELAY_MAX_WAIT_MS = 4500;
export const TRENDING_FETCH_ATTEMPTS = 3;
const EOSE_CLOSE_REASON = "closed automatically on eose";

export const RANK_WEIGHT_REACTIONS = 1;
export const RANK_WEIGHT_REPLIES = 0.75;
export const RANK_WEIGHT_REPOSTS = 2.5;
export const RANK_ZAP_LOG_SCALE = 4;
export const RANK_AGE_OFFSET_HOURS = 2;
export const RANK_GRAVITY = 1.35;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEventId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function asNonNegInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function isTrendingHours(value) {
  return TRENDING_HOURS_OPTIONS.includes(Number(value));
}

export function chunkArray(array, chunkSize) {
  const chunkedArray = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunkedArray.push(array.slice(i, i + chunkSize));
  }
  return chunkedArray;
}

function isRateLimitedCloseReason(reason) {
  return /rate[-_ ]?limited/i.test(reason);
}

function toLocatedEvents(events, seenOn) {
  const ordered = [];
  const seen = new Set();
  for (const event of events) {
    if (HIDDEN_AUTHOR_PUBKEYS.has(event.pubkey.toLowerCase())) continue;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    ordered.push({ ...event, seenOn: [...seenOn] });
  }
  return ordered;
}

function emptyEngagement() {
  return { reactions: 0, replies: 0, reposts: 0, zapAmount: 0 };
}

function queryRelayOnce(relays, filter) {
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;

  return new Promise((resolve) => {
    const events = [];
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

let wineGate = Promise.resolve();
let wineLastStartedAt = 0;

async function withWineRateLimit(fn) {
  const previous = wineGate;
  let release;
  wineGate = new Promise((resolve) => {
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

async function fetchWineTrending(hours) {
  return withWineRateLimit(async () => {
    const url = new URL(WINE_TRENDING_API);
    url.searchParams.set("limit", String(WINE_TRENDING_LIMIT));
    url.searchParams.set("hours", String(hours));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`nostr.wine trending API HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("nostr.wine trending API returned a non-array body.");
    }

    const ids = [];
    const engagementById = {};
    const seen = new Set();
    for (const item of data) {
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

async function hydrateTrendingNotesFromWine(wine) {
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
  const ordered = [];
  for (const id of ids) {
    const event = byId.get(id);
    if (event) ordered.push(event);
  }
  return toLocatedEvents(ordered, EVENT_HYDRATION_RELAYS);
}

function satsFromBolt11(bolt11) {
  if (bolt11.length < 50 || !bolt11.startsWith("lnbc")) return 0;
  const prefix = bolt11.slice(0, 50);
  const sep = prefix.lastIndexOf("1");
  if (sep < 4) return 0;
  const amount = prefix.slice(4, sep);
  if (!amount) return 0;

  const multipliers = { m: 1e5, u: 1e2, n: 0.1, p: 0.0001 };
  const last = amount[amount.length - 1];
  if (last in multipliers) {
    const n = Number(amount.slice(0, -1));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n * multipliers[last]);
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n * 1e8);
}

function zapSatsFromReceipt(event) {
  const bolt11 = event.tags.find((tag) => tag[0] === "bolt11")?.[1];
  if (!bolt11) return 0;
  try {
    return Math.max(0, satsFromBolt11(bolt11));
  } catch {
    return 0;
  }
}

function taggedWantedIds(event, wanted) {
  const hits = [];
  const seen = new Set();
  for (const tag of event.tags) {
    if (tag[0] !== "e" || !isEventId(tag[1])) continue;
    const id = tag[1].toLowerCase();
    if (!wanted.has(id) || seen.has(id)) continue;
    seen.add(id);
    hits.push(id);
  }
  return hits;
}

async function fetchRelayEngagement(noteIds) {
  const wanted = [
    ...new Set(
      noteIds.map((id) => id.toLowerCase()).filter((id) => isEventId(id))
    ),
  ];
  if (wanted.length === 0) return {};

  const wantedSet = new Set(wanted);
  const byId = {};
  for (const id of wanted) byId[id] = emptyEngagement();

  const seenEventIds = new Set();
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

async function enrichEngagementFromRelays(notes, engagementById) {
  const missing = [];
  for (const note of notes) {
    const id = note.id.toLowerCase();
    if (!engagementById[id]) missing.push(id);
  }
  if (missing.length === 0) return engagementById;

  try {
    const relayEngagement = await fetchRelayEngagement(
      missing.slice(0, ENGAGEMENT_BACKFILL_MAX)
    );
    const merged = { ...engagementById };
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

function spamReportedEventIdFromETag(tag) {
  if (tag[0] !== "e" || !isEventId(tag[1])) return null;
  if (!tag.slice(2).includes("spam")) return null;
  return tag[1].toLowerCase();
}

async function fetchSpamReportedEventIds(noteIds) {
  const wanted = [
    ...new Set(
      noteIds.map((id) => id.toLowerCase()).filter((id) => isEventId(id))
    ),
  ];
  if (wanted.length === 0) return new Set();

  const wantedSet = new Set(wanted);
  const spamIds = new Set();
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

function engagementPoints(engagement) {
  return (
    RANK_WEIGHT_REACTIONS * engagement.reactions +
    RANK_WEIGHT_REPLIES * engagement.replies +
    RANK_WEIGHT_REPOSTS * engagement.reposts +
    RANK_ZAP_LOG_SCALE * Math.log10(1 + engagement.zapAmount)
  );
}

function scoreTrendingNote(note, engagement, nowSec = Math.floor(Date.now() / 1000)) {
  if (!engagement) return 0;
  const points = engagementPoints(engagement);
  if (points <= 0) return 0;
  const ageHours = Math.max(0, (nowSec - note.created_at) / 3600);
  return points / (ageHours + RANK_AGE_OFFSET_HOURS) ** RANK_GRAVITY;
}

function rankTrendingNotes(notes, engagementById, nowSec = Math.floor(Date.now() / 1000)) {
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

/** Blank / whitespace-only kind 1 bodies — common spam; media notes put URLs in content. */
function hasNoteContent(note) {
  return typeof note.content === "string" && note.content.trim().length > 0;
}

async function toServerTrendingFeed(notes, engagementById) {
  const withContent = notes.filter(hasNoteContent);
  const [engagement, spamIds] = await Promise.all([
    enrichEngagementFromRelays(withContent, engagementById),
    fetchSpamReportedEventIds(withContent.map((note) => note.id)),
  ]);

  const visible =
    spamIds.size === 0
      ? withContent
      : withContent.filter((note) => !spamIds.has(note.id.toLowerCase()));

  return {
    notes: rankTrendingNotes(visible, engagement),
    engagementById: engagement,
    spamFiltered: withContent.length - visible.length,
  };
}

/**
 * Build a cacheable trending feed for one window.
 * Does not apply Fayan / hashtag filters (client settings).
 */
export async function buildTrendingFeed(hours = RELAY_ALIGNED_TRENDING_HOURS) {
  const startedAt = Date.now();
  const normalizedHours = Number(hours);

  if (normalizedHours !== RELAY_ALIGNED_TRENDING_HOURS) {
    let wine;
    try {
      wine = await fetchWineTrending(normalizedHours);
    } catch {
      wine = await fetchWineTrending(normalizedHours);
    }
    const feed = await toServerTrendingFeed(
      await hydrateTrendingNotesFromWine(wine),
      wine.engagementById
    );
    return {
      hours: normalizedHours,
      updatedAt: Math.floor(Date.now() / 1000),
      durationMs: Date.now() - startedAt,
      source: "wine",
      notes: feed.notes,
      engagementById: feed.engagementById,
      spamFiltered: feed.spamFiltered,
    };
  }

  const winePromise = fetchWineTrending(normalizedHours).then(
    (payload) => payload,
    () => null
  );

  let lastCloseReason = "unknown";
  let rateLimited = false;

  for (let attempt = 0; attempt < TRENDING_FETCH_ATTEMPTS; attempt++) {
    const { events, closeReason } = await queryRelayOnce([TRENDING_RELAY], {
      kinds: [1],
    });
    lastCloseReason = closeReason;

    if (events.length > 0) {
      const wine = await winePromise;
      const feed = await toServerTrendingFeed(
        toLocatedEvents(events, [TRENDING_RELAY]),
        wine?.engagementById ?? {}
      );
      return {
        hours: normalizedHours,
        updatedAt: Math.floor(Date.now() / 1000),
        durationMs: Date.now() - startedAt,
        source: "trending_relay",
        notes: feed.notes,
        engagementById: feed.engagementById,
        spamFiltered: feed.spamFiltered,
      };
    }

    if (closeReason === EOSE_CLOSE_REASON) {
      const wine = await winePromise;
      const feed = await toServerTrendingFeed([], wine?.engagementById ?? {});
      return {
        hours: normalizedHours,
        updatedAt: Math.floor(Date.now() / 1000),
        durationMs: Date.now() - startedAt,
        source: "trending_relay",
        notes: feed.notes,
        engagementById: feed.engagementById,
        spamFiltered: feed.spamFiltered,
      };
    }

    if (isRateLimitedCloseReason(closeReason)) {
      rateLimited = true;
      break;
    }

    if (attempt < TRENDING_FETCH_ATTEMPTS - 1) {
      await sleep(250 * (attempt + 1));
    }
  }

  let wine = await winePromise;
  if (!wine) {
    wine = await fetchWineTrending(normalizedHours);
  }

  const feed = await toServerTrendingFeed(
    await hydrateTrendingNotesFromWine(wine),
    wine.engagementById
  );

  return {
    hours: normalizedHours,
    updatedAt: Math.floor(Date.now() / 1000),
    durationMs: Date.now() - startedAt,
    source: rateLimited ? "wine_fallback_rate_limited" : "wine_fallback",
    relayCloseReason: lastCloseReason,
    notes: feed.notes,
    engagementById: feed.engagementById,
    spamFiltered: feed.spamFiltered,
  };
}
