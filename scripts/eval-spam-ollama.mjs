#!/usr/bin/env node
/**
 * Spike: classify labeled Nostr notes via local Ollama and score the run.
 *
 * Usage:
 *   node scripts/eval-spam-ollama.mjs
 *   node scripts/eval-spam-ollama.mjs qwen3:1.7b
 *   node scripts/eval-spam-ollama.mjs qwen3:1.7b Osmosis/Osmosis-Structure-0.6B:latest
 *   SPAM_CONFIDENCE=0.9 OLLAMA_HOST=http://127.0.0.1:11434 node scripts/eval-spam-ollama.mjs
 *
 * Prints a comparison table + per-fixture misses. Does not change the feed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURES_PATH = join(ROOT, "evals/spam/fixtures.json");

const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(
  /\/$/,
  ""
);
const CONFIDENCE =
  Number(process.env.SPAM_CONFIDENCE || "0.9") || 0.9;
const DEFAULT_MODELS = ["qwen3:1.7b"];

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

function loadFixtures() {
  const raw = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`no fixtures in ${FIXTURES_PATH}`);
  }
  return raw;
}

function buildUserPrompt(fixture) {
  const profile = fixture.profile || {};
  return [
    "Classify this note:",
    "",
    `display_name: ${profile.display_name ?? ""}`,
    `name: ${profile.name ?? ""}`,
    `lud16: ${profile.lud16 ?? ""}`,
    `nip05: ${profile.nip05 ?? ""}`,
    "",
    "content:",
    fixture.content,
  ].join("\n");
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  // Qwen3 may emit <think>…</think> before JSON when think isn't disabled.
  const trimmed = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models sometimes wrap JSON in prose.
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
  if (!Number.isFinite(confidence)) confidence = spam ? 0.5 : 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    spam,
    confidence,
    category:
      typeof parsed.category === "string" ? parsed.category : "unknown",
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

async function classifyNote(model, fixture) {
  const started = performance.now();
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      // Qwen3 otherwise spends tokens on chain-of-thought and breaks JSON.
      think: false,
      options: {
        temperature: 0,
        num_predict: 256,
      },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserPrompt(fixture) },
      ],
    }),
  });

  const latencyMs = performance.now() - started;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ollama ${res.status}: ${body.slice(0, 200)}`);
  }

  const payload = await res.json();
  const content = payload?.message?.content ?? "";
  const parsed = normalizePrediction(extractJsonObject(content));
  return {
    latencyMs,
    raw: content,
    parsed,
    decidedSpam: Boolean(
      parsed && parsed.spam && parsed.confidence >= CONFIDENCE
    ),
  };
}

function emptyMetrics() {
  return {
    n: 0,
    parseOk: 0,
    tp: 0,
    fp: 0,
    tn: 0,
    fn: 0,
    latencies: [],
    misses: [],
  };
}

function scoreRun(fixtures, results) {
  const m = emptyMetrics();
  for (let i = 0; i < fixtures.length; i++) {
    const fix = fixtures[i];
    const result = results[i];
    m.n += 1;
    m.latencies.push(result.latencyMs);
    if (!result.parsed) {
      m.misses.push({
        id: fix.id,
        kind: "parse_fail",
        label: fix.label,
        raw: String(result.raw || "").slice(0, 160),
      });
      // Fail open: unparsed => treat as not spam for decision metrics.
      if (fix.label) m.fn += 1;
      else m.tn += 1;
      continue;
    }
    m.parseOk += 1;
    const pred = result.decidedSpam;
    if (fix.label && pred) m.tp += 1;
    else if (!fix.label && pred) {
      m.fp += 1;
      m.misses.push({
        id: fix.id,
        kind: "false_positive",
        label: fix.label,
        pred: result.parsed,
      });
    } else if (fix.label && !pred) {
      m.fn += 1;
      m.misses.push({
        id: fix.id,
        kind: "false_negative",
        label: fix.label,
        pred: result.parsed,
      });
    } else m.tn += 1;
  }
  return m;
}

function pct(n) {
  return `${(100 * n).toFixed(1)}%`;
}

function summarize(model, metrics) {
  const { tp, fp, tn, fn, n, parseOk, latencies } = metrics;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const accuracy = n === 0 ? 0 : (tp + tn) / n;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor((sorted.length - 1) * 0.5)] || 0;
  const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)] || 0;
  return {
    model,
    n,
    parseRate: parseOk / n,
    accuracy,
    precision,
    recall,
    tp,
    fp,
    tn,
    fn,
    p50Ms: p50,
    p95Ms: p95,
    totalMs: latencies.reduce((a, b) => a + b, 0),
  };
}

function printTable(rows) {
  const header = [
    "model",
    "parse",
    "acc",
    "prec@thr",
    "recall",
    "fp",
    "fn",
    "p50ms",
    "p95ms",
  ];
  const lines = [header.join("\t")];
  for (const r of rows) {
    lines.push(
      [
        r.model,
        pct(r.parseRate),
        pct(r.accuracy),
        pct(r.precision),
        pct(r.recall),
        String(r.fp),
        String(r.fn),
        r.p50Ms.toFixed(0),
        r.p95Ms.toFixed(0),
      ].join("\t")
    );
  }
  console.log(lines.join("\n"));
}

async function runModel(model, fixtures) {
  console.error(`\n=== ${model} (${fixtures.length} fixtures, thr=${CONFIDENCE}) ===`);
  const results = [];
  for (const fix of fixtures) {
    process.stderr.write(`  ${fix.id.slice(0, 16)}… `);
    try {
      const result = await classifyNote(model, fix);
      results.push(result);
      const mark = !result.parsed
        ? "PARSE?"
        : result.decidedSpam === fix.label
          ? "ok"
          : result.decidedSpam
            ? "FP"
            : "FN";
      console.error(
        `${mark}  spam=${result.parsed?.spam ?? "?"} conf=${
          result.parsed?.confidence?.toFixed?.(2) ?? "?"
        }  ${result.latencyMs.toFixed(0)}ms`
      );
    } catch (err) {
      console.error(`ERR ${err instanceof Error ? err.message : err}`);
      results.push({
        latencyMs: 0,
        raw: "",
        parsed: null,
        decidedSpam: false,
        error: String(err),
      });
    }
  }
  const metrics = scoreRun(fixtures, results);
  const summary = summarize(model, metrics);
  return { summary, metrics, results };
}

async function main() {
  const models =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : DEFAULT_MODELS;

  const fixtures = loadFixtures();
  const spamN = fixtures.filter((f) => f.label).length;
  const hamN = fixtures.length - spamN;
  console.error(
    `fixtures=${fixtures.length} (spam=${spamN}, ham=${hamN}) host=${OLLAMA_HOST}`
  );

  // Warm / reachability check.
  const tags = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!tags.ok) {
    throw new Error(`cannot reach Ollama at ${OLLAMA_HOST}`);
  }

  const rows = [];
  for (const model of models) {
    const { summary, metrics } = await runModel(model, fixtures);
    rows.push(summary);
    if (metrics.misses.length) {
      console.error(`\nmisses for ${model}:`);
      for (const miss of metrics.misses) {
        console.error(
          `  [${miss.kind}] ${miss.id}` +
            (miss.pred
              ? ` → spam=${miss.pred.spam} conf=${miss.pred.confidence} (${miss.pred.category}) ${miss.pred.reason}`
              : miss.raw
                ? ` → ${miss.raw}`
                : "")
        );
      }
    }
  }

  console.log("");
  printTable(rows);
  console.log(
    `\nDecision rule: drop only if spam===true && confidence>=${CONFIDENCE}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
