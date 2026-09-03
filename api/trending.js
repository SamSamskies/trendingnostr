/**
 * Cached trending feed blob for fast first paint.
 * JavaScript (not TypeScript): `vercel dev` crashes compiling `.ts` API routes.
 *
 * CDN: `s-maxage=300` so a Mac Mini / Actions warmer every 5 minutes refreshes
 * the edge cache. `max-age=60` lets the browser reuse the blob on soft reloads.
 * Client filters (Fayan, hashtags) stay browser-side.
 */

import { applyCors, originAllowed, requestOrigin } from "../lib/http.js";
import {
  buildTrendingFeed,
  isTrendingHours,
  RELAY_ALIGNED_TRENDING_HOURS,
} from "../lib/trendingFeed.js";

export const config = {
  maxDuration: 60,
};

// max-age → browser disk cache; s-maxage → Vercel CDN (what cron warms).
const CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=86400";

function parseHours(req) {
  const raw = req.query?.hours;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") return RELAY_ALIGNED_TRENDING_HOURS;
  const hours = Number(value);
  return isTrendingHours(hours) ? hours : null;
}

function setTrendingCors(res, req) {
  applyCors(res, req);
  // Public JSON body is identical for every caller. Use * so we do not
  // fragment the CDN on Origin (cron has none; browsers often send one).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Accept-Encoding");
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

  try {
    const feed = await buildTrendingFeed(hours);
    setTrendingCors(res, req);
    setTrendingCache(res);
    res.setHeader("X-Trending-Source", feed.source);
    res.setHeader("X-Trending-Duration-Ms", String(feed.durationMs));
    res.setHeader("X-Trending-Note-Count", String(feed.notes.length));
    return res.status(200).json(feed);
  } catch (err) {
    setTrendingCors(res, req);
    setNoStore(res);
    const message =
      err instanceof Error ? err.message : "Failed to build trending feed.";
    return res.status(502).json({ error: "trending_build_failed", message });
  }
}
