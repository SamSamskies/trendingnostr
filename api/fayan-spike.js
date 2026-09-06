/**
 * TEMP SPIKE — delete after measuring Cloudflare behavior from Vercel IPs.
 *
 * GET /api/fayan-spike
 * Hits Fayan `POST /users` with several User-Agents and reports status /
 * content-type / body shape so we can see which (if any) bypass CF challenges.
 */

const FAYAN_USERS_URL = "https://fayan.jumble.social/users";
/** fiatjaf — known present in Fayan rankings. */
const SAMPLE_PUBKEY =
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const FETCH_TIMEOUT_MS = 12_000;
const BODY_PREVIEW_CHARS = 240;

const USER_AGENTS = [
  { id: "none", headers: {} },
  { id: "trendingnostr", headers: { "User-Agent": "trendingnostr-fayan-spike/1.0" } },
  { id: "oai-searchbot", headers: { "User-Agent": "oai-searchbot" } },
  { id: "chatgpt-user", headers: { "User-Agent": "chatgpt-user" } },
  { id: "gptbot", headers: { "User-Agent": "gptbot" } },
];

function looksLikeCloudflareChallenge(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("just a moment") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("challenge-platform") ||
    lower.includes("attention required") ||
    (lower.includes("cloudflare") && lower.includes("<!doctype html"))
  );
}

function looksLikeFayanUserJson(text) {
  try {
    const data = JSON.parse(text);
    const entry = data?.[SAMPLE_PUBKEY];
    return (
      entry != null &&
      typeof entry === "object" &&
      typeof entry.percentile === "number"
    );
  } catch {
    return false;
  }
}

/**
 * @param {{ id: string, headers: Record<string, string> }} attempt
 */
async function probeBatchPost(attempt) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(FAYAN_USERS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...attempt.headers,
      },
      body: JSON.stringify({ pubkeys: [SAMPLE_PUBKEY] }),
    });

    const contentType = res.headers.get("content-type") || "";
    const cfRay = res.headers.get("cf-ray") || null;
    const server = res.headers.get("server") || null;
    const text = await res.text();
    const preview =
      text.length > BODY_PREVIEW_CHARS
        ? `${text.slice(0, BODY_PREVIEW_CHARS)}…`
        : text;

    return {
      id: attempt.id,
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      contentType,
      server,
      cfRay,
      cloudflareChallenge: looksLikeCloudflareChallenge(text),
      fayanJson: looksLikeFayanUserJson(text),
      bodyPreview: preview,
    };
  } catch (error) {
    return {
      id: attempt.id,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      contentType: null,
      server: null,
      cfRay: null,
      cloudflareChallenge: false,
      fayanJson: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const attempts = await Promise.all(USER_AGENTS.map(probeBatchPost));
  const anySuccess = attempts.some((a) => a.fayanJson);

  res.status(200).json({
    spike: "fayan-cloudflare-ua",
    note: "TEMP — remove api/fayan-spike.js after measuring",
    target: FAYAN_USERS_URL,
    method: "POST",
    samplePubkey: SAMPLE_PUBKEY,
    runtime: {
      vercel: Boolean(process.env.VERCEL),
      env: process.env.VERCEL_ENV || null,
      region: process.env.VERCEL_REGION || null,
    },
    anyFayanJson: anySuccess,
    attempts,
  });
}
