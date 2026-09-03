/**
 * Cached trending feed blob for fast first paint.
 * JavaScript (not TypeScript): `vercel dev` crashes compiling `.ts` API routes.
 *
 * Layers:
 * 1. Browser `max-age=60` (disk cache on soft reload)
 * 2. Vercel CDN `s-maxage=300` — fragmented by Accept-Encoding, so cron curl
 *    and Chrome (br/zstd) are different keys
 * 3. Runtime Cache — shared per region across encodings; cron refreshes it so
 *    a CDN miss still returns the prebuilt feed in milliseconds
 *
 * Cron cannot rely on Pragma/Cache-Control: no-cache to reach the function
 * while s-maxage is fresh. It hits `?_warm=1` + x-trending-refresh (distinct
 * CDN key, no-store response) then warms the public URL.
 */

import { getCache } from "@vercel/functions";
import { applyCors, originAllowed, requestOrigin } from "../lib/http.js";
import {
  buildTrendingFeed,
  isTrendingHours,
  RELAY_ALIGNED_TRENDING_HOURS,
} from "../lib/trendingFeed.js";

export const config = {
  maxDuration: 60,
};

// max-age → browser disk cache; s-maxage → Vercel CDN (encoding-specific).
const CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=86400";

/** Keep feed around between cron ticks even if CDN evicts an encoding variant. */
const RUNTIME_TTL_SEC = 900;
const RUNTIME_CACHE_KEY = (hours) => `feed:${hours}`;
const REFRESH_HEADER = "x-trending-refresh";

const runtimeCache = getCache({ namespace: "trending" });

function parseHours(req) {
  const raw = req.query?.hours;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") return RELAY_ALIGNED_TRENDING_HOURS;
  const hours = Number(value);
  return isTrendingHours(hours) ? hours : null;
}

/**
 * @returns {"none" | "refresh" | "unauthorized"}
 */
function refreshIntent(req) {
  const raw = req.headers[REFRESH_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value) return "none";
  const secret = process.env.TRENDING_WARM_SECRET;
  // Secret set + wrong value → fail closed (401). Cron defaults to "1"; a
  // mismatched Vercel env must not look like a successful warm.
  if (secret && value !== secret) return "unauthorized";
  // No secret: any non-empty header forces rebuild (same DoS surface as a
  // cold CDN miss).
  return "refresh";
}

function setTrendingCors(res, req) {
  applyCors(res, req);
  // Public JSON body is identical for every caller. Use * so we do not
  // fragment the CDN on Origin (cron has none; browsers often send one).
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Accept-Encoding: Vercel already keys by it. x-trending-refresh: keep
  // cron rebuilds off the browser CDN entry (Pragma/no-cache will not).
  res.setHeader("Vary", `Accept-Encoding, ${REFRESH_HEADER}`);
}

function setTrendingCache(res) {
  res.setHeader("Cache-Control", CACHE_CONTROL);
  res.setHeader("CDN-Cache-Control", CACHE_CONTROL);
  res.setHeader("Vercel-CDN-Cache-Control", CACHE_CONTROL);
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
}

function isFeedShape(value) {
  if (!value || typeof value !== "object") return false;
  return Array.isArray(value.notes) && value.engagementById != null;
}

/**
 * @param {number} hours
 * @param {boolean} refresh
 * @returns {Promise<{ feed: object, layer: "runtime" | "build" }>}
 */
async function getOrBuildFeed(hours, refresh) {
  const key = RUNTIME_CACHE_KEY(hours);

  if (!refresh) {
    try {
      const cached = await runtimeCache.get(key);
      if (isFeedShape(cached)) {
        return { feed: cached, layer: "runtime" };
      }
    } catch {
      // Runtime Cache unavailable (local vercel dev) — fall through to build.
    }
  }

  const feed = await buildTrendingFeed(hours);
  try {
    await runtimeCache.set(key, feed, {
      ttl: RUNTIME_TTL_SEC,
      tags: ["trending", `trending:${hours}`],
      name: `trending-${hours}h`,
    });
  } catch {
    // Non-fatal: CDN headers still help the next identical encoding.
  }
  return { feed, layer: "build" };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setTrendingCors(res, req);
    setNoStore(res);
    if (requestOrigin(req) && !originAllowed(req)) {
      return res.status(403).end();
    }
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    setTrendingCors(res, req);
    setNoStore(res);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Browser CORS: block disallowed origins. Same-origin / no Origin (curl, cron) OK.
  const origin = requestOrigin(req);
  if (origin && !originAllowed(req)) {
    setTrendingCors(res, req);
    setNoStore(res);
    return res.status(403).json({ error: "origin_not_allowed" });
  }

  const hours = parseHours(req);
  if (hours == null) {
    setTrendingCors(res, req);
    setNoStore(res);
    return res.status(400).json({
      error: "invalid_hours",
      message: "hours must be one of 4, 12, 24, 48",
    });
  }

  const intent = refreshIntent(req);
  if (intent === "unauthorized") {
    setTrendingCors(res, req);
    setNoStore(res);
    return res.status(401).json({
      error: "invalid_warm_secret",
      message:
        "x-trending-refresh does not match TRENDING_WARM_SECRET; set the same value on the Mac Mini warmer",
    });
  }

  try {
    const refresh = intent === "refresh";
    const { feed, layer } = await getOrBuildFeed(hours, refresh);
    setTrendingCors(res, req);
    // Refresh responses must not land in CDN under the browser key.
    if (refresh) setNoStore(res);
    else setTrendingCache(res);
    res.setHeader("X-Trending-Source", feed.source);
    res.setHeader("X-Trending-Duration-Ms", String(feed.durationMs));
    res.setHeader("X-Trending-Note-Count", String(feed.notes.length));
    res.setHeader("X-Trending-Cache", layer);
    return res.status(200).json(feed);
  } catch (err) {
    setTrendingCors(res, req);
    setNoStore(res);
    const message =
      err instanceof Error ? err.message : "Failed to build trending feed.";
    return res.status(502).json({ error: "trending_build_failed", message });
  }
}
