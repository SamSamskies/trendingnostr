#!/usr/bin/env node
/**
 * Classify trending notes with local Ollama and POST spam verdicts.
 *
 * Intended for the Mac Mini warmer (after `/api/trending` warm). Fail-open:
 * Ollama/network errors exit 0 with a JSON summary so cron still succeeds.
 *
 * Usage:
 *   TRENDING_CRON_BASE_URL=https://… node scripts/classify-trending-spam.mjs
 *
 * Env:
 *   TRENDING_CRON_BASE_URL   required
 *   TRENDING_WARM_SECRET     same as warm header (default "1")
 *   OLLAMA_HOST              default http://127.0.0.1:11434
 *   SPAM_OLLAMA_MODEL        default gemma4:e4b
 *   SPAM_CONFIDENCE          default 0.9
 *   SPAM_CLASSIFY_HOURS      comma-separated windows (default 4,12,24,48)
 *   SPAM_CLASSIFY_MAX        max new notes per run (default 80)
 *   TRENDING_CRON_LOG_DIR    local classified-id cache dir
 *   TRENDING_CRON_BYPASS_SECRET  optional Vercel protection bypass
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ALL_TRENDING_HOURS = [4, 12, 24, 48];

/**
 * @returns {number[]}
 */
function resolveClassifyHours() {
  const raw = process.env.SPAM_CLASSIFY_HOURS;
  if (raw == null || String(raw).trim() === "") return ALL_TRENDING_HOURS;
  const parts = String(raw)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => ALL_TRENDING_HOURS.includes(n));
  return parts.length > 0 ? [...new Set(parts)] : ALL_TRENDING_HOURS;
}

const BASE_URL = (process.env.TRENDING_CRON_BASE_URL || "").replace(/\/$/, "");
const WARM_SECRET = process.env.TRENDING_WARM_SECRET || "1";
const BYPASS_SECRET =
  process.env.TRENDING_CRON_BYPASS_SECRET ||
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
  "";
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(
  /\/$/,
  ""
);
const MODEL = process.env.SPAM_OLLAMA_MODEL || "gemma4:e4b";
const CONFIDENCE = Number(process.env.SPAM_CONFIDENCE || "0.9") || 0.9;
const CLASSIFY_HOURS = resolveClassifyHours();
const MAX_NEW = Math.max(1, Number(process.env.SPAM_CLASSIFY_MAX || "80") || 80);
const LOG_DIR =
  process.env.TRENDING_CRON_LOG_DIR ||
  join(homedir(), "Library/Logs/trendingnostr");
const CACHE_PATH = join(LOG_DIR, "spam-classified.json");

const SYSTEM = `You classify Nostr kind-1 notes for a public trending feed.

Return ONLY a JSON object with this shape:
{
  "spam": boolean,
  "confidence": number,
  "category": string,
  "reason": string
}

Mark spam:true for:
- trading/crypto funnels (VIP signals, Telegram mentorship, fake win-rate flexes, "join my group")
- protocol abuse / machine payloads posted as kind 1 (e.g. zone_presence heartbeats)
- promo farms / engagement bait from known spam patterns

Mark spam:false for:
- normal social posts
- earnest market discussion or personal trade journaling without a sales funnel

confidence is 0..1. category is a short snake_case label. reason is one short sentence.`;

function isEventId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizePrediction(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const spam = Boolean(parsed.spam);
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    spam,
    confidence,
    category:
      typeof parsed.category === "string" ? parsed.category : "unknown",
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

function buildUserPrompt(note) {
  return [
    "Classify this note:",
    "",
    `pubkey: ${note.pubkey || ""}`,
    "",
    "content:",
    typeof note.content === "string" ? note.content : "",
  ].join("\n");
}

function loadLocalCache() {
  try {
    if (!existsSync(CACHE_PATH)) return { byId: {} };
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.byId !== "object") {
      return { byId: {} };
    }
    return { byId: raw.byId };
  } catch {
    return { byId: {} };
  }
}

function saveLocalCache(cache) {
  mkdirSync(LOG_DIR, { recursive: true });
  // Cap local cache size.
  const entries = Object.entries(cache.byId);
  if (entries.length > 4000) {
    entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    cache.byId = Object.fromEntries(entries.slice(entries.length - 4000));
  }
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0));
}

function authHeaders(includeWarmSecret = true) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "trendingnostr-spam-classify/1.0",
  };
  if (includeWarmSecret) {
    headers["x-trending-refresh"] = WARM_SECRET;
  }
  if (BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = BYPASS_SECRET;
  }
  return headers;
}

