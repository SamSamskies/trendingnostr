/**
 * Hosted inference fallback. The public contract is generic so the provider
 * behind this file can change without renaming `/api/inference`.
 *
 * Current implementation: Gemini Developer API (Gemma 4 31B by default).
 * The key stays server-side. Local: `npx vercel dev` (loads `.env.local`).
 *
 * JavaScript (not TypeScript): `vercel dev` crashes compiling `.ts` API
 * routes in this Vite app with `Cannot read properties of undefined (reading
 * 'startsWith')`.
 */

import { envInt, loadLocalEnvFallback, todayUtc } from "../lib/env.js";
import {
  applyCors,
  INFERENCE_CLIENT_HEADER,
  originAllowed,
} from "../lib/http.js";

const DEFAULT_MODEL = "gemma-4-31b-it";
const MAX_BODY_BYTES = 100_000;
const MAX_PROMPT_CHARS = 60_000;
const DEFAULT_CLIENT_DAILY = 50;

const clientBuckets = new Map();

loadLocalEnvFallback(["INFERENCE_", "GEMINI_"]);

function apiKey() {
  return (
    process.env.INFERENCE_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    ""
  );
}

function fallbackEnabled() {
  const flag = (
    process.env.INFERENCE_FALLBACK_ENABLED ??
    process.env.GEMINI_FALLBACK_ENABLED ??
    ""
  )
    .trim()
    .toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return Boolean(apiKey());
}

function modelId() {
  return (
    process.env.INFERENCE_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    DEFAULT_MODEL
  );
}

function clientDailyLimit() {
  return envInt(
    "INFERENCE_CLIENT_DAILY_LIMIT",
    envInt("GEMINI_CLIENT_DAILY_LIMIT", DEFAULT_CLIENT_DAILY)
  );
}

function tryConsumeClient(key, limit) {
  const day = todayUtc();
  const cur = clientBuckets.get(key);
  if (!cur || cur.day !== day) {
    clientBuckets.set(key, { day, count: 1 });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count += 1;
  return true;
}

function releaseClient(key) {
  const day = todayUtc();
  const cur = clientBuckets.get(key);
  if (!cur || cur.day !== day || cur.count <= 0) return;
  cur.count -= 1;
}

function toGeminiContents(messages) {
  let system = "";
  const contents = [];

  for (const msg of messages) {
    if (msg == null || typeof msg !== "object") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (msg.role === "system") {
      if (content.trim()) {
        system = system ? `${system}\n\n${content}` : content;
      }
      continue;
    }
    if (!content.trim()) continue;
    const role = msg.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts[0].text += `\n\n${content}`;
    } else {
      contents.push({ role, parts: [{ text: content }] });
    }
  }

  if (contents.length === 0) return null;
  if (contents[0].role !== "user") return null;
  if (contents[contents.length - 1]?.role !== "user") return null;
  return { system: system.trim(), contents };
}

function promptChars(system, contents) {
  let total = system.length;
  for (const content of contents) {
    for (const part of content.parts) total += part.text.length;
  }
  return total;
}

function readBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body == null) return "";
  return JSON.stringify(req.body);
}

