/**
 * POST LLM spam verdicts (Mac Mini cron) / GET known spam ids / clear.
 * No shared secret — same openness as public `/api/trending` reads.
 */

import { applyCors, originAllowed, requestOrigin } from "../lib/http.js";
import {
  clearSpamVerdicts,
  fetchLlmSpamEventIds,
  mergeSpamVerdicts,
  readSpamVerdictStore,
  removeSpamVerdicts,
} from "../lib/spamVerdicts.js";

export const config = {
  maxDuration: 30,
};

function setCors(res, req) {
  applyCors(res, req);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

    if (body?.clear === true) {
      try {
        const result = await clearSpamVerdicts();
        return res.status(200).json({ ok: true, cleared: true, removed: result.removed });
      } catch (err) {
        return res.status(503).json({
          error: "cache_write_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const removeIds = Array.isArray(body?.remove) ? body.remove : null;
    const verdicts = Array.isArray(body?.verdicts) ? body.verdicts : null;

    if (removeIds) {
      if (removeIds.length > 500) {
        return res.status(400).json({ error: "too_many_ids" });
      }
      try {
        const result = await removeSpamVerdicts(removeIds);
        return res.status(200).json({
          ok: true,
          removed: result.removed,
          total: result.total,
        });
      } catch (err) {
        return res.status(503).json({
          error: "cache_write_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!verdicts) {
      return res.status(400).json({
        error: "invalid_body",
        message:
          'Expected JSON { "verdicts": [...] }, { "remove": ["id", ...] }, or { "clear": true }',
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
