#!/usr/bin/env bash
# Mac Mini helper: refresh Runtime Cache + warm CDN for /api/trending every N minutes.
#
# Usage:
#   export TRENDING_CRON_BASE_URL="https://your-app.vercel.app"
#   ./scripts/trending-cron.sh start    # install + load launchd (every 5 min)
#   ./scripts/trending-cron.sh stop     # unload launchd
#   ./scripts/trending-cron.sh status   # launchd + last run
#   ./scripts/trending-cron.sh logs     # last 50 log lines
#   ./scripts/trending-cron.sh logs -f  # follow log
#   ./scripts/trending-cron.sh stats    # success/fail summary
#   ./scripts/trending-cron.sh run      # warm once (now)
#
# Optional env:
#   TRENDING_CRON_HOURS=4,12,24,48
#   TRENDING_CRON_INTERVAL_SEC=300
#   TRENDING_CRON_LOG_DIR=~/Library/Logs/trendingnostr
#   TRENDING_CRON_TIMEOUT_SEC=90
#   TRENDING_CRON_BYPASS_SECRET=...  # Vercel "Protection Bypass for Automation"
#                                   # (needed for protected preview deploys)
#   TRENDING_WARM_SECRET=...        # must match Vercel env if set; forces rebuild
#                                   # into Runtime Cache (cron uses ?_warm=1 so
#                                   # CDN cannot serve a fresh HIT instead)
#   SPAM_CLASSIFY=1                 # opt-in: local Ollama classify after warm (default off)
#   SPAM_OLLAMA_MODEL=gemma4:e4b
#   OLLAMA_HOST=http://127.0.0.1:11434
#   SPAM_CONFIDENCE=0.9
#   SPAM_CLASSIFY_MAX=80

set -euo pipefail

LABEL="com.trendingnostr.warm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$SCRIPT_DIR/trending-cron.sh"

DEFAULT_HOURS="4,12,24,48"
DEFAULT_INTERVAL=300
DEFAULT_TIMEOUT=90
DEFAULT_LOG_DIR="${HOME}/Library/Logs/trendingnostr"

HOURS="${TRENDING_CRON_HOURS:-$DEFAULT_HOURS}"
INTERVAL_SEC="${TRENDING_CRON_INTERVAL_SEC:-$DEFAULT_INTERVAL}"
TIMEOUT_SEC="${TRENDING_CRON_TIMEOUT_SEC:-$DEFAULT_TIMEOUT}"
LOG_DIR="${TRENDING_CRON_LOG_DIR:-$DEFAULT_LOG_DIR}"
# Preview deploys with Vercel Authentication need this header.
BYPASS_SECRET="${TRENDING_CRON_BYPASS_SECRET:-${VERCEL_AUTOMATION_BYPASS_SECRET:-}}"
WARM_SECRET="${TRENDING_WARM_SECRET:-1}"
# Match Chrome so the CDN entry cron writes is the one browsers request.
# (Vercel keys CDN responses by Accept-Encoding; bare curl ≠ br/zstd.)
BROWSER_ACCEPT_ENCODING="gzip, deflate, br, zstd"
LOG_FILE="$LOG_DIR/warm.jsonl"
STATE_FILE="$LOG_DIR/state.env"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
# Local Ollama spam classify after warm (opt-in; prefer `npm run classify:spam`).
SPAM_CLASSIFY="${SPAM_CLASSIFY:-0}"
SPAM_OLLAMA_MODEL="${SPAM_OLLAMA_MODEL:-gemma4:e4b}"
CLASSIFY_SCRIPT="$SCRIPT_DIR/classify-trending-spam.mjs"

# launchd uses a minimal PATH; include node managers (volta/fnm/nvm) + current node dir.
CRON_PATH_PREFIX=""
if command -v node >/dev/null 2>&1; then
  CRON_PATH_PREFIX="$(cd "$(dirname "$(command -v node)")" && pwd):"
