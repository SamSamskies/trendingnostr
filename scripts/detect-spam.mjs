#!/usr/bin/env node
/**
 * Scan a fresh trending feed for spam and print Jumble links.
 *
 * Default provider is a local Ollama System One decision model
 * (https://docs.ollama.com/capabilities/decision). Pass `--classifier` to use
 * classifier.dev instead.
 *
 * Fetches `/api/trending` with the same cache-bust path as the Mac Mini warmer
 * (`&_warm=1` + `x-trending-refresh`) so Pragma/no-cache CDN HITs are bypassed
 * and Runtime Cache is rebuilt before classifying.
 *
 * Usage:
 *   npm run detect-spam
 *   npm run detect-spam -- 12 --min-confidence 0.85
 *   npm run detect-spam -- --model nimble
 *   npm run detect-spam -- --model clef --cached
 *   npm run detect-spam -- --classifier
 *   npm run detect-spam -- --eval
 *   npm run detect-spam -- --eval --models nimble,clef
 *
 * Env:
 *   TRENDING_BASE_URL / TRENDING_CRON_BASE_URL  (default https://trendingnostr.vercel.app)
 *   TRENDING_WARM_SECRET  (must match Vercel if set; default 1; also read from .env.local)
 *   OLLAMA_HOST           (default http://localhost:11434; also .env.local)
 *   OLLAMA_MODEL          (default clef-flash; also .env.local; overridden by --model)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nip19 } from "nostr-tools";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE_URL = "https://trendingnostr.vercel.app";
const DEFAULT_MIN_CONFIDENCE = 0.9;
const DEFAULT_HOURS = 4;
const DEFAULT_WARM_SECRET = "1";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "clef-flash";
const DEFAULT_OLLAMA_CONCURRENCY = 4;
const DEFAULT_EVAL_PATH = join(SCRIPT_DIR, "fixtures", "spam-eval.jsonl");
const HOURS_OPTIONS = new Set([4, 12, 24, 48]);
const CLASSIFIER_URL = "https://classifier.dev";
const USER_AGENT = "trendingnostr-detect-spam/1.0";
const MAX_RELAY_HINTS = 3;
const REFRESH_HEADER = "x-trending-refresh";
const PROVIDERS = new Set(["classifier", "ollama"]);

const SPAM_INSTRUCTIONS =
  "Spam means scams, fake giveaways, phishing, engagement bait, crypto pumps, " +
  "bot promotional copy, or low-effort mass advertising. Normal conversation, " +
  "opinions, news, memes, and genuine community posts are not spam.";

const OLLAMA_CRITERIA = {
  spam:
    "Scam, phishing, fake giveaway, engagement bait, crypto pump, bot promo, or low-effort mass advertising",
  not_spam:
    "Normal conversation, opinion, news, meme, or genuine community post",
};

/** Authors whose notes are skipped before classification (lowercase hex). */
const WHITELISTED_AUTHOR_PUBKEYS = new Set([
  "1e067bfb58820576df3daf7cb051d4411b80a0b8fa12fc253cd0ab41cf1a2069",
  "64acf4055fa826bcab8457e24ef8fba7490abb1e76dbab6aa8752a53a0eb4d4a",
  "d9f2471cc8f33111071bd0de1fef87d783cc4140e0f70ba9298a53b9e07c60f6",
  "db64dee83596b7c5638995032dc2822e99a6673ec3a958a5b10921ab9f983bfe",
  "e83b66a8ed2d37c07d1abea6e1b000a15549c69508fa4c5875556d52b0526c2b",
]);

