#!/usr/bin/env node
/**
 * Scan a fresh trending feed for spam via classifier.dev and print Jumble links.
 *
 * Fetches `/api/trending` with the same cache-bust path as the Mac Mini warmer
 * (`&_warm=1` + `x-trending-refresh`) so Pragma/no-cache CDN HITs are bypassed
 * and Runtime Cache is rebuilt before classifying.
 *
 * Usage:
 *   npm run detect-spam
 *   npm run detect-spam -- 12 --min-confidence 0.85
 *   npm run detect-spam -- 24 --json
 *   npm run detect-spam -- --cached
 *
 * Env:
 *   TRENDING_BASE_URL / TRENDING_CRON_BASE_URL  (default https://trendingnostr.vercel.app)
 *   TRENDING_WARM_SECRET  (must match Vercel if set; default 1; also read from .env.local)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nip19 } from "nostr-tools";

const DEFAULT_BASE_URL = "https://trendingnostr.vercel.app";
const DEFAULT_MIN_CONFIDENCE = 0.9;
const DEFAULT_HOURS = 4;
const DEFAULT_WARM_SECRET = "1";
const HOURS_OPTIONS = new Set([4, 12, 24, 48]);
const CLASSIFIER_URL = "https://classifier.dev";
const USER_AGENT = "trendingnostr-detect-spam/1.0";
const MAX_RELAY_HINTS = 3;
const REFRESH_HEADER = "x-trending-refresh";

const SPAM_INSTRUCTIONS =
  "Spam means scams, fake giveaways, phishing, engagement bait, crypto pumps, " +
  "bot promotional copy, or low-effort mass advertising. Normal conversation, " +
  "opinions, news, memes, and genuine community posts are not spam.";

/** Authors whose notes are skipped before classification (lowercase hex). */
const WHITELISTED_AUTHOR_PUBKEYS = new Set([
  "1e067bfb58820576df3daf7cb051d4411b80a0b8fa12fc253cd0ab41cf1a2069",
  "64acf4055fa826bcab8457e24ef8fba7490abb1e76dbab6aa8752a53a0eb4d4a",
  "d9f2471cc8f33111071bd0de1fef87d783cc4140e0f70ba9298a53b9e07c60f6",
  "db64dee83596b7c5638995032dc2822e99a6673ec3a958a5b10921ab9f983bfe",
  "e83b66a8ed2d37c07d1abea6e1b000a15549c69508fa4c5875556d52b0526c2b",
]);

function readWarmSecretFromEnvLocal() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const text = readFileSync(join(root, ".env.local"), "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.startsWith("TRENDING_WARM_SECRET=")) {
        continue;
      }
      let value = line.slice("TRENDING_WARM_SECRET=".length).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
  } catch {
    // No .env.local — fall through to default.
  }
  return null;
}

function warmSecret() {
  return (
    process.env.TRENDING_WARM_SECRET ||
    readWarmSecretFromEnvLocal() ||
    DEFAULT_WARM_SECRET
  );
}

