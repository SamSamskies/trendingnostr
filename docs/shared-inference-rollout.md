# Hosted inference rollout

This change prepares issue [#110](https://github.com/SamSamskies/trendingnostr/issues/110).
Shared routing defaults **off**. Merging the code alone retains the direct path.
Deploying/promoting a release and changing public traffic require their own
authorization under the repository's working agreements.

## Baseline recorded November 4, 2026

- Pre-migration checkout and verified `origin/main`:
  `47cf77939fd54cea98b61f4082396bde7bec9d63`.
- Production alias: `https://trendingnostr.vercel.app`.
- Vercel production deployment observed with `vercel inspect`:
  `dpl_GepKkK5ZxDkucVYc9Z4t2mT7KbgX`, Ready, created November 2, 2026.
- Independent deployment rollback target:
  `https://trendingnostr-mz8ugr6z0-samsamskies-projects.vercel.app`.
  The inspection confirmed the deployed URL/ID, not its source SHA.
- Shared service: `https://ipa-inference-fallback-api.vercel.app/api/inference`.
- Existing direct-provider keys/model settings must remain available. Do not
  revoke an Ollama key still used by spam detection.

The issue records staged Production/Preview shared credentials. This change
does not read, print, modify, or rotate those staged secrets.

## Protected preview validation

1. Verify the linked project is `samsamskies-projects/trendingnostr`. Record the
   new commit, preview deployment URL/ID, provider/model, and test time. Use a
   protected preview; preserve existing deployment protection.
2. Scope `SHARED_INFERENCE_ENABLED=true` to the test preview. Set the staged
   shared URL, matching app secret, and selected provider's shared key. Keep
   `INFERENCE_PROVIDER=ollama` and `OLLAMA_INFERENCE_MODEL=gemma4:cloud` for the
   initial rollout. Never paste secrets into a PR, log, command argument, or
   browser variable. The proxy fixes `X-Inference-App: trendingnostr`, injects
   bearer/provider credentials and model, and sends one provider selector.
3. GET `/api/inference`: expect shared availability JSON. POST a small text
   conversation with `webSearch:false`, then test a note image, search enabled,
   search disabled, and a follow-up. Confirm requested reasoning/temperature
   options survive; an absent reasoning option must remain absent. Confirm one
   final browser response with no stream/deltas from hosted generation.
4. In the browser, verify IPA handles requests when available; without IPA,
   hosted generation requires tab consent. Verify the existing keys
   `trendingnostr.inferenceConsent` (session storage),
   `trendingnostr.inferenceClient` and `trendingnostr.inferenceSoftCount` (local
   storage). Failed requests must not increment the soft count. Stop a request
   and confirm the proxy's outbound fetch is cancelled. Cancellation at the
   proxy does not guarantee work already admitted by the shared service stops.
5. Send forged Authorization/app/provider-key headers and body/query provider
   and model selectors to the proxy. They must not change upstream identity,
   key, provider, or model. Reject malformed prompts/options/images, an invalid
   client token, non-GET/POST methods (apart from OPTIONS), disallowed origins,
   and bodies over 100,000 UTF-8 bytes. Do not capture complete outbound headers
   or bodies in logs to prove these checks.
6. Check provider authentication/model failures with dummy credentials in the
   protected preview. Confirm 429 `rate_limited`, 503 `rate_limit_unavailable`,
   and `Retry-After` propagate without automatic retries. Use the shared
   service's controlled validation procedure for missing-rule failures; do not
   disable its production rule to test an app. Check no credential echoes occur
   in browser responses, bundles, or platform logs.
7. Exercise POST admission while changing browser UUIDs (and backend provider
   selections in separate controlled previews). The shared app bucket must
   remain effective. Test both app buckets using the service runbook; do not
   load-test paid models. GET availability does not exercise admission or
   provider credentials.
8. Test the same preview with `SHARED_INFERENCE_ENABLED=false` and redeploy.
   Confirm the direct model works using retained direct credentials. Restore
   the preview to shared routing only after that rollback check succeeds.

The smoke command makes **one real generation per invocation** against the
selected proxy and uses provider quota. It needs no app/provider credentials:

```sh
npm run smoke:inference -- --url https://PREVIEW_HOST/api/inference --checks
npm run smoke:inference -- --url https://PREVIEW_HOST/api/inference --vision
npm run smoke:inference -- --url https://PREVIEW_HOST/api/inference --search
```

For a protected preview, set `VERCEL_AUTOMATION_BYPASS_SECRET` in the caller's
environment, never in a command argument. The proxy does not forward that header
to the shared API. Repeat against the production alias after authorization and
promotion. Inspect provider evidence for real vision/search execution; a JSON
answer or a citation alone does not establish either capability.

Gemini search requires separate live validation for the selected model before
setting `SHARED_INFERENCE_GEMINI_SEARCH_ENABLED=true`. Replit is deliberately
rejected by this app until a later change adds app-specific live validation and
backend-owned model configuration. No optional public discovery/selector UI is
included in this migration.

## Public proxy and spending controls before promotion

In the **TrendingNostr** project's Firewall, add a dedicated enforcing rate
limit matching path `/api/inference` and method `POST`, counting by client **IP**.
A starting test threshold is 5 requests per 60 seconds, using a fixed window
and a 429 action; validate shared-IP households/mobile networks and adjust to
the intended traffic/budget. Record the actual rule ID, published version,
window/threshold, and owner in the operator's private runbook. Preserve unrelated
rules. Use the staged review/publish workflow when using the Vercel CLI.

Test the rule with dummy provider credentials and rotated browser UUIDs in a
controlled preview. Confirm excess requests are blocked before function/provider
work, actual status/retry behavior, and normal traffic still works. Platform WAF
responses may differ from the service's JSON: verify the browser handles them.
An IP rule is separate from the shared service's regional 10/app/60s admission;
neither is an exact global daily quota or a spending cap.

For the selected provider, verify account/project ownership, available models,
quota/balance, billing alerts, automatic replenishment, and an explicit shutdown
threshold. Record remaining exposure if a hard cap is unavailable. Separate
API keys can still share a billing account. See the shared service's
[production controls](https://github.com/SamSamskies/ipa-inference-fallback-api/blob/main/docs/production-controls.md)
and [validation record](https://github.com/SamSamskies/ipa-inference-fallback-api/blob/main/docs/deployment-validation.md).

## Promotion, observation, and independent rollback

After the preview, firewall, and spending checks, enable the switch for the
authorized TrendingNostr production release. Record its deployment ID/URL and
commit, then repeat generation, images, search, admission/errors, and browser
consent/IPA checks against the production alias. Monitor latency, error rates,
admission failures, and provider usage/cost over an agreed observation period.
AdvancedNostrSearch follows independently after this path has been observed.

To roll back, set `SHARED_INFERENCE_ENABLED=false` for TrendingNostr and redeploy,
or roll back the linked TrendingNostr project to the recorded pre-migration
deployment. Verify retained credentials are still valid and check text, images,
search, and errors. Leave other apps and the shared deployment unchanged.
Never silently fall back to the direct route on an upstream error: that could
bypass shared admission or duplicate a paid generation.

Only after observation and rollback retirement should a separate cleanup remove
`lib/direct-inference.js`, unused inference settings, and obsolete keys. Inspect
spam detection and other consumers before revocation.

## Validation status for this change

Automated coverage includes trusted injection, forged selectors/headers,
backend defaults/precedence, GET auth, methods/origins, UTF-8 incoming/outgoing
body limits, image/follow-up/options forwarding, Gemini-search/Replit gates,
service/provider errors, 429/503 retry headers, credential redaction,
timeout/disconnect cancellation, direct rollback, consent/storage/soft counts,
and IPA preference. All 76 tests and the production build passed. A local
`vercel dev` instance on port 3000 also passed GET/generation, forged
headers/selectors, inline images, search on/off, reasoning, and UTF-8 limits
against the shared service's actual auth/normalization/Ollama adapter on port
3001. Provider HTTP responses were mocked with dummy credentials, so this made
no paid provider calls. The release smoke command passed against that fixture.

Preview/production provider checks, published public-proxy WAF controls,
provider-console spending verification, promotion, and observation remain
release work. Mocked tests cannot establish those deployed guarantees.
