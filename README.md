# Trending Nostr

A simple read-only feed of trending Nostr notes.

Each note has **Ask AI**. If an [Inference Provider API](https://github.com/SamSamskies/inference-provider-api) extension such as [Inference Bridge](https://chromewebstore.google.com/detail/inference-bridge/ekjldffogogadhfhgkibgkfdhhikfamd) is installed, the model runs in the extension (and can search the web when that helps). Otherwise the app can use a hosted fallback at `/api/inference` after you agree.

Ask AI defaults to your browser’s preferred language. Follow-up questions use their own language, and explicit language requests take priority. The note’s language does not set the response language. This applies to both the extension and hosted inference paths.

## Installation

```sh
npm ci
npm start
```

Open the local URL Vite prints (usually http://localhost:5173). Vite alone does not serve `/api`. Hosted Ask AI looks unavailable until you run the API locally or deploy.

## Hosted inference (local)

1. Copy `.env.example` to `.env.local` and set `OLLAMA_API_KEY` for the default Ollama.com backup provider.
2. Never prefix the key with `VITE_` (that would ship it to the browser).
3. Run the Vite app and `/api/inference` together:

```sh
npm ci
npm run dev:vercel
```

`vercel dev` loads `.env.local`, serves `/api/inference`, and proxies the Vite app. Use the URL it prints (often http://localhost:3000, or :3001 if 3000 is busy)—plain `npm start` on :5173 does not serve `/api`.

Switch hosted providers with `INFERENCE_PROVIDER=ollama` (default) or `INFERENCE_PROVIDER=gemini`. Gemini uses `GEMINI_API_KEY`; the existing `INFERENCE_API_KEY` is still accepted for Gemini only and is never sent to Ollama. Both implementations remain available at `/api/inference`.

Keep separate `OLLAMA_INFERENCE_MODEL` and `GEMINI_MODEL` settings so switching providers does not reuse the wrong model. Defaults are `gemma4:cloud` for Ollama and `gemma-4-31b-it` for Gemini. The Ollama alias maps to `gemma4:31b` for the [direct cloud API](https://docs.ollama.com/cloud). `INFERENCE_MODEL` remains a legacy override when `INFERENCE_PROVIDER` is explicitly set and that provider's model setting is absent.

`OLLAMA_MODEL` configures the local `detect-spam` script only; hosted Ask AI ignores it.

Both providers support images, web search, temperature, and reasoning options. Ollama executes requested searches through its [web search API](https://docs.ollama.com/capabilities/web-search), with at most two searches and three chat calls per explanation. Image fetching and provider calls share a 50-second timeout. The browser's web search setting applies to both providers.

Ollama has additional limits: 5 explanation attempts per browser per minute, 20 upstream calls per minute (including failed attempts, searches, and chat continuations), and 2 concurrent explanations. HTTP 429 responses trigger a cooldown and preserve `Retry-After`. These limits are in memory **per server process**, so Vercel instances do not share them; they are best-effort protection, not an account-wide spending cap. Configure them with `OLLAMA_CLIENT_REQUESTS_PER_MINUTE`, `OLLAMA_REQUESTS_PER_MINUTE`, and `OLLAMA_MAX_CONCURRENT`.

Other optional env (see `.env.example`): `INFERENCE_FALLBACK_ENABLED`, `INFERENCE_CLIENT_DAILY_LIMIT` (default 50 successful explanations per browser per day). Failed provider requests release the daily allowance, while Ollama's minute limits still count attempts.

IPA stays preferred. Hosted inference only runs after IPA is unavailable and you agree. Consent is stored in `sessionStorage` for the tab session.

## Build

```sh
npm ci
npm run build
```

Static output lands in `dist/`. For Vercel: build command `npm run build`, output directory `dist`. Set `INFERENCE_PROVIDER` and the corresponding API key in the Vercel project env.

The public endpoint is `/api/inference`. Provider selection is server-side; one provider handles each hosted request. Cross-provider failover or routing between both providers can be added later without changing the browser contract.

## Cached trending feed

`/api/trending?hours=48` builds the ranked feed on the server and caches it in two places:

1. **Vercel Runtime Cache** (per region) — shared across `Accept-Encoding` variants. Cron refreshes this so a CDN miss still returns the prebuilt JSON in milliseconds (`X-Trending-Cache: runtime`).
2. **CDN** (`s-maxage=300`) plus browser `max-age=60` — faster when the encoding matches, but Vercel keys CDN entries by `Accept-Encoding`, so bare `curl` and Chrome (`br`/`zstd`) are different keys.

The Mac Mini cron rebuilds Runtime Cache via a distinct URL key (`&_warm=1` + `x-trending-refresh`; `Pragma: no-cache` does not bypass a fresh CDN HIT), then warms the public CDN entry. A first visit will still show a network `200` (CDN may be `MISS` or `HIT`); look at `X-Trending-Cache` and Time, not “from disk cache”. The browser prefers this blob and falls back to the legacy client-side path if the API is down.

Candidate notes still come from the trending relay / nostr.wine. During the
server build, zap totals for those existing candidates are supplemented from
[zap.observer](https://zap.observer/) when its validated rollups report a
higher amount; zap.observer never contributes new candidate notes.

### Detect spam in a trending window

Scan a cached feed and print [Jumble](https://jumble.social) links for notes that look like spam (confidence ≥ 0.9 by default). Defaults to a local [Ollama decision model](https://docs.ollama.com/capabilities/decision) (`clef-flash`); pass `--classifier` to use [classifier.dev](https://classifier.dev/) instead:

```sh
npm run detect-spam
npm run detect-spam -- 12
npm run detect-spam -- 24 --min-confidence 0.85
npm run detect-spam -- --json
npm run detect-spam -- --model nimble
npm run detect-spam -- --model clef --cached
npm run detect-spam -- --classifier
```

Compare decision models on the labeled fixture (`scripts/fixtures/spam-eval.jsonl`):

```sh
npm run detect-spam:eval
npm run detect-spam:eval -- --model nimble
npm run detect-spam:eval -- --models nimble,clef
npm run detect-spam:eval -- --models nimble,clef --json
npm run detect-spam:eval -- --classifier
```

Hours are optional (`4`, `12`, `24`, or `48`; default `4`). Summary lines go to stderr; Jumble URLs go to stdout (pipe-friendly). Defaults to production (`https://trendingnostr.vercel.app`); override with `TRENDING_BASE_URL` / `TRENDING_CRON_BASE_URL` or `--base-url`. Ollama host defaults to `http://localhost:11434` (`OLLAMA_HOST` / `--ollama-host`).

### Mac Mini cache warmer

Keep the production CDN warm from a Mac that stays awake:

```sh
npm run cron:prod:run     # warm once
npm run cron:prod:start   # launchd every 5 minutes (re-run after script changes)
npm run cron:prod:start -- --interval 75m   # custom StartInterval (also -i 4500)
npm run cron:status
npm run cron:logs         # last 50 lines
npm run cron:logs -- -f
npm run cron:stats
npm run cron:stop
```

`--interval` / `-i` accepts seconds (`4500`), minutes (`75m`), or hours (`1h`). It overrides `TRENDING_CRON_INTERVAL_SEC` and is written into the launchd plist. Re-run `cron:prod:start` (with the flag) after changing the interval or the script.

**Hobby Runtime Cache quota:** each warm that changes the feed does a `runtimeCache.set` per hours window. Vercel bills those as **write units** (8 KB chunks), not as the operation counts shown under Observability → Runtime Cache. Cached note payloads omit `sig` (unused in the UI; tags are kept). Unchanged rebuilds skip `set` so stable windows do not rewrite the blob (TTL is not refreshed on skip). On Hobby the included allotment is small (~200k write units / rolling 30 days); warming `4,12,24,48` every 5 minutes can still burn through it when the feed moves often. Prefer a longer `--interval` (and raise `RUNTIME_TTL_SEC` / CDN `s-maxage` if the interval exceeds the current TTLs), fewer `TRENDING_CRON_HOURS`, or stop the cron when idle. Usage emails are the main quota signal on Hobby; `vercel usage` 404s without a Pro billing cycle.

Optional: set the same `TRENDING_WARM_SECRET` in Vercel project env and on the Mac Mini so only your cron can force a rebuild (`x-trending-refresh`).

For a preview or other host: `TRENDING_CRON_BASE_URL=https://… npm run cron:run` (and `cron:start -- --interval 75m`).

Logs: `~/Library/Logs/trendingnostr/warm.jsonl`. Optional: `TRENDING_CRON_HOURS`, `TRENDING_CRON_INTERVAL_SEC` (default interval; overridden by `--interval` on start).

Protected **preview** deploys return `401 Protected Deployment`. Either:

1. Open the preview in a browser while logged into Vercel (cookie auth), or
2. Set a [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) secret and pass it to the warmer:

```sh
export TRENDING_CRON_BYPASS_SECRET="your-bypass-secret"
npm run cron:run
```

Or use the CLI (uses your Vercel login): `npx vercel curl "$BASE/api/trending?hours=48"`.

Production is usually unprotected; the Mac Mini cron does not need a bypass there.