function usage(exitCode = 1) {
  console.error(`Usage: npm run detect-spam -- [hours] [options]

Arguments:
  hours                 Trending window: 4, 12, 24, or 48 (default ${DEFAULT_HOURS})

Options:
  --min-confidence N    Only report spam at or above this confidence (default ${DEFAULT_MIN_CONFIDENCE})
  --base-url URL        Trending API host (default ${DEFAULT_BASE_URL})
  --cached              Use CDN/Runtime Cache (skip rebuild; faster, may be stale)
  --json                Print JSON instead of one Jumble URL per line
  -h, --help            Show this help

Env:
  TRENDING_BASE_URL / TRENDING_CRON_BASE_URL
  TRENDING_WARM_SECRET
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    hours: DEFAULT_HOURS,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    baseUrl:
      process.env.TRENDING_BASE_URL ||
      process.env.TRENDING_CRON_BASE_URL ||
      DEFAULT_BASE_URL,
    json: false,
    cached: false,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--cached") {
      out.cached = true;
      continue;
    }
    if (arg === "--min-confidence") {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        console.error(`error: --min-confidence expects 0–1, got ${raw}`);
        process.exit(1);
      }
      out.minConfidence = value;
      continue;
    }
    if (arg === "--base-url") {
      const raw = argv[++i];
      if (!raw) {
        console.error("error: --base-url requires a URL");
        process.exit(1);
      }
      out.baseUrl = raw;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`error: unknown option ${arg}`);
      usage(1);
    }
    positional.push(arg);
  }

  if (positional.length > 1) usage(1);
  if (positional.length === 1) {
    const hours = Number(positional[0]);
    if (!HOURS_OPTIONS.has(hours)) {
      console.error(`error: hours must be one of ${[...HOURS_OPTIONS].join(", ")}`);
      process.exit(1);
    }
    out.hours = hours;
  }
  out.baseUrl = out.baseUrl.replace(/\/$/, "");
  return out;
}

function jumbleHref(note) {
  const relays = Array.isArray(note.seenOn)
    ? note.seenOn.filter((r) => typeof r === "string").slice(0, MAX_RELAY_HINTS)
    : [];
  const code = nip19.neventEncode({
    id: note.id,
    author: note.pubkey,
    kind: note.kind ?? 1,
    relays,
  });
  return `https://jumble.social/${code}`;
}

async function fetchFeed(baseUrl, hours, { cached = false } = {}) {
  // Pragma/Cache-Control: no-cache does not bypass a fresh Vercel CDN HIT.
  // Same path as trending-cron.sh: distinct URL key + refresh header → origin
  // rebuilds Runtime Cache and responds no-store.
  const url = cached
    ? `${baseUrl}/api/trending?hours=${hours}`
    : `${baseUrl}/api/trending?hours=${hours}&_warm=1`;
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (!cached) {
    headers[REFRESH_HEADER] = warmSecret();
  }

  const response = await fetch(url, { headers });
  if (response.status === 401) {
    throw new Error(
      `trending API rejected ${REFRESH_HEADER} (set TRENDING_WARM_SECRET to match Vercel)`
    );
  }
  if (!response.ok) {
    throw new Error(`trending API HTTP ${response.status} for ${url}`);
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.notes)) {
    throw new Error("trending API returned no notes array");
  }
  return data;
}

async function classifyContents(texts) {
  if (texts.length === 0) return [];
  const response = await fetch(CLASSIFIER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      labels: ["spam", "not spam"],
      inputs: texts,
      instructions: SPAM_INSTRUCTIONS,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `classifier.dev HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }
  const data = await response.json();
  if (!Array.isArray(data.results)) {
    throw new Error("classifier.dev returned no results array");
  }
  if (data.results.length !== texts.length) {
    throw new Error(
      `classifier.dev result count mismatch (${data.results.length} vs ${texts.length})`
    );
  }
  return data.results;
}

function preview(content, max = 80) {
  const oneLine = String(content).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.cached) {
    console.error(`# rebuilding ${opts.hours}h feed (cache bust)…`);
  }
  const feed = await fetchFeed(opts.baseUrl, opts.hours, { cached: opts.cached });
  const allNotes = feed.notes.filter(
    (note) => note && typeof note.id === "string" && typeof note.content === "string"
  );
  const notes = allNotes.filter((note) => {
    const pubkey = typeof note.pubkey === "string" ? note.pubkey.toLowerCase() : "";
    return !WHITELISTED_AUTHOR_PUBKEYS.has(pubkey);
  });
  const whitelistedSkipped = allNotes.length - notes.length;

  const results = await classifyContents(notes.map((note) => note.content));

  const spam = [];
  for (let i = 0; i < notes.length; i++) {
    const result = results[i];
    const confidence =
      typeof result?.confidence === "number" ? result.confidence : null;
    if (result?.label !== "spam") continue;
    if (confidence == null || confidence < opts.minConfidence) continue;
    spam.push({
      note: notes[i],
      confidence,
      scores: result.scores ?? null,
      jumble: jumbleHref(notes[i]),
    });
  }

  spam.sort((a, b) => b.confidence - a.confidence);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          hours: opts.hours,
          scanned: notes.length,
          feedNotes: allNotes.length,
          minConfidence: opts.minConfidence,
          cacheBust: !opts.cached,
          whitelistedSkipped,
          spamCount: spam.length,
          spam: spam.map((row) => ({
            id: row.note.id,
            pubkey: row.note.pubkey,
            confidence: row.confidence,
            jumble: row.jumble,
            content: row.note.content,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  const whitelistNote =
    whitelistedSkipped > 0 ? `, skipped ${whitelistedSkipped} whitelisted` : "";
  console.error(
    `# ${opts.hours}h feed: ${notes.length} notes → ${spam.length} spam (≥${opts.minConfidence})${whitelistNote}`
  );
  for (const row of spam) {
    console.error(`# ${row.confidence.toFixed(2)}  ${preview(row.note.content)}`);
    console.log(row.jumble);
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
