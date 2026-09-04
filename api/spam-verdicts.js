/**
 * POST LLM spam verdicts (Mac Mini cron) / GET known spam ids.
 * Auth: same `x-trending-refresh` secret as `/api/trending` warm.
 */

import { applyCors, originAllowed, requestOrigin } from "../lib/http.js";
import {
  fetchLlmSpamEventIds,
  mergeSpamVerdicts,
  readSpamVerdictStore,
} from "../lib/spamVerdicts.js";

export const config = {
  maxDuration: 30,
};

const REFRESH_HEADER = "x-trending-refresh";

/**
 * @returns {"ok" | "unauthorized" | "missing"}
 */
function authIntent(req) {
  const raw = req.headers[REFRESH_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value) return "missing";
  const secret = process.env.TRENDING_WARM_SECRET;
  if (secret && value !== secret) return "unauthorized";
  return "ok";
}

function setCors(res, req) {
  applyCors(res, req);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, ${REFRESH_HEADER}`
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function readJsonBody(req) {
  if (req.body == null) return null;
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res, req);
    if (requestOrigin(req) && !originAllowed(req)) {
      return res.status(403).end();
    }
    return res.status(204).end();
  }

  setCors(res, req);

  const origin = requestOrigin(req);
  if (origin && !originAllowed(req)) {
    return res.status(403).json({ error: "origin_not_allowed" });
  }

  const auth = authIntent(req);
  if (auth === "missing") {
    return res.status(401).json({
      error: "missing_warm_secret",
      message: `Send ${REFRESH_HEADER} (same value as trending warm)`,
    });
  }
  if (auth === "unauthorized") {
    return res.status(401).json({
      error: "invalid_warm_secret",
      message: `${REFRESH_HEADER} does not match TRENDING_WARM_SECRET`,
    });
  }

  if (req.method === "GET") {
    const store = await readSpamVerdictStore();
    const ids = [...(await fetchLlmSpamEventIds())];
    return res.status(200).json({
      updatedAt: store.updatedAt,
      count: ids.length,
      ids,
    });
  }

  if (req.method === "POST") {
    const body = readJsonBody(req);
    const verdicts = Array.isArray(body?.verdicts) ? body.verdicts : null;
    if (!verdicts) {
      return res.status(400).json({
        error: "invalid_body",
        message: 'Expected JSON { "verdicts": [ { "id", "confidence", ... } ] }',
      });
    }
    if (verdicts.length > 500) {
      return res.status(400).json({ error: "too_many_verdicts" });
    }

    try {
      const result = await mergeSpamVerdicts(verdicts);
      return res.status(200).json({
        ok: true,
        added: result.added,
        total: result.total,
      });
    } catch (err) {
      return res.status(503).json({
        error: "cache_write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return res.status(405).json({ error: "method_not_allowed" });
}
