# Spam classifier eval (Ollama spike)

Labeled fixtures + a local Ollama runner to compare models before wiring anything into the trending cron.

## Run

```bash
# default: qwen3:1.7b
npm run eval:spam

# bake-off
npm run eval:spam -- qwen3:1.7b Osmosis/Osmosis-Structure-0.6B:latest granite4.2:30b
```

Optional env: `OLLAMA_HOST`, `SPAM_CONFIDENCE` (default `0.9`).

The runner sends `think: false` (needed for Qwen3 JSON) and only counts a drop when `spam === true && confidence >= threshold`.

## Labels

- `label: true` — should be dropped from trending
- `label: false` — should stay (includes hard negatives: earnest trading talk)

Fixtures include Craig-style trading funnels, zone_presence payloads, and normal social notes.

## First bake-off (16 fixtures, thr=0.9)

| model | parse | acc | prec | recall | fp | fn | p50 |
|---|---|---|---|---|---|---|---|
| **gemma4:e4b** | 100% | 100% | 100% | 100% | 0 | 0 | ~1.5s |
| gemma4:e4b-mlx | 100% | 93.8% | 100% | 88.9% | 0 | 1 | ~857ms |
| gemma4:e2b-mlx | 100% | 93.8% | 100% | 88.9% | 0 | 1 | ~533ms |
| qwen3:1.7b | 100% | 93.8% | 100% | 88.9% | 0 | 1 | ~400ms |

Production path uses `gemma4:e4b` via `scripts/classify-trending-spam.mjs` (wired into `trending-cron.sh`).
