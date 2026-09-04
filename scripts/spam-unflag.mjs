#!/usr/bin/env node
/**
 * Mark false-positive event ids as ham locally and clear them on Vercel.
 *
 * Usage:
 *   npm run spam:unflag:all
 *   npm run spam:unflag -- <eventId> [eventId…]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE_URL = (
  process.env.TRENDING_CRON_BASE_URL ||
  "https://trendingnostr.vercel.app"
).replace(/\/$/, "");
const BYPASS_SECRET =
  process.env.TRENDING_CRON_BYPASS_SECRET ||
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
  "";
const LOG_DIR =
  process.env.TRENDING_CRON_LOG_DIR ||
  join(homedir(), "Library/Logs/trendingnostr");
const CACHE_PATH = join(LOG_DIR, "spam-classified.json");

function isEventId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { byId: {} };
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (raw?.byId && typeof raw.byId === "object") return raw;
  } catch {
    // rewrite below
  }
  return { byId: {} };
}

function headers() {
  const h = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "trendingnostr-spam-unflag/1.0",
  };
  if (BYPASS_SECRET) {
    h["x-vercel-protection-bypass"] = BYPASS_SECRET;
  }
  return h;
}

const argv = process.argv.slice(2);
const clearAll = argv.includes("--all");
const explicitIds = argv
  .filter((s) => s !== "--all")
  .map((s) => s.trim().toLowerCase())
  .filter(isEventId);

const cache = loadCache();
const now = Math.floor(Date.now() / 1000);

if (clearAll) {
  const localSpamIds = Object.entries(cache.byId)
    .filter(([, row]) => row && row.spam === true)
    .map(([id]) => id.toLowerCase());

  for (const id of localSpamIds) {
    cache.byId[id] = {
      at: now,
      spam: false,
      confidence: 1,
      category: "human_unflag",
    };
  }
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0));
  console.log(
    `local: marked ${localSpamIds.length} spam id(s) as ham in ${CACHE_PATH}`
  );

  const res = await fetch(`${BASE_URL}/api/spam-verdicts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ clear: true }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`remote: http_${res.status} ${body.slice(0, 400)}`);
    console.error(
      "Deploy the latest /api/spam-verdicts (clear support), then re-run: npm run spam:unflag:all"
    );
    process.exit(1);
  }
  console.log(`remote: ${body}`);
  console.log("re-warm so notes can reappear: npm run cron:prod:run");
  process.exit(0);
}

if (explicitIds.length === 0) {
  console.error("usage: npm run spam:unflag:all");
  console.error("   or: npm run spam:unflag -- <eventId> [eventId…]");
  process.exit(1);
}

for (const id of explicitIds) {
  cache.byId[id] = {
    at: now,
    spam: false,
    confidence: 1,
    category: "human_unflag",
  };
}
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0));
console.log(`local: marked ${explicitIds.length} id(s) as ham in ${CACHE_PATH}`);

const res = await fetch(`${BASE_URL}/api/spam-verdicts`, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({ remove: explicitIds }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`remote: http_${res.status} ${body.slice(0, 400)}`);
  process.exit(1);
}
console.log(`remote: ${body}`);
console.log("re-warm so notes can reappear: npm run cron:prod:run");