fi
CRON_PATH="${CRON_PATH_PREFIX}${HOME}/.volta/bin:${HOME}/.local/share/fnm/current/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# Prefer this PATH for node/curl when launchd (or a thin env) invoked us.
export PATH="${CRON_PATH}:${PATH}"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

require_base_url() {
  if [[ -z "${TRENDING_CRON_BASE_URL:-}" ]]; then
    echo "error: set TRENDING_CRON_BASE_URL (e.g. https://your-app.vercel.app)" >&2
    exit 1
  fi
  TRENDING_CRON_BASE_URL="${TRENDING_CRON_BASE_URL%/}"
}

ensure_log_dir() {
  mkdir -p "$LOG_DIR"
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

write_state() {
  ensure_log_dir
  cat >"$STATE_FILE" <<EOF
LAST_RUN_AT=$(iso_now)
LAST_OK=$1
LAST_DURATION_MS=$2
LAST_NOTES_TOTAL=$3
LAST_ERROR=$4
EOF
}

append_log() {
  ensure_log_dir
  printf '%s\n' "$1" >>"$LOG_FILE"
}

# Warm one hours window; prints one JSON line to stdout.
#
# Pragma/Cache-Control: no-cache does NOT bypass a fresh Vercel CDN HIT
# (s-maxage still valid). Use a distinct URL key (+ refresh header) so the
# function always runs and rebuilds Runtime Cache, then hit the public URL
# to populate the browser CDN entry from that cache.
warm_one() {
  local hours="$1"
  local public_url="${TRENDING_CRON_BASE_URL}/api/trending?hours=${hours}"
  # Distinct cache key from the public URL — not a cache-bust timestamp.
  local refresh_url="${public_url}&_warm=1"
  local body_file http_file hdr_file
  body_file="$(mktemp)"
  http_file="$(mktemp)"
  hdr_file="$(mktemp)"

  local start_ms end_ms
  start_ms="$(node -e 'process.stdout.write(String(Date.now()))')"

  # Do NOT use curl --compressed: macOS libcurl cannot decode br/zstd, and
  # exit 56 ("Unrecognized content encoding") after a 200. Keep the browser
  # Accept-Encoding header for the CDN key; decompress the body in Node.
  local curl_base=(
    -sS
    --max-time "$TIMEOUT_SEC"
    -H "Accept: application/json"
    -H "Accept-Encoding: ${BROWSER_ACCEPT_ENCODING}"
    -H "User-Agent: trendingnostr-cron/1.0"
  )
  if [[ -n "$BYPASS_SECRET" ]]; then
    curl_base+=(-H "x-vercel-protection-bypass: ${BYPASS_SECRET}")
  fi

  set +e
  # 1) Force origin: rebuild into Runtime Cache (handler responds no-store).
  curl "${curl_base[@]}" \
    -D "$hdr_file" -o "$body_file" -w "%{http_code}" \
    -H "x-trending-refresh: ${WARM_SECRET}" \
    "$refresh_url" >"$http_file"
  local curl_ec=$?
  set -e

  end_ms="$(node -e 'process.stdout.write(String(Date.now()))')"

  local line
  line="$(
    HOURS_VAL="$hours" \
    URL_VAL="$refresh_url" \
    HTTP_VAL="$(cat "$http_file" 2>/dev/null || echo 0)" \
    CURL_EC="$curl_ec" \
    START_MS="$start_ms" \
    END_MS="$end_ms" \
    BODY_FILE="$body_file" \
    HDR_FILE="$hdr_file" \
    node <<'NODE'
const fs = require("fs");
const zlib = require("zlib");

function contentEncoding(hdrPath) {
  try {
    const raw = fs.readFileSync(hdrPath, "utf8");
    const match = raw.match(/^content-encoding:\s*(.+)\s*$/im);
    return match ? match[1].trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

function decodeBody(buf, encoding) {
  const enc = (encoding || "").split(",")[0].trim();
  if (!enc || enc === "identity") return buf;
  if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf);
  if (enc === "deflate") {
    try {
      return zlib.inflateSync(buf);
    } catch {
      return zlib.inflateRawSync(buf);
    }
  }
  if (enc === "br") return zlib.brotliDecompressSync(buf);
  if (enc === "zstd" && typeof zlib.zstdDecompressSync === "function") {
    return zlib.zstdDecompressSync(buf);
  }
  throw new Error(`unsupported_encoding:${enc}`);
}

const hours = Number(process.env.HOURS_VAL);
const url = process.env.URL_VAL;
const httpStatus = Number(process.env.HTTP_VAL) || 0;
const curlEc = Number(process.env.CURL_EC) || 0;
const durationMs = Math.max(
  0,
  (Number(process.env.END_MS) || 0) - (Number(process.env.START_MS) || 0)
);
let ok = false;
let noteCount = 0;
let source = "";
let buildMs = null;
let error = "";

if (curlEc !== 0) {
  error = `curl_exit_${curlEc}`;
} else if (httpStatus !== 200) {
  const body = fs.readFileSync(process.env.BODY_FILE).toString("utf8").slice(0, 400);
  error = `http_${httpStatus}:${body.replace(/\s+/g, " ")}`;
} else {
  try {
    const encoding = contentEncoding(process.env.HDR_FILE);
    const raw = decodeBody(fs.readFileSync(process.env.BODY_FILE), encoding);
    const data = JSON.parse(raw.toString("utf8"));
    ok = true;
    noteCount = Array.isArray(data.notes) ? data.notes.length : 0;
    source = typeof data.source === "string" ? data.source : "";
    buildMs = Number.isFinite(data.durationMs) ? data.durationMs : null;
  } catch (e) {
    error = `json_parse:${e.message}`;
  }
}

process.stdout.write(
  JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    hours,
    ok,
    httpStatus,
    durationMs,
    noteCount,
    source,
    buildMs,
    error,
    url,
  })
);
NODE
  )"

  rm -f "$body_file" "$http_file" "$hdr_file"

  # 2) Best-effort: warm the public CDN key from Runtime Cache (fast).
  local refresh_ok
  refresh_ok="$(printf '%s' "$line" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        process.stdout.write(JSON.parse(s).ok ? "1" : "0");
      } catch {
        process.stdout.write("0");
      }
    });
  ')"
  if [[ "$refresh_ok" == "1" ]]; then
    set +e
    curl "${curl_base[@]}" -o /dev/null "$public_url" >/dev/null 2>&1 || true
    set -e
  fi

  printf '%s\n' "$line"
}

