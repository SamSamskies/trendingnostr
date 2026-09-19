#!/usr/bin/env node
/**
 * Scan a cached trending feed for spam via classifier.dev and print Jumble links.
 *
 * Usage:
 *   npm run detect-spam -- 4
 *   npm run detect-spam -- 12 --min-confidence 0.85
 *   npm run detect-spam -- 24 --json
 *
 * Env:
 *   TRENDING_BASE_URL / TRENDING_CRON_BASE_URL  (default https://trendingnostr.vercel.app)
 */

import { nip19 } from "nostr-tools";

const DEFAULT_BASE_URL = "https://trendingnostr.vercel.app";
const DEFAULT_MIN_CONFIDENCE = 0.9;
const HOURS_OPTIONS = new Set([4, 12, 24, 48]);
const CLASSIFIER_URL = "https://classifier.dev";
const USER_AGENT = "trendingnostr-detect-spam/1.0";
const MAX_RELAY_HINTS = 3;

const SPAM_INSTRUCTIONS =
  "Spam means scams, fake giveaways, phishing, engagement bait, crypto pumps, " +
  "bot promotional copy, or low-effort mass advertising. Normal conversation, " +
  "opinions, news, memes, and genuine community posts are not spam.";

function usage(exitCode = 1) {
  console.error(`Usage: npm run detect-spam -- <hours> [options]

Arguments:
  hours                 Trending window: 4, 12, 24, or 48

Options:
  --min-confidence N    Only report spam at or above this confidence (default ${DEFAULT_MIN_CONFIDENCE})
  --base-url URL        Trending API host (default ${DEFAULT_BASE_URL})
  --json                Print JSON instead of one Jumble URL per line
  -h, --help            Show this help

Env:
  TRENDING_BASE_URL / TRENDING_CRON_BASE_URL
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    hours: null,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    baseUrl:
      process.env.TRENDING_BASE_URL ||
      process.env.TRENDING_CRON_BASE_URL ||
      DEFAULT_BASE_URL,
    json: false,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--json") {
      out.json = true;
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

  if (positional.length !== 1) usage(1);
  const hours = Number(positional[0]);
  if (!HOURS_OPTIONS.has(hours)) {
    console.error(`error: hours must be one of ${[...HOURS_OPTIONS].join(", ")}`);
    process.exit(1);
  }
  out.hours = hours;
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

async function fetchFeed(baseUrl, hours) {
  const url = `${baseUrl}/api/trending?hours=${hours}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
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
  const feed = await fetchFeed(opts.baseUrl, opts.hours);
  const notes = feed.notes.filter(
    (note) => note && typeof note.id === "string" && typeof note.content === "string"
  );

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
          minConfidence: opts.minConfidence,
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

  console.error(
    `# ${opts.hours}h feed: ${notes.length} notes → ${spam.length} spam (≥${opts.minConfidence})`
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
