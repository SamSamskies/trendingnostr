/**
 * Proxy for Fayan batch reputation lookups.
 * Fayan's official CORS only allows GET, so the browser cannot POST /users
 * directly. This endpoint forwards batch queries server-side.
 *
 * JavaScript (not TypeScript): `vercel dev` crashes compiling `.ts` API routes.
 */

import { applyCors, originAllowed } from "../lib/http.js";

const FAYAN_BASE_URL = (
  process.env.FAYAN_BASE_URL?.trim() || "https://fayan.jumble.social"
).replace(/\/$/, "");
const FAYAN_USERS_URL = `${FAYAN_BASE_URL}/users`;
const MAX_PUBKEYS = 100;
const MAX_BODY_BYTES = 20_000;
const FETCH_TIMEOUT_MS = 8_000;
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
    const upstream = await fetch(FAYAN_USERS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ pubkeys }),
    });

    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      res.status(502).json({ error: "upstream_invalid_json" });
      return;
    }

    if (!upstream.ok) {
      res.status(502).json({
        error: "upstream_error",
        status: upstream.status,
        ...(data && typeof data === "object" ? data : {}),
      });
      return;
    }

    // Rankings change slowly; short CDN cache is fine for batch lookups.
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(200).json(data && typeof data === "object" ? data : {});
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || /aborted/i.test(err.message));
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({
      error: aborted ? "upstream_timeout" : "upstream_unreachable",
    });
  } finally {
    clearTimeout(timer);
  }
}