function clientToken(req) {
  const header = req.headers[INFERENCE_CLIENT_HEADER.toLowerCase()];
  return typeof header === "string" ? header.trim() : "";
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

  if (req.method === "GET") {
    if (fallbackEnabled()) {
      res.status(200).json({ ok: true });
      return;
    }
    res.status(503).json({
      ok: false,
      error: apiKey() ? "disabled" : "missing_api_key",
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (!fallbackEnabled()) {
    res.status(503).json({
      error: apiKey() ? "disabled" : "missing_api_key",
    });
    return;
  }

  if (!originAllowed(req)) {
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

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const prompt = toGeminiContents(body.messages);
  if (!prompt) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  if (promptChars(prompt.system, prompt.contents) > MAX_PROMPT_CHARS) {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }

  const options = parseInferenceOptions(body.options);
  if (options === null) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const clientId = clientToken(req);
  if (!clientId) {
    res.status(400).json({ error: "missing_client_token" });
    return;
  }

  if (!tryConsumeClient(clientId, clientDailyLimit())) {
    res.status(429).json({ error: "client_limit" });
    return;
  }

  const key = apiKey();
  const model = modelId();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const generationConfig = {};
  const thinkingConfig = thinkingConfigForEffort(
    model,
    options.reasoningEffort
  );
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }

  const geminiBody = {
    contents: prompt.contents,
    tools: [{ googleSearch: {} }],
  };
  if (prompt.system) {
    geminiBody.systemInstruction = {
      parts: [{ text: prompt.system }],
    };
  }
  if (Object.keys(generationConfig).length > 0) {
    geminiBody.generationConfig = generationConfig;
  }

  let geminiRes;
  try {
    geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });
  } catch {
    releaseClient(clientId);
    res.status(502).json({ error: "provider_error" });
    return;
  }

  if (geminiRes.status === 429) {
    releaseClient(clientId);
    let quota = "rate";
    try {
      const errJson = await geminiRes.json();
      quota = classifyGemini429(errJson);
      console.warn("[api/inference] provider 429", {
        kind: quota,
        quotaIds: collectQuotaIds(errJson),
        message: geminiErrorMessage(errJson)?.slice(0, 200),
      });
    } catch {
      console.warn("[api/inference] provider 429", {
        kind: quota,
        unreadable: true,
      });
    }
    res.status(429).json({
      error: quota === "daily" ? "quota_exhausted" : "rate_limited",
    });
    return;
  }

  if (!geminiRes.ok) {
    releaseClient(clientId);
    let providerStatus;
    try {
      const errJson = await geminiRes.json();
      providerStatus = errJson.error?.status;
      console.warn("[api/inference] provider error", {
        http: geminiRes.status,
        status: providerStatus,
        message: errJson.error?.message?.slice(0, 200),
      });
    } catch {
      console.warn("[api/inference] provider error", {
        http: geminiRes.status,
      });
    }
    const status = geminiRes.status >= 500 ? 502 : 400;
    res.status(status).json({
      error: "provider_error",
      http: geminiRes.status,
      ...(providerStatus ? { providerStatus } : {}),
    });
    return;
  }

  let geminiJson;
  try {
    geminiJson = await geminiRes.json();
  } catch {
    releaseClient(clientId);
    res.status(502).json({ error: "provider_error" });
    return;
  }

  const text = extractGeminiText(geminiJson);
  if (!text) {
    releaseClient(clientId);
    res.status(502).json({ error: "provider_error" });
    return;
  }

  res.status(200).json({
    content: withSources(text, extractGroundingSources(geminiJson)),
    model,
  });
}

const REASONING_EFFORTS = new Set(["auto", "none", "low", "medium", "high"]);

function parseInferenceOptions(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const options = {};

  if ("reasoningEffort" in raw && raw.reasoningEffort !== undefined) {
    if (
      typeof raw.reasoningEffort !== "string" ||
      !REASONING_EFFORTS.has(raw.reasoningEffort)
    ) {
      return null;
    }
    options.reasoningEffort = raw.reasoningEffort;
  }

  if ("temperature" in raw && raw.temperature !== undefined) {
    if (
      typeof raw.temperature !== "number" ||
      !Number.isFinite(raw.temperature) ||
      raw.temperature < 0 ||
      raw.temperature > 2
    ) {
      return null;
    }
    options.temperature = raw.temperature;
  }

  return options;
}

/** Map IPA `reasoningEffort` onto Gemini thinking knobs. Omit for auto/absent. */
function thinkingConfigForEffort(model, effort) {
  if (effort == null || effort === "auto") return undefined;
  if (/\b2\.5\b/.test(model)) {
    if (effort === "none") return { thinkingBudget: 0 };
    if (effort === "low") return { thinkingBudget: 1024 };
    if (effort === "medium") return { thinkingBudget: 8192 };
    return { thinkingBudget: -1 };
  }
  if (/^gemma-/i.test(model)) {
    return { thinkingLevel: effort === "none" ? "minimal" : "high" };
  }
  return { thinkingLevel: effort === "none" ? "minimal" : effort };
}

function classifyGemini429(body) {
  const text = collectStrings(body).join(" ");
  if (/PerDay|per_day|per day|RequestsPerDay|_rpd\b/i.test(text)) return "daily";
  return "rate";
}

function collectQuotaIds(value) {
  const ids = [];
  walkObjects(value, (record) => {
    if (typeof record.quotaId === "string" && record.quotaId.trim()) {
      ids.push(record.quotaId);
    }
  });
  return ids;
}

function collectStrings(value) {
  const parts = [];
  const visit = (node) => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(value);
  return parts;
}

function walkObjects(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    visit(value);
    for (const child of Object.values(value)) walkObjects(child, visit);
  }
}

function geminiErrorMessage(value) {
  if (!value || typeof value !== "object") return undefined;
  const error = value.error;
  if (!error || typeof error !== "object") return undefined;
  const message = error.message;
  return typeof message === "string" ? message : undefined;
}

function extractGeminiText(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = data.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const content = candidates[0]?.content;
  if (!content || typeof content !== "object") return null;
  const parts = content.parts;
  if (!Array.isArray(parts)) return null;
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.thought === true) continue;
    if (typeof part.text === "string") chunks.push(part.text);
  }
  const joined = chunks.join("").trim();
  return joined || null;
}

function extractGroundingSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    const uri = typeof web?.uri === "string" ? web.uri.trim() : "";
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const title =
      typeof web.title === "string" && web.title.trim()
        ? web.title.trim()
        : uri;
    sources.push({ title, uri });
  }
  return sources;
}

function withSources(text, sources) {
  if (sources.length === 0) return text;
  if (sources.every((source) => text.includes(source.uri))) return text;
  const lines = sources.map((source) => `- [${source.title}](${source.uri})`);
  return `${text}\n\nSources:\n${lines.join("\n")}`;
}
