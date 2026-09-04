# Trending Nostr

A simple read-only feed of trending Nostr notes.

Each note has **Ask AI**. If an [Inference Provider API](https://github.com/SamSamskies/inference-provider-api) extension such as [Inference Bridge](https://chromewebstore.google.com/detail/inference-bridge/ekjldffogogadhfhgkibgkfdhhikfamd) is installed, the model runs in the extension (and can search the web when that helps). Otherwise the app can use a hosted fallback at `/api/inference` after you agree.

## Installation

```sh
npm ci
npm start
```

Open the local URL Vite prints (usually http://localhost:5173). Vite alone does not serve `/api`. Hosted Ask AI looks unavailable until you run the API locally or deploy.

## Hosted inference (local)

1. Copy `.env.example` to `.env.local` and set `INFERENCE_API_KEY` (a Gemini AI Studio key for the current provider).
2. Never prefix the key with `VITE_` (that would ship it to the browser).
3. Run the Vite app and `/api/inference` together:

```sh
npm ci
npm run dev:vercel
```

`vercel dev` loads `.env.local`, serves `/api/inference`, and proxies the Vite app. Use the URL it prints (often http://localhost:3000, or :3001 if 3000 is busy)—plain `npm start` on :5173 does not serve `/api`.

Optional env (see `.env.example`): `INFERENCE_MODEL` (default `gemma-4-31b-it`), `INFERENCE_FALLBACK_ENABLED`, `INFERENCE_CLIENT_DAILY_LIMIT`.

IPA stays preferred. Hosted inference only runs after IPA is unavailable and you agree. Consent is stored in `sessionStorage` for the tab session.

## Build

```sh
npm ci
npm run build
```

Static output lands in `dist/`. For Vercel: build command `npm run build`, output directory `dist`. Set `INFERENCE_API_KEY` in the Vercel project env.

The public endpoint is `/api/inference`. The current implementation calls Gemini with Gemma 4 31B; swap the body of `api/inference.ts` to change providers without renaming the route or client.

## Cached trending feed

`/api/trending?hours=48` builds the ranked feed on the server and caches it in two places:

1. **Vercel Runtime Cache** (per region) — shared across `Accept-Encoding` variants. Cron refreshes this so a CDN miss still returns the prebuilt JSON in milliseconds (`X-Trending-Cache: runtime`).
2. **CDN** (`s-maxage=300`) plus browser `max-age=60` — faster when the encoding matches, but Vercel keys CDN entries by `Accept-Encoding`, so bare `curl` and Chrome (`br`/`zstd`) are different keys.

The Mac Mini cron rebuilds Runtime Cache via a distinct URL key (`&_warm=1` + `x-trending-refresh`; `Pragma: no-cache` does not bypass a fresh CDN HIT), then warms the public CDN entry. A first visit will still show a network `200` (CDN may be `MISS` or `HIT`); look at `X-Trending-Cache` and Time, not “from disk cache”. The browser prefers this blob and falls back to the legacy client-side path if the API is down.

After each successful warm, the same cron (optional, `SPAM_CLASSIFY=1` by default) classifies **new** notes with local Ollama (`gemma4:e4b`, `think: false`), POSTs spam event ids to `/api/spam-verdicts`, and re-warms if anything was added. Fail-open if Ollama is down.

### Mac Mini cache warmer

Keep the production CDN warm from a Mac that stays awake:

```sh
npm run cron:prod:run     # warm once (+ classify if Ollama is up)
npm run cron:prod:start   # launchd every 5 minutes (re-run after script changes)
npm run cron:status
npm run cron:logs         # last 50 lines
npm run cron:logs -- -f
npm run cron:stats
npm run cron:stop
```

Optional: set the same `TRENDING_WARM_SECRET` in Vercel project env and on the Mac Mini so only your cron can force a rebuild (`x-trending-refresh`). Not required for `/api/spam-verdicts`.

Clear bad LLM flags: `npm run spam:unflag:all` (no secret). Then `npm run cron:prod:run` if you want a rewarm.

Spam classify knobs (Mac Mini): `SPAM_CLASSIFY=0` to skip, `SPAM_OLLAMA_MODEL`, `OLLAMA_HOST`, `SPAM_CONFIDENCE`, `SPAM_CLASSIFY_MAX`. Eval harness: `npm run eval:spam`.

For a preview or other host: `TRENDING_CRON_BASE_URL=https://… npm run cron:run` (and `cron:start`).

Logs: `~/Library/Logs/trendingnostr/warm.jsonl` (+ `spam-classified.json` for local id cache). Optional: `TRENDING_CRON_HOURS`, `TRENDING_CRON_INTERVAL_SEC`.

Protected **preview** deploys return `401 Protected Deployment`. Either:

1. Open the preview in a browser while logged into Vercel (cookie auth), or
2. Set a [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) secret and pass it to the warmer:

```sh
export TRENDING_CRON_BYPASS_SECRET="your-bypass-secret"
npm run cron:run
```

Or use the CLI (uses your Vercel login): `npx vercel curl "$BASE/api/trending?hours=48"`.

Production is usually unprotected; the Mac Mini cron does not need a bypass there.