async function fetchFeedNotes() {
  // Union notes across every served window so short-window rankings that
  // fall outside the 48h top set still get classified.
  const byId = new Map();
  for (const hours of CLASSIFY_HOURS) {
    const url = `${BASE_URL}/api/trending?hours=${hours}`;
    // Do not send x-trending-refresh — that forces a full rebuild.
    const res = await fetch(url, { headers: authHeaders(false) });
    if (!res.ok) {
      throw new Error(`feed_http_${res.status}_hours_${hours}`);
    }
    const data = await res.json();
    const notes = Array.isArray(data?.notes) ? data.notes : [];
    for (const note of notes) {
      if (!note || !isEventId(note.id) || typeof note.content !== "string") {
        continue;
      }
      const id = note.id.toLowerCase();
      if (!byId.has(id)) byId.set(id, note);
    }
  }
  return [...byId.values()];
}

async function classifyNote(note) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: "json",
      think: false,
      options: {
        temperature: 0,
        num_predict: 256,
      },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserPrompt(note) },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ollama_${res.status}:${body.slice(0, 120)}`);
  }
  const payload = await res.json();
  return normalizePrediction(extractJsonObject(payload?.message?.content ?? ""));
}

async function postVerdicts(verdicts) {
  if (verdicts.length === 0) return { added: 0, total: 0 };
  const res = await fetch(`${BASE_URL}/api/spam-verdicts`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ verdicts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`verdicts_http_${res.status}:${body.slice(0, 200)}`);
  }
  return res.json();
}

function summary(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const started = Date.now();
  if (!BASE_URL) {
    summary({
      ok: false,
      error: "missing_TRENDING_CRON_BASE_URL",
      durationMs: 0,
    });
    process.exit(0);
    return;
  }

  try {
    const tags = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!tags.ok) throw new Error(`ollama_unreachable_${tags.status}`);
  } catch (err) {
    summary({
      ok: false,
      error: `ollama_unreachable:${err instanceof Error ? err.message : err}`,
      model: MODEL,
      durationMs: Date.now() - started,
    });
    process.exit(0);
    return;
  }

  let notes;
  try {
    notes = await fetchFeedNotes();
  } catch (err) {
    summary({
      ok: false,
      error: `feed:${err instanceof Error ? err.message : err}`,
      durationMs: Date.now() - started,
    });
    process.exit(0);
    return;
  }

  const cache = loadLocalCache();
  const pending = [];
  for (const note of notes) {
    const id = note.id.toLowerCase();
    if (cache.byId[id]) continue;
    pending.push(note);
    if (pending.length >= MAX_NEW) break;
  }

  const spamVerdicts = [];
  let classified = 0;
  let parseFail = 0;
  let errors = 0;

  for (const note of pending) {
    const id = note.id.toLowerCase();
    try {
      const pred = await classifyNote(note);
      classified += 1;
      if (!pred) {
        parseFail += 1;
        cache.byId[id] = { at: Math.floor(Date.now() / 1000), spam: false, parseFail: true };
        continue;
      }
      const decidedSpam = pred.spam && pred.confidence >= CONFIDENCE;
      cache.byId[id] = {
        at: Math.floor(Date.now() / 1000),
        spam: decidedSpam,
        confidence: pred.confidence,
        category: pred.category,
      };
      if (decidedSpam) {
        spamVerdicts.push({
          id,
          confidence: pred.confidence,
          category: pred.category,
          reason: pred.reason,
          model: MODEL,
        });
      }
    } catch {
      errors += 1;
      // Do not cache failures — retry next tick.
    }
  }

  // Persist non-spam classifications always; only mark spam ids after a
  // successful POST so a failed upload does not permanently skip them.
  const spamIds = new Set(spamVerdicts.map((v) => v.id));
  const cacheWithoutSpam = {
    byId: Object.fromEntries(
      Object.entries(cache.byId).filter(([id]) => !spamIds.has(id))
    ),
  };

  let posted = { added: 0, total: 0 };
  try {
    posted = await postVerdicts(spamVerdicts);
  } catch (err) {
    saveLocalCache(cacheWithoutSpam);
    summary({
      ok: false,
      error: `post:${err instanceof Error ? err.message : err}`,
      model: MODEL,
      hours: CLASSIFY_HOURS,
      feedNotes: notes.length,
      pending: pending.length,
      classified,
      spamFound: spamVerdicts.length,
      parseFail,
      errors,
      durationMs: Date.now() - started,
    });
    process.exit(0);
    return;
  }

  saveLocalCache(cache);

  summary({
    ok: true,
    model: MODEL,
    confidence: CONFIDENCE,
    hours: CLASSIFY_HOURS,
    feedNotes: notes.length,
    pending: pending.length,
    classified,
    spamFound: spamVerdicts.length,
    postedAdded: posted.added ?? 0,
    postedTotal: posted.total ?? 0,
    parseFail,
    errors,
    rewarm: spamVerdicts.length > 0,
    durationMs: Date.now() - started,
  });
}

main().catch((err) => {
  summary({
    ok: false,
    error: String(err instanceof Error ? err.message : err),
  });
  process.exit(0);
});
