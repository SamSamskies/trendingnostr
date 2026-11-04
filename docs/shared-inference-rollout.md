# Shared-only hosted inference

TrendingNostr's hosted Ask AI migration was completed in
[issue #110](https://github.com/SamSamskies/trendingnostr/issues/110) /
[PR #111](https://github.com/SamSamskies/trendingnostr/pull/111).
[Issue #112](https://github.com/SamSamskies/trendingnostr/issues/112) removes the
retained direct-provider route and its rollback toggle. `/api/inference` now
always uses the authenticated shared proxy. Missing configuration and upstream
errors never trigger a direct-provider call.

## Active backend configuration

Verified in both Vercel Production and Preview on November 4, 2026:

```dotenv
SHARED_INFERENCE_PROVIDER=replit
REPLIT_INFERENCE_MODEL=google/gemma-4-26b-a4b-it
SHARED_INFERENCE_URL=https://ipa-inference-fallback-api.vercel.app/api/inference
SHARED_INFERENCE_APP_SECRET=<existing TrendingNostr app secret>
SHARED_INFERENCE_REPLIT_API_KEY=<existing gateway key>
```

Keep the actual secret values in the backend environment, never in this file,
logs, command arguments, or browser variables. The existing shared Ollama/Gemini
keys remain configured for supported provider selection. Their model settings
are `OLLAMA_INFERENCE_MODEL` and `GEMINI_MODEL`; Replit uses only
`REPLIT_INFERENCE_MODEL`. Provider selection is explicit and has no legacy alias.
`INFERENCE_FALLBACK_ENABLED=false` (also `0`/`off`) disables GET and POST before
upstream work. Vercel environment changes require a new deployment to take effect.

The proxy constructs trusted `X-Inference-App: trendingnostr`, bearer app auth,
matching `X-Inference-Provider-Key`, one provider query parameter, and the model
in each POST. Browser authentication headers, top-level credentials/selectors,
Origin, cookies, and Host are not forwarded. The proxy selects only the public `messages`, `webSearch`, and
`options` fields and injects its model. Their contents are validated by the
shared API, keeping message/image/option rules in one place. Requests retain the
100,000-byte UTF-8 limit, 180-second timeout,
200-second function duration, cancellation, sanitized error JSON, and
`Retry-After`. Shared Gemini search remains gated by
`SHARED_INFERENCE_GEMINI_SEARCH_ENABLED=true` after separate live validation.

For local work, use ignored `.env.local` with the same active names. Run the
shared API on port 3001 and this app via `npm run dev:vercel -- --listen 3000`.
An HTTP upstream is allowed only on localhost outside deployed environments.
Vercel exports omit sensitive values: an `env pull` containing blank secrets is
not sufficient to run a live local proxy. Use separately provisioned local
credentials or an authorized protected deployment for that check.

## Independent rollback target

Verified Ready with `vercel inspect` on November 4, 2026:

- Deployment ID: `dpl_9rcKvd5vKQ3k8JDZy67bc1eA6nNt`.
- Immutable URL: `https://trendingnostr-l3vk7akv3-samsamskies-projects.vercel.app`.
- Production alias at verification: `https://trendingnostr.vercel.app`.
- Migration source commit recorded in issue #110:
  `d68c85cb7cdb939a9db0f3d0372da7b065d7986e` (deployment inspection alone did not
  return a source SHA).
- The immutable deployment's `/api/inference` GET returned `{"ok":true}` through
  `vercel curl` with deployment protection preserved. Its captured settings use
  shared Replit; retain this deployment for rollback.

For an authorized rollback, use Vercel's deployment rollback/promotion workflow
to restore this existing TrendingNostr deployment, then check availability,
text, a full-size image, search, and a follow-up. This uses the deployment's
captured environment. Rebuilding old source with today's project environment
is not equivalent to restoring the immutable deployment. Keep its app auth and
provider credentials valid. If a shared-service regression caused the incident,
restore a separately verified shared-service deployment under that project's
release authorization; changing this app alone may not resolve it.

The retired routing toggle cannot restore the direct route in this source.
Do not point rollback at the older pre-migration direct-provider deployment.
Do not change another app or rotate/revoke the shared Replit gateway key.
Merging, deploying, and promoting remain separate release actions.

## Functional validation

The smoke command uses the public proxy and requires no app/provider secrets.
It makes one generation per invocation; `--follow-up` adds a second generation.
Use a protected deployment's existing automation bypass via
`VERCEL_AUTOMATION_BYPASS_SECRET` when necessary, keeping it out of arguments/logs.

```sh
npm run smoke:inference -- --url https://HOST/api/inference --provider replit --checks
npm run smoke:inference -- --url https://HOST/api/inference --provider replit --vision
npm run smoke:inference -- --url https://HOST/api/inference --provider replit \
  --image-url https://IMAGE_HOST/full-size-note.jpg --image-expect VISIBLE_SUBJECT \
  --search --follow-up
```

`--vision` checks a tiny red fixture only. The full-size check downloads the
actual URL, requires over 1 MB and at most 4 MB of image bytes, then sends the
URL through the proxy so the shared service downloads and base64-encodes it.
Choose a visible subject/text from inspecting the image; it is checked in the
answer without being revealed in the prompt. An image description plus a search
citation is a functional check; a citation alone does not prove provider-side
search execution. The gateway's JSON limit is 32 MB; keep a full-size image
check because its base64 representation can exceed the old 1 MB limit.

Automated regression coverage preserves consent/storage keys, client identity,
50-success soft counts, IPA preference, images/search toggles, follow-up context,
reasoning options (including absence), and non-streaming hosted responses.
Confirm tab consent and IPA preference in a real browser when releasing a new
deployment; a Node browser-backend test is not a manual extension/UI check.

The owner's decision in issue #110 accepts development rate-limit validation.
Production WAF/load tests and provider spending verification are not prerequisites
for this cleanup. Existing service authentication, allowlists, and regional
per-app admission remain in place. No production load test is required here.
AdvancedNostrSearch's migration remains independent.

## Cleanup and validation record

The direct route, provider HTTP helpers, in-process quota helpers, direct image
DNS test export, and direct-only tests are removed. Reference checks confirmed
they had no other consumers. The local loader now allows only active shared
settings, supported model settings, and the hosted kill switch.

The obsolete TrendingNostr setting names are `SHARED_INFERENCE_ENABLED`,
`INFERENCE_PROVIDER`, `INFERENCE_MODEL`, `INFERENCE_API_KEY`, `OLLAMA_API_KEY`,
`GEMINI_API_KEY`, `GEMINI_FALLBACK_ENABLED`, `INFERENCE_CLIENT_DAILY_LIMIT`,
`GEMINI_CLIENT_DAILY_LIMIT`, `OLLAMA_REQUESTS_PER_MINUTE`,
`OLLAMA_CLIENT_REQUESTS_PER_MINUTE`, and `OLLAMA_MAX_CONCURRENT`.
Keep supported shared model settings, all active `SHARED_INFERENCE_*` settings,
`OLLAMA_HOST`/`OLLAMA_MODEL` for spam detection, and `TRENDING_WARM_SECRET`.
Removing an unused key copy from this project's environment does not revoke the
provider credential. Do not revoke it without checking other apps, scripts,
and the recorded rollback deployment's dependencies.

Unused `INFERENCE_API_KEY` and `OLLAMA_API_KEY` entries were removed from this
checkout's ignored `.env.local`. No provider credentials were revoked or rotated.
The owner will remove these four existing Vercel settings from Production and
Preview after deploying the shared-only change:

- `SHARED_INFERENCE_ENABLED`
- `INFERENCE_MODEL`
- `INFERENCE_API_KEY`
- `OLLAMA_API_KEY`

The Vercel environment was inspected without changing it. Active shared keys,
app authentication, Replit selection/model, and the warmer secret remain intact.

Validation on November 4, 2026:

- All 51 remaining automated tests and `npm run build` passed. The deleted
  direct-only tests account for the smaller suite; proxy and browser regression
  coverage remains. `git diff --check` and inference-path reference checks passed.
- The existing production shared-Replit deployment passed text generation,
  forged-selector/credential checks, method/origin/input/UTF-8 validation, a
  full-size image with search enabled, and a follow-up with search disabled.
- Image URL:
  `https://image.nostr.build/a9d9d2892a0c1a31800fd9085eb95129326e67d829fc9324fed5646d8254d48a.jpg`.
  Download size: 1,474,129 bytes (1,965,508 base64 bytes before JSON overhead).
  The answer correctly described sliced steak and vegetables and included an
  HTTPS Nostr source link. The final smoke used `--image-expect steak`.
- Browser bundles exclude backend setting names and the locally available
  secret values. Sensitive deployed credentials cannot be compared directly
  because Vercel omits their values from exports; backend imports/configuration
  remain outside the client dependency graph.
- These live requests exercised the existing production deployment, not this
  unmerged cleanup branch. The cleaned handler passed mocked regression tests;
  a live local run could not authenticate using Vercel's blank sensitive exports.
  No manual browser/extension check, deployment, promotion, or production load
  test was performed for this cleanup.

The proxy was further simplified to remove its duplicate message-role, image,
prompt-character, search-value, and option validation. The shared API owns those
rules; the proxy retains JSON/object parsing, incoming/outgoing byte limits,
trusted top-level field selection, and the app's Gemini-search rollout gate.
A local compatibility check passed against the shared API's actual request
normalizer using dummy credentials and no network/provider calls. It verified
service-owned prompt/options validation, search normalization, and ignored
browser credential fields in options. These checks do not replace deployment
validation.
