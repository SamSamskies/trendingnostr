# Trending Nostr

A simple read-only feed of trending Nostr notes.

If an [Inference Provider API](https://github.com/SamSamskies/inference-provider-api) extension such as [Inference Bridge](https://chromewebstore.google.com/detail/inference-bridge/ekjldffogogadhfhgkibgkfdhhikfamd) is installed, each note shows **Ask AI**. The model can explain a note or check whether its claims hold up, and will search the web when that helps (via Inference Bridge's experimental `web_search`).

## Installation

```sh
npm ci
npm start
```

Open the local URL Vite prints (usually http://localhost:5173).