# Classify new trending notes via local Ollama; prints one JSON line.
# Always exits 0 from Node (fail-open); this wrapper returns 0 unless node missing.
classify_spam() {
  if [[ ! -f "$CLASSIFY_SCRIPT" ]]; then
    printf '%s\n' "{\"ok\":false,\"error\":\"missing_classify_script\"}"
    return 0
  fi
  set +e
  SPAM_OLLAMA_MODEL="$SPAM_OLLAMA_MODEL" \
  TRENDING_CRON_BASE_URL="$TRENDING_CRON_BASE_URL" \
  TRENDING_WARM_SECRET="$WARM_SECRET" \
  TRENDING_CRON_BYPASS_SECRET="$BYPASS_SECRET" \
  TRENDING_CRON_LOG_DIR="$LOG_DIR" \
  node "$CLASSIFY_SCRIPT"
  set -e
  return 0
}

warm_all_hours() {
  WARM_ALL_OK=true
  WARM_NOTES_TOTAL=0
  WARM_LAST_ERR=""

  local hours
  for hours in ${HOURS//,/ }; do
    hours="$(echo "$hours" | tr -d '[:space:]')"
    [[ -z "$hours" ]] && continue
    local line
    line="$(warm_one "$hours")"
    append_log "$line"
    echo "$line"

    local parsed
    parsed="$(printf '%s' "$line" | node -e '
      let s="";
      process.stdin.on("data", d => s += d);
      process.stdin.on("end", () => {
        const j = JSON.parse(s);
        process.stdout.write([j.ok ? "1" : "0", String(j.noteCount || 0), j.error || ""].join("\t"));
      });
    ')"
    local ok_flag note_count err_text
    IFS=$'\t' read -r ok_flag note_count err_text <<<"$parsed"
    WARM_NOTES_TOTAL=$((WARM_NOTES_TOTAL + note_count))
    if [[ "$ok_flag" != "1" ]]; then
      WARM_ALL_OK=false
      WARM_LAST_ERR="$err_text"
    fi
  done
}

cmd_run() {
  require_base_url
  ensure_log_dir

  local started
  started="$(date +%s)"

  warm_all_hours

  # After a successful warm, classify new notes and re-warm if spam was posted.
  if [[ "$WARM_ALL_OK" == "true" && "$SPAM_CLASSIFY" != "0" && "$SPAM_CLASSIFY" != "false" ]]; then
    local classify_line rewarm
    classify_line="$(classify_spam)"
    echo "$classify_line"
    append_log "$classify_line"
    rewarm="$(printf '%s' "$classify_line" | node -e '
      let s="";
      process.stdin.on("data", d => s += d);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(s.trim());
          process.stdout.write(j.rewarm ? "1" : "0");
        } catch {
          process.stdout.write("0");
        }
      });
    ')"
    if [[ "$rewarm" == "1" ]]; then
      local rewarm_line
      rewarm_line="{\"ts\":\"$(iso_now)\",\"phase\":\"rewarm_after_spam\",\"ok\":true}"
      echo "$rewarm_line"
      append_log "$rewarm_line"
      warm_all_hours
    fi
  fi

  local now duration_ms
  now="$(date +%s)"
  duration_ms=$(( (now - started) * 1000 ))
  write_state "$WARM_ALL_OK" "$duration_ms" "$WARM_NOTES_TOTAL" "$WARM_LAST_ERR"

  if [[ "$WARM_ALL_OK" != "true" ]]; then
    exit 1
  fi
}

