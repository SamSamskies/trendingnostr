---
name: run-spam-classify
description: >-
  Manually run one Ollama spam-classify pass for trendingnostr (gemma4:e4b),
  optionally rewarm the feed, and summarize new spam. Use when the user asks
  to classify spam, run spam classify, scan trending for spam, or run the
  Ollama spam filter once — not for enabling the cron auto-classify loop.
---

# Run spam classify (manual)

One-shot Mac Mini classify. Cron defaults to warm-only (`SPAM_CLASSIFY=0`).

## Steps

1. Confirm repo root is `trendingnostr` and Ollama is up (`ollama list` or `curl -s http://127.0.0.1:11434/api/tags`).
2. Run classify (needs network; allow several minutes — often 2–8+ min for up to 80 new notes):

```bash
TRENDING_CRON_BASE_URL=https://trendingnostr.vercel.app \
  npm run classify:spam
```

3. Parse the JSON line on stdout:
   - `ok: false` → report `error`; do not rewarm unless user asks.
   - `rewarm: true` / `spamFound` > 0 → rewarm:

```bash
TRENDING_CRON_BASE_URL=https://trendingnostr.vercel.app \
  npm run cron:prod:run
```

4. Show spam review links:

```bash
npm run spam:local
```

## Notes

- Model default: `gemma4:e4b` (`SPAM_OLLAMA_MODEL`). Script already sends `think: false`.
- Drops only after corroboration (Telegram/VIP/`zone_presence`/etc.); many model “spam” labels never post.
- Clear bad flags: `npm run spam:unflag:all` (no warm secret).
- Do **not** set `SPAM_CLASSIFY=1` on launchd unless the user explicitly wants auto-classify every tick.
