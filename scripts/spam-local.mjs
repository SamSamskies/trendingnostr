#!/usr/bin/env node
/**
 * Show local Ollama spam classify cache (Mac Mini).
 *
 * Usage:
 *   npm run spam:local
 *   npm run spam:local -- --json
 *   npm run spam:local -- --all
 *
 * Env: TRENDING_CRON_LOG_DIR (default ~/Library/Logs/trendingnostr)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nip19 } from "nostr-tools";

const LOG_DIR =
  process.env.TRENDING_CRON_LOG_DIR ||
  join(homedir(), "Library/Logs/trendingnostr");
const CACHE_PATH = join(LOG_DIR, "spam-classified.json");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const showAll = args.has("--all");

function njumpUrl(eventId) {
  try {
    const code = nip19.neventEncode({ id: eventId });
    return `https://njump.me/${code}`;
  } catch {
    return `https://njump.me/${eventId}`;
  }
}

function load() {
  if (!existsSync(CACHE_PATH)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.byId !== "object") {
      return { byId: {} };
    }
    return raw;
  } catch (err) {
    console.error(`failed to read ${CACHE_PATH}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const cache = load();
if (!cache) {
  console.log(`No cache yet at ${CACHE_PATH}`);
  process.exit(0);
}

const entries = Object.entries(cache.byId).map(([id, row]) => ({
  id,
  njump: njumpUrl(id),
  spam: Boolean(row?.spam),
  confidence: row?.confidence,
  category: row?.category,
  at: row?.at,
  parseFail: Boolean(row?.parseFail),
}));

entries.sort((a, b) => (b.at || 0) - (a.at || 0));

const spam = entries.filter((e) => e.spam);
const ham = entries.filter((e) => !e.spam);
const listed = showAll ? entries : spam;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        path: CACHE_PATH,
        total: entries.length,
        spam: spam.length,
        ham: ham.length,
        entries: listed,
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`path:  ${CACHE_PATH}`);
console.log(`total: ${entries.length}  spam: ${spam.length}  ham: ${ham.length}`);
if (listed.length === 0) {
  console.log(showAll ? "(empty cache)" : "(no spam decisions yet — try --all)");
  process.exit(0);
}

console.log("");
for (const e of listed) {
  const when =
    typeof e.at === "number"
      ? new Date(e.at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
      : "?";
  const conf =
    typeof e.confidence === "number" ? e.confidence.toFixed(2) : "?";
  const cat = e.category || (e.parseFail ? "parse_fail" : "-");
  const mark = e.spam ? "SPAM" : "ham ";
  console.log(`${mark}  conf=${conf}  ${cat}  ${when}`);
  console.log(`      ${e.njump}`);
}