write_plist() {
  require_base_url
  ensure_log_dir

  local launch_out="$LOG_DIR/launchd.out.log"
  local launch_err="$LOG_DIR/launchd.err.log"

  cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${CLI}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>StartInterval</key>
  <integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TRENDING_CRON_BASE_URL</key>
    <string>${TRENDING_CRON_BASE_URL}</string>
    <key>TRENDING_CRON_HOURS</key>
    <string>${HOURS}</string>
    <key>TRENDING_CRON_TIMEOUT_SEC</key>
    <string>${TIMEOUT_SEC}</string>
    <key>TRENDING_CRON_LOG_DIR</key>
    <string>${LOG_DIR}</string>
    <key>TRENDING_CRON_BYPASS_SECRET</key>
    <string>${BYPASS_SECRET}</string>
    <key>TRENDING_WARM_SECRET</key>
    <string>${WARM_SECRET}</string>
    <key>SPAM_CLASSIFY</key>
    <string>${SPAM_CLASSIFY}</string>
    <key>SPAM_OLLAMA_MODEL</key>
    <string>${SPAM_OLLAMA_MODEL}</string>
    <key>OLLAMA_HOST</key>
    <string>${OLLAMA_HOST:-http://127.0.0.1:11434}</string>
    <key>PATH</key>
    <string>${CRON_PATH}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${launch_out}</string>
  <key>StandardErrorPath</key>
  <string>${launch_err}</string>
</dict>
</plist>
EOF
  echo "wrote $PLIST_PATH"
}

cmd_start() {
  require_base_url
  write_plist
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  echo "started ${LABEL} (every ${INTERVAL_SEC}s) → ${TRENDING_CRON_BASE_URL}"
  echo "logs: $LOG_FILE"
  echo "try:  $CLI status | logs | logs -f | stats"
}

cmd_stop() {
  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/${LABEL}"
    echo "stopped ${LABEL}"
  else
    echo "${LABEL} is not loaded"
  fi
  if [[ -f "$PLIST_PATH" ]]; then
    rm -f "$PLIST_PATH"
    echo "removed $PLIST_PATH"
  fi
}

cmd_status() {
  echo "label:    $LABEL"
  echo "plist:    $PLIST_PATH"
  echo "log:      $LOG_FILE"
  echo "base url: ${TRENDING_CRON_BASE_URL:-"(not set in this shell)"}"
  echo "hours:    $HOURS"
  echo "interval: ${INTERVAL_SEC}s"
  echo

  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    echo "launchd:  loaded"
    launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | grep -E 'state =|runs =|last exit code =' || true
  else
    echo "launchd:  not loaded"
  fi

  if [[ -f "$STATE_FILE" ]]; then
    echo
    echo "last run:"
    sed 's/^/  /' "$STATE_FILE"
  else
    echo
    echo "last run: (none yet)"
  fi
}

cmd_logs() {
  ensure_log_dir
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "no log yet at $LOG_FILE"
    exit 0
  fi

  local follow=false
  local lines=50
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--follow) follow=true; shift ;;
      -n) lines="$2"; shift 2 ;;
      [0-9]*) lines="$1"; shift ;;
      *) shift ;;
    esac
  done

  if [[ "$follow" == "true" ]]; then
    echo "# following $LOG_FILE (Ctrl-C to stop)"
    tail -n "$lines" -F "$LOG_FILE"
  else
    tail -n "$lines" "$LOG_FILE"
  fi
}