function readEnvLocal(key) {
  try {
    const root = join(SCRIPT_DIR, "..");
    const text = readFileSync(join(root, ".env.local"), "utf8");
    const prefix = `${key}=`;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.startsWith(prefix)) {
        continue;
      }
      let value = line.slice(prefix.length).trim();
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

function envOrLocal(key) {
  return process.env[key] || readEnvLocal(key) || null;
}

function warmSecret() {
  return envOrLocal("TRENDING_WARM_SECRET") || DEFAULT_WARM_SECRET;
}

function usage(exitCode = 1) {
  console.error(`Usage: npm run detect-spam -- [hours] [options]

Arguments:
  hours                 Trending window: 4, 12, 24, or 48 (default ${DEFAULT_HOURS})

Options:
  --min-confidence N    Only report spam at or above this confidence (default ${DEFAULT_MIN_CONFIDENCE})
  --base-url URL        Trending API host (default ${DEFAULT_BASE_URL})
  --cached              Use CDN/Runtime Cache (skip rebuild; faster, may be stale)
  --provider NAME       ollama (default) or classifier
  --ollama              Shorthand for --provider ollama
  --classifier          Shorthand for --provider classifier
  --model NAME          Ollama decision model (default ${DEFAULT_OLLAMA_MODEL} or OLLAMA_MODEL)
  --models LIST         Comma-separated models for --eval comparison
  --ollama-host URL     Ollama base URL (default ${DEFAULT_OLLAMA_HOST} or OLLAMA_HOST)
  --concurrency N       Parallel Ollama requests (default ${DEFAULT_OLLAMA_CONCURRENCY})
  --eval [PATH]         Score labeled fixture(s); default ${DEFAULT_EVAL_PATH}
  --json                Print JSON instead of one Jumble URL per line
  -h, --help            Show this help

Env (process env or .env.local):
  TRENDING_BASE_URL / TRENDING_CRON_BASE_URL
  TRENDING_WARM_SECRET
  OLLAMA_HOST
  OLLAMA_MODEL
`);
  process.exit(exitCode);
}

function parseCsvList(raw) {
  return String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
    provider: "ollama",
    model: envOrLocal("OLLAMA_MODEL") || DEFAULT_OLLAMA_MODEL,
    models: null,
    modelSet: false,
    ollamaHost: envOrLocal("OLLAMA_HOST") || DEFAULT_OLLAMA_HOST,
    concurrency: DEFAULT_OLLAMA_CONCURRENCY,
    evalPath: null,
    eval: false,
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
    if (arg === "--ollama") {
      out.provider = "ollama";
      continue;
    }
    if (arg === "--classifier") {
      out.provider = "classifier";
      continue;
    }
    if (arg === "--provider") {
      const raw = argv[++i];
      if (!raw || !PROVIDERS.has(raw)) {
        console.error(`error: --provider expects classifier or ollama, got ${raw}`);
        process.exit(1);
      }
      out.provider = raw;
      continue;
    }
    if (arg === "--model") {
      const raw = argv[++i];
      if (!raw) {
        console.error("error: --model requires a name");
        process.exit(1);
      }
      out.model = raw;
      out.modelSet = true;
      continue;
    }
    if (arg === "--models") {
      const raw = argv[++i];
      const list = raw ? parseCsvList(raw) : [];
      if (list.length === 0) {
        console.error("error: --models requires a comma-separated list");
        process.exit(1);
      }
      out.models = list;
      continue;
    }
    if (arg === "--ollama-host") {
      const raw = argv[++i];
      if (!raw) {
        console.error("error: --ollama-host requires a URL");
        process.exit(1);
      }
      out.ollamaHost = raw;
      continue;
    }
    if (arg === "--concurrency") {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        console.error(`error: --concurrency expects a positive integer, got ${raw}`);
        process.exit(1);
      }
      out.concurrency = value;
      continue;
    }
    if (arg === "--eval") {
      out.eval = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.evalPath = argv[++i];
      } else {
        out.evalPath = DEFAULT_EVAL_PATH;
      }
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

  if (out.models) {
    out.eval = true;
    out.evalPath = out.evalPath || DEFAULT_EVAL_PATH;
    out.provider = "ollama";
  } else if (out.eval && out.modelSet) {
    out.provider = "ollama";
  }

  out.baseUrl = out.baseUrl.replace(/\/$/, "");
  out.ollamaHost = out.ollamaHost.replace(/\/$/, "");
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

function normalizeLabel(label) {
  if (label === "not_spam") return "not spam";
  return label;
}

async function classifyWithClassifier(texts) {
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
  return data.results.map((result) => ({
    label: normalizeLabel(result?.label),
    confidence:
      typeof result?.confidence === "number" ? result.confidence : null,
    scores: result?.scores ?? null,
  }));
}

async function mapPool(items, concurrency, worker, { onProgress } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
      done++;
      onProgress?.(done, items.length, index);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    run()
  );
  await Promise.all(runners);
  return results;
}

async function classifyOneWithOllama(text, { host, model }) {
  const response = await fetch(`${host}/v1/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model,
      state: text,
      questions: {
        label: {
          type: "choice",
          instructions: `Which label fits this Nostr note? ${SPAM_INSTRUCTIONS}`,
          criteria: OLLAMA_CRITERIA,
        },
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `ollama systemone HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }
  const data = await response.json();
  const answer = data?.answers?.label;
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("ollama systemone returned no choice answer");
  }
  const label = normalizeLabel(answer.choice);
  const probabilities = answer.probabilities ?? {};
  const spamScore =
    typeof probabilities.spam === "number" ? probabilities.spam : null;
  const chosenScore =
    typeof probabilities[answer.choice] === "number"
      ? probabilities[answer.choice]
      : typeof probabilities.not_spam === "number" && label === "not spam"
        ? probabilities.not_spam
        : null;
  // Prefer P(chosen label) for thresholds; falls back to entropy confidence.
  const confidence =
    chosenScore ??
    (typeof answer.confidence === "number" ? answer.confidence : null);
  return {
    label,
    confidence,
    scores: {
      spam: spamScore,
      "not spam":
        typeof probabilities.not_spam === "number" ? probabilities.not_spam : null,
    },
    ollamaConfidence:
      typeof answer.confidence === "number" ? answer.confidence : null,
  };
}

