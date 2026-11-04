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

## Hosted inference

`/api/inference` is an authenticated proxy to
[ipa-inference-fallback-api](https://github.com/SamSamskies/ipa-inference-fallback-api).
Production uses shared Replit with `google/gemma-4-26b-a4b-it`. Hosted requests
require an explicit `SHARED_INFERENCE_PROVIDER`, `SHARED_INFERENCE_URL`,
`SHARED_INFERENCE_APP_SECRET`, and the matching provider key. Missing or invalid
configuration fails closed. The proxy supplies the app identity, provider,
model, and credentials; browser selectors and credentials cannot override them.

Copy `.env.example` to ignored `.env.local` for local development. Never prefix
backend settings with `VITE_`. Run the app and its API together:

```sh
npm run dev:vercel -- --listen 3000
```

Use the URL Vercel prints. Plain `npm start` serves only the Vite app. To develop
against a local shared API, run that service separately on port **3001**, set
`SHARED_INFERENCE_URL=http://127.0.0.1:3001/api/inference`, and use a matching local
app secret. HTTP upstream URLs are allowed only for localhost outside deployed
Preview/Production environments. The backend env loader reads only active,
explicitly allowed settings; `.vercelignore` excludes env files from uploads.

Shared provider settings remain independent:

| `SHARED_INFERENCE_PROVIDER` | Backend key | Model setting (default) |
| --- | --- | --- |
| `replit` | `SHARED_INFERENCE_REPLIT_API_KEY` | `REPLIT_INFERENCE_MODEL` (`google/gemma-4-26b-a4b-it`) |
| `ollama` | `SHARED_INFERENCE_OLLAMA_API_KEY` | `OLLAMA_INFERENCE_MODEL` (`gemma4:cloud`) |
| `gemini` | `SHARED_INFERENCE_GEMINI_API_KEY` | `GEMINI_MODEL` (`gemma-4-31b-it`) |

Replit text, vision, and search have passed live functional checks. Gemini
text/vision can use shared routing with search off; Gemini search is rejected
unless `SHARED_INFERENCE_GEMINI_SEARCH_ENABLED=true` is set after validating the
selected model. `OLLAMA_HOST` and `OLLAMA_MODEL` configure local spam detection
only and do not affect hosted Ask AI.

IPA stays preferred. Hosted inference requires consent stored in
`sessionStorage` for the tab. The existing client UUID, 50-success daily browser
soft count, image/search toggles, follow-ups, reasoning options, and final
non-streaming JSON responses are preserved. The shared service owns provider
limits and per-app admission; its regional limits are not an exact global daily
quota or spending cap.

The shared API validates messages, images, options, and model capabilities. The
proxy forwards only the allowed top-level payload fields with its server-selected
model and enforces a 100,000-byte UTF-8 request limit and a 180-second timeout,
within the 200-second Vercel function duration. Disconnecting cancels the
outbound request. Status/error JSON and `Retry-After` pass through without
proxy retries or direct-provider fallback. Set `INFERENCE_FALLBACK_ENABLED=false`
(or `0`/`off`) to disable hosted inference. Vercel backend setting changes take
effect on a new deployment; this does not require a new browser contract.

Check hosted inference with the smoke script:

```sh
npm run smoke:inference -- --url https://HOST/api/inference --provider replit --checks
npm run smoke:inference -- --url https://HOST/api/inference --provider replit \
  --image-url https://IMAGE_HOST/full-size-note.jpg --image-expect VISIBLE_SUBJECT \
  --search --follow-up
```

The full-size image check requires an image over 1 MB and at most 4 MB, plus a
visible subject or text to check in the answer. Each command makes one real
generation; `--follow-up` adds another. For rollback, restore a known working
shared-service deployment through Vercel's deployment history.

## Build

```sh
npm ci
npm run build
```

Static output lands in `dist/`. For Vercel: build command `npm run build`, output directory `dist`. Set the shared-service backend settings above in the Vercel project env.

The public endpoint is `/api/inference`. Provider selection is server-side; one provider handles each hosted request. The proxy does not retry with another provider on errors.

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