cmd_stats() {
  ensure_log_dir
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "no log yet at $LOG_FILE"
    exit 0
  fi

  # argv[1] is "-" when reading the script from stdin; path is argv[2].
  node - "$LOG_FILE" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
if (!path || path === "-") {
  console.error("stats: missing log path");
  process.exit(1);
}
const lines = fs.readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
let ok = 0, fail = 0;
const byHours = new Map();
let last = null;
const durations = [];
for (const line of lines) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  last = row;
  const h = String(row.hours ?? "?");
  const bucket = byHours.get(h) || { ok: 0, fail: 0, notes: 0 };
  if (row.ok) { ok++; bucket.ok++; }
  else { fail++; bucket.fail++; }
  bucket.notes += Number(row.noteCount) || 0;
  byHours.set(h, bucket);
  if (Number.isFinite(row.durationMs)) durations.push(row.durationMs);
}
durations.sort((a, b) => a - b);
const pct = (p) => durations.length
  ? durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))]
  : null;
console.log(`log:      ${path}`);
console.log(`runs:     ${lines.length} lines (${ok} ok, ${fail} fail)`);
console.log(`p50 ms:   ${pct(50) ?? "n/a"}`);
console.log(`p95 ms:   ${pct(95) ?? "n/a"}`);
console.log("by hours:");
for (const [h, b] of [...byHours.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${h}h  ok=${b.ok} fail=${b.fail} notes_sum=${b.notes}`);
}
if (last) {
  console.log("last:");
  console.log(
    `  ${last.ts} hours=${last.hours} ok=${last.ok} http=${last.httpStatus} notes=${last.noteCount} ${last.durationMs}ms source=${last.source || ""} ${last.error || ""}`
  );
}
NODE
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    start) shift; cmd_start "$@" ;;
    stop) shift; cmd_stop "$@" ;;
    status) shift; cmd_status "$@" ;;
    logs) shift; cmd_logs "$@" ;;
    stats) shift; cmd_stats "$@" ;;
    run) shift; cmd_run "$@" ;;
    -h|--help|help) usage 0 ;;
    *) usage 1 ;;
  esac
}

main "$@"
