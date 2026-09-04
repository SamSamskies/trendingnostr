/**
 * LLM spam verdicts (event ids) stored in Vercel Runtime Cache.
 * Written by Mac Mini Ollama cron; read when building `/api/trending`.
 */

import { getCache } from "@vercel/functions";

const RUNTIME_CACHE_KEY = "llm-spam-verdicts";
/** Keep past the max trending window; ids are tiny. */
export const SPAM_VERDICT_TTL_SEC = 7 * 24 * 60 * 60;
const MAX_STORED_VERDICTS = 5000;

const runtimeCache = getCache({ namespace: "trending" });

/**
 * @typedef {{
 *   spam: true,
 *   confidence: number,
 *   category?: string,
 *   reason?: string,
 *   model?: string,
 *   at: number,
 * }} SpamVerdict
 */

/**
 * @typedef {{
 *   updatedAt: number,
 *   verdicts: Record<string, SpamVerdict>,
 * }} SpamVerdictStore
 */

function isEventId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is SpamVerdictStore}
 */
function isStoreShape(value) {
  if (!value || typeof value !== "object") return false;
  const store = /** @type {SpamVerdictStore} */ (value);
  return (
    typeof store.updatedAt === "number" &&
    store.verdicts != null &&
    typeof store.verdicts === "object"
  );
}

/**
 * @returns {Promise<SpamVerdictStore>}
 */
export async function readSpamVerdictStore() {
  try {
    const cached = await runtimeCache.get(RUNTIME_CACHE_KEY);
    if (isStoreShape(cached)) return cached;
  } catch {
    // Runtime Cache unavailable (local vercel dev) — empty store.
  }
  return { updatedAt: 0, verdicts: {} };
}

/**
 * @returns {Promise<Set<string>>}
 */
export async function fetchLlmSpamEventIds() {
  const store = await readSpamVerdictStore();
  const ids = new Set();
  for (const [id, verdict] of Object.entries(store.verdicts)) {
    if (!isEventId(id)) continue;
    if (verdict && verdict.spam === true) ids.add(id.toLowerCase());
  }
  return ids;
}

/**
 * Merge spam:true verdicts into Runtime Cache.
 * Throws if the write fails so callers do not treat a no-op as success.
 *
 * @param {Array<{
 *   id: string,
 *   confidence: number,
 *   category?: string,
 *   reason?: string,
 *   model?: string,
 * }>} items
 * @returns {Promise<{ added: number, total: number }>}
 */
export async function mergeSpamVerdicts(items) {
  const now = Math.floor(Date.now() / 1000);
  const store = await readSpamVerdictStore();
  let added = 0;

  for (const item of items) {
    if (!item || !isEventId(item.id)) continue;
    const id = item.id.toLowerCase();
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0) continue;
    if (!store.verdicts[id]) added += 1;
    store.verdicts[id] = {
      spam: true,
      confidence: Math.min(1, confidence),
      category:
        typeof item.category === "string" ? item.category.slice(0, 64) : undefined,
      reason:
        typeof item.reason === "string" ? item.reason.slice(0, 280) : undefined,
      model: typeof item.model === "string" ? item.model.slice(0, 64) : undefined,
      at: now,
    };
  }

  // Drop oldest if over cap (by `at`).
  const entries = Object.entries(store.verdicts);
  if (entries.length > MAX_STORED_VERDICTS) {
    entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    store.verdicts = Object.fromEntries(
      entries.slice(entries.length - MAX_STORED_VERDICTS)
    );
  }

  store.updatedAt = now;

  await runtimeCache.set(RUNTIME_CACHE_KEY, store, {
    ttl: SPAM_VERDICT_TTL_SEC,
    tags: ["trending", "spam-verdicts"],
    name: "llm-spam-verdicts",
  });

  return { added, total: Object.keys(store.verdicts).length };
}
