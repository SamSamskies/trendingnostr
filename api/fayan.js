/**
 * Proxy for Fayan reputation lookups.
 * Fayan's official CORS only allows GET (not POST /users), so the browser
 * cannot batch directly. This endpoint accepts a batch POST and fans out
 * upstream GETs — Cloudflare in front of Fayan often returns an HTML
 * challenge for datacenter POSTs, which breaks JSON parsing on Vercel.
 *
 * JavaScript (not TypeScript): `vercel dev` crashes compiling `.ts` API routes.
 */

import { applyCors, originAllowed } from "../lib/http.js";

const FAYAN_BASE_URL = (
  process.env.FAYAN_BASE_URL?.trim() || "https://fayan.jumble.social"
).replace(/\/$/, "");
const MAX_PUBKEYS = 100;
const MAX_BODY_BYTES = 20_000;
const FETCH_TIMEOUT_MS = 8_000;
const UPSTREAM_CONCURRENCY = 10;
const USER_AGENT = "trendingnostr-fayan/1.0";

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;
const NPUB = /^npub1[02-9ac-hj-np-z]{58,}$/i;

function readBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body == null) return "";
  return JSON.stringify(req.body);
}

function normalizePubkey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (HEX_PUBKEY.test(trimmed)) return trimmed.toLowerCase();
  if (NPUB.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

function normalizePubkeys(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_PUBKEYS) return null;

  const seen = new Set();
  const pubkeys = [];
  for (const item of raw) {
    const pubkey = normalizePubkey(item);
    if (!pubkey) return null;
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    pubkeys.push(pubkey);
  }
  return pubkeys;
}

/**
 * Fan out GET /users/{pubkey} with limited concurrency.
 * 404 → omit (unknown author). Non-JSON / other errors → throw.
 */
async function fetchUsersByGet(pubkeys, signal) {
  const result = {};
  let next = 0;

  async function worker() {
    while (next < pubkeys.length) {
      const index = next;
      next += 1;
      const pubkey = pubkeys[index];
      const upstream = await fetch(
        `${FAYAN_BASE_URL}/users/${encodeURIComponent(pubkey)}`,
        {
          method: "GET",
          signal,
          headers: {
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
        }
      );

      if (upstream.status === 404) continue;

      const text = await upstream.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        const err = new Error("upstream_invalid_json");
        err.code = "upstream_invalid_json";
        err.status = upstream.status;
        throw err;
      }

      if (!upstream.ok) {
        const err = new Error("upstream_error");
        err.code = "upstream_error";
        err.status = upstream.status;
        err.data = data && typeof data === "object" ? data : undefined;
        throw err;
      }

      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      if (typeof data.pubkey !== "string") continue;

      result[pubkey] = data;
      const hex = data.pubkey.trim().toLowerCase();
      if (hex && hex !== pubkey) result[hex] = data;
    }
  }

  const workers = Math.min(UPSTREAM_CONCURRENCY, pubkeys.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return result;
}

export default async function handler(req, res) {
  applyCors(res, req);

  if (req.method === "OPTIONS") {
    if (req.headers.origin && !originAllowed(req)) {
      res.status(403).end();
      return;
    }
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  // Same-origin POSTs from the Vite app send Origin; enforce when present.
  if (req.headers.origin && !originAllowed(req)) {
    res.status(403).json({ error: "forbidden_origin" });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || "0");
  if (contentLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }

  let body;
  try {
    const text = readBody(req);
    if (text.length > MAX_BODY_BYTES) {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    body =
      typeof req.body === "object" && req.body != null
        ? req.body
        : JSON.parse(text);
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  const pubkeys = normalizePubkeys(body?.pubkeys);
  if (!pubkeys) {
    res.status(400).json({
      error: "invalid_request",
      message: `Expected { pubkeys: string[] } with 0–${MAX_PUBKEYS} hex or npub keys`,
    });
    return;
  }

  if (pubkeys.length === 0) {
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(200).json({});
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const data = await fetchUsersByGet(pubkeys, controller.signal);
    // Rankings change slowly; short CDN cache is fine for batch lookups.
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(200).json(data);
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || /aborted/i.test(err.message));
    const code =
      err && typeof err === "object" && typeof err.code === "string"
        ? err.code
        : null;
    res.setHeader("Cache-Control", "no-store");
    if (aborted) {
      res.status(502).json({ error: "upstream_timeout" });
      return;
    }
    if (code === "upstream_invalid_json") {
      res.status(502).json({ error: "upstream_invalid_json" });
      return;
    }
    if (code === "upstream_error") {
      res.status(502).json({
        error: "upstream_error",
        status: err.status,
        ...(err.data && typeof err.data === "object" ? err.data : {}),
      });
      return;
    }
    res.status(502).json({ error: "upstream_unreachable" });
  } finally {
    clearTimeout(timer);
  }
}
