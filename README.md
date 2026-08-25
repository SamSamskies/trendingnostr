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
