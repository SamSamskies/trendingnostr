/**
 * Server-side zap amount corrections from zap.observer.
 *
 * zap.observer's top endpoint is intentionally used as a sparse correction
 * source: nostr.wine / the trending relay still own candidate discovery.
 */

export const ZAP_OBSERVER_TOP_API =
  "https://zap.observer/api/top/notes";
export const ZAP_OBSERVER_TOP_LIMIT = 50;
export const ZAP_OBSERVER_TIMEOUT_MS = 4_000;

const ZAP_OBSERVER_RANKINGS = ["sats", "count"];

function isEventId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function asNonNegInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Use a range at least as old as every candidate note. A valid zap cannot
 * predate the note it targets, so the wider API range still represents all
 * possible zaps for a candidate in the selected feed window.
 */
export function zapObserverRangeForHours(hours) {
  return Number(hours) <= 24 ? "24h" : "7d";
}

export function parseZapObserverTop(payload) {
  const byId = {};
  if (!Array.isArray(payload?.entries)) return byId;

  for (const entry of payload.entries) {
    if (!isEventId(entry?.key)) continue;
    const sats = asNonNegInt(entry?.sats);
    if (sats == null) continue;
    const id = entry.key.toLowerCase();
    byId[id] = Math.max(byId[id] ?? 0, sats);
  }
  return byId;
}

async function fetchTopBoard(range, by, fetchImpl) {
  const url = new URL(ZAP_OBSERVER_TOP_API);
  url.searchParams.set("range", range);
  url.searchParams.set("by", by);
  url.searchParams.set("limit", String(ZAP_OBSERVER_TOP_LIMIT));
  url.searchParams.set("show", "notes");

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "trendingnostr-zap-corrections/1.0",
    },
    signal: AbortSignal.timeout(ZAP_OBSERVER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`zap.observer top API HTTP ${response.status}`);
  }
  return parseZapObserverTop(await response.json());
}

/**
 * Fetch the union of the by-sats and by-count boards. Each board can expose
 * different notes, while both carry the same aggregate sats field.
 * Soft-fails per board so one healthy response can still improve the feed.
 */
export async function fetchZapObserverCorrections(hours, fetchImpl = fetch) {
  const range = zapObserverRangeForHours(hours);
  const settled = await Promise.allSettled(
    ZAP_OBSERVER_RANKINGS.map((by) => fetchTopBoard(range, by, fetchImpl))
  );

  const merged = {};
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const [id, sats] of Object.entries(result.value)) {
      merged[id] = Math.max(merged[id] ?? 0, sats);
    }
  }
  return merged;
}

/**
 * Raise zap totals only for notes already selected as feed candidates.
 * Existing higher totals win, and corrections never introduce a new note.
 */
export function applyZapObserverCorrections(
  notes,
  engagementById,
  zapAmountById
) {
  const candidateIds = new Set(notes.map((note) => note.id.toLowerCase()));
  let corrected = engagementById;

  for (const [rawId, rawZapAmount] of Object.entries(zapAmountById)) {
    const id = rawId.toLowerCase();
    if (!candidateIds.has(id)) continue;
    const zapAmount = asNonNegInt(rawZapAmount);
    if (zapAmount == null) continue;

    const current = engagementById[id];
    if (current && current.zapAmount >= zapAmount) continue;
    if (!current && zapAmount === 0) continue;

    if (corrected === engagementById) corrected = { ...engagementById };
    corrected[id] = {
      reactions: current?.reactions ?? 0,
      replies: current?.replies ?? 0,
      reposts: current?.reposts ?? 0,
      zapAmount,
    };
  }

  return corrected;
}