async function classifyWithOllama(texts, { host, model, concurrency }) {
  if (texts.length === 0) return [];
  const started = performance.now();
  return mapPool(
    texts,
    concurrency,
    (text) => classifyOneWithOllama(text, { host, model }),
    {
      onProgress(done, total) {
        const elapsed = (performance.now() - started) / 1000;
        const rate = done / Math.max(elapsed, 0.001);
        const eta = rate > 0 ? (total - done) / rate : null;
        const etaNote = eta == null ? "" : `  eta ${Math.ceil(eta)}s`;
        console.error(
          `# ollama ${model}: ${done}/${total}  ${elapsed.toFixed(0)}s${etaNote}`
        );
      },
    }
  );
}

async function classifyContents(texts, opts) {
  if (opts.provider === "ollama") {
    return classifyWithOllama(texts, {
      host: opts.ollamaHost,
      model: opts.model,
      concurrency: opts.concurrency,
    });
  }
  return classifyWithClassifier(texts);
}

function preview(content, max = 80) {
  const oneLine = String(content).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function loadEvalExamples(path) {
  const text = readFileSync(path, "utf8");
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`eval file is empty: ${path}`);

  /** @type {Array<{id?: string, label: string, content: string}>} */
  let rows;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("eval JSON root must be an array");
    rows = parsed;
  } else {
    rows = trimmed.split("\n").filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(
          `eval JSONL parse error on line ${index + 1}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });
  }

  return rows.map((row, index) => {
    const content = row?.content ?? row?.text ?? row?.state;
    const label = normalizeLabel(row?.label);
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`eval row ${index + 1} missing content`);
    }
    if (label !== "spam" && label !== "not spam") {
      throw new Error(
        `eval row ${index + 1} label must be "spam" or "not spam", got ${row?.label}`
      );
    }
    return {
      id: typeof row.id === "string" ? row.id : `row-${index + 1}`,
      label,
      content,
    };
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

function scoreEval(examples, results, latenciesMs) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const mistakes = [];

  for (let i = 0; i < examples.length; i++) {
    const expected = examples[i].label;
    const predicted = results[i]?.label;
    if (expected === "spam" && predicted === "spam") tp++;
    else if (expected === "not spam" && predicted === "spam") {
      fp++;
      mistakes.push({
        id: examples[i].id,
        expected,
        predicted,
        confidence: results[i]?.confidence ?? null,
        content: examples[i].content,
      });
    } else if (expected === "not spam" && predicted === "not spam") tn++;
    else if (expected === "spam" && predicted === "not spam") {
      fn++;
      mistakes.push({
        id: examples[i].id,
        expected,
        predicted,
        confidence: results[i]?.confidence ?? null,
        content: examples[i].content,
      });
    } else {
      mistakes.push({
        id: examples[i].id,
        expected,
        predicted: predicted ?? null,
        confidence: results[i]?.confidence ?? null,
        content: examples[i].content,
      });
      fn += expected === "spam" ? 1 : 0;
      fp += expected === "not spam" ? 1 : 0;
    }
  }

  const total = examples.length;
  const accuracy = total === 0 ? 0 : (tp + tn) / total;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
  const latencySum = latenciesMs.reduce((a, b) => a + b, 0);

  const thresholds = [0.5, 0.7, 0.8, 0.9, 0.95];
  const atThreshold = thresholds.map((threshold) => {
    let correct = 0;
    let decided = 0;
    for (let i = 0; i < examples.length; i++) {
      const conf = results[i]?.confidence;
      if (typeof conf !== "number" || conf < threshold) continue;
      decided++;
      if (results[i]?.label === examples[i].label) correct++;
    }
    return {
      threshold,
      decided,
      coverage: total === 0 ? 0 : decided / total,
      accuracy: decided === 0 ? null : correct / decided,
    };
  });

  return {
    total,
    tp,
    fp,
    tn,
    fn,
    accuracy,
    precision,
    recall,
    f1,
    latency: {
      count: latenciesMs.length,
      avgMs: latenciesMs.length === 0 ? null : latencySum / latenciesMs.length,
      p50Ms: percentile(sortedLatencies, 50),
      p95Ms: percentile(sortedLatencies, 95),
      totalMs: latencySum,
    },
    atThreshold,
    mistakes,
  };
}

function formatPct(value) {
  if (value == null || Number.isNaN(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value) {
  if (value == null || Number.isNaN(value)) return "n/a";
  return `${Math.round(value)}ms`;
}

async function runEvalForModel(examples, opts, model) {
  const latenciesMs = [];
  const started = performance.now();
  const results = await mapPool(examples, opts.concurrency, async (example) => {
    const t0 = performance.now();
    try {
      if (opts.provider === "classifier") {
        const [result] = await classifyWithClassifier([example.content]);
        latenciesMs.push(performance.now() - t0);
        return result;
      }
      const result = await classifyOneWithOllama(example.content, {
        host: opts.ollamaHost,
        model,
      });
      latenciesMs.push(performance.now() - t0);
      return result;
    } catch (err) {
      latenciesMs.push(performance.now() - t0);
      throw err;
    }
  });
  const wallMs = performance.now() - started;
  const metrics = scoreEval(examples, results, latenciesMs);
  return { model, wallMs, results, metrics };
}

async function runEval(opts) {
  const examples = loadEvalExamples(opts.evalPath);
  const models =
    opts.models ??
    (opts.provider === "ollama" ? [opts.model] : ["classifier.dev"]);
  const provider =
    opts.models || opts.provider === "ollama" ? "ollama" : "classifier";

  console.error(
    `# eval ${examples.length} examples from ${opts.evalPath} via ${provider}`
  );

  const reports = [];
  for (const model of models) {
    console.error(`# running ${model}…`);
    const report = await runEvalForModel(
      examples,
      { ...opts, provider, model },
      model
    );
    reports.push(report);
    const m = report.metrics;
    console.error(
      `# ${model}: acc=${formatPct(m.accuracy)}  prec=${formatPct(m.precision)}  ` +
        `rec=${formatPct(m.recall)}  f1=${formatPct(m.f1)}  ` +
        `avg=${formatMs(m.latency.avgMs)}  p95=${formatMs(m.latency.p95Ms)}  ` +
        `wall=${formatMs(report.wallMs)}`
    );
    console.error(
      `# ${model}: confusion tp=${m.tp} fp=${m.fp} tn=${m.tn} fn=${m.fn}`
    );
    for (const row of m.atThreshold) {
      console.error(
        `# ${model}: conf≥${row.threshold} coverage=${formatPct(row.coverage)} ` +
          `accuracy=${formatPct(row.accuracy)} (${row.decided}/${m.total})`
      );
    }
    if (m.mistakes.length > 0) {
      console.error(`# ${model}: ${m.mistakes.length} mistake(s)`);
      for (const mistake of m.mistakes) {
        const conf =
          typeof mistake.confidence === "number"
            ? mistake.confidence.toFixed(2)
            : "n/a";
        console.error(
          `#   ${mistake.id} expected=${mistake.expected} got=${mistake.predicted} ` +
            `conf=${conf}  ${preview(mistake.content, 70)}`
        );
      }
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          evalPath: opts.evalPath,
          provider,
          examples: examples.length,
          reports: reports.map((report) => ({
            model: report.model,
            wallMs: report.wallMs,
            metrics: {
              ...report.metrics,
              mistakes: report.metrics.mistakes.map((m) => ({
                id: m.id,
                expected: m.expected,
                predicted: m.predicted,
                confidence: m.confidence,
                content: m.content,
              })),
            },
            predictions: examples.map((example, i) => ({
              id: example.id,
              expected: example.label,
              predicted: report.results[i]?.label ?? null,
              confidence: report.results[i]?.confidence ?? null,
              scores: report.results[i]?.scores ?? null,
            })),
          })),
        },
        null,
        2
      )
    );
  }
}

async function runFeedScan(opts) {
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

  const providerLabel =
    opts.provider === "ollama" ? `ollama/${opts.model}` : "classifier.dev";
  console.error(`# classifying ${notes.length} notes with ${providerLabel}…`);

  const results = await classifyContents(
    notes.map((note) => note.content),
    opts
  );

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
          provider: opts.provider,
          model: opts.provider === "ollama" ? opts.model : "classifier.dev",
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
    `# ${opts.hours}h feed: ${notes.length} notes → ${spam.length} spam (≥${opts.minConfidence}) via ${providerLabel}${whitelistNote}`
  );
  for (const row of spam) {
    console.error(`# ${row.confidence.toFixed(2)}  ${preview(row.note.content)}`);
    console.log(row.jumble);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.eval) {
    await runEval(opts);
    return;
  }
  if (opts.provider === "ollama" && opts.models) {
    console.error("error: --models is only valid with --eval");
    process.exit(1);
  }
  await runFeedScan(opts);
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
