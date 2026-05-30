#!/bin/bash
# Möbius app-news cron job. Installed by app-store; do not edit by hand —
# edit the Settings tab in the app instead.
#
# Usage: fetch.sh <APP_ID>
#   APP_ID — numeric id of the installed news app (passed by the cron
#   wrapper that the installer registers in init-cron-scaffold.sh).
#
# What it does:
#   1. Loads the service token from /data/service-token.txt
#   2. Reads agent.json (user's chosen provider: "claude" or "codex")
#   3. GETs the user's prompt.md from app storage
#   4. Runs the chosen CLI against the prompt with web search
#   5. Parses the agent's stdout — expects JSON; falls back to a stub
#      report if parsing fails
#   6. PUTs the result to reports/YYYY-MM-DD.json
#   7. Logs to /data/cron-logs/news.log
#   8. Sends a push notification on success
#
# Schedule (schedule.json) shape:
#   {"hour": <0-23>, "minute": <0-59>, "categories": [...],
#    "timezone": "Europe/London"|null}
#   When `timezone` is set, sync-cron.sh converts local→UTC before
#   writing the crontab entry (handling DST via zoneinfo). When null,
#   hour/minute are interpreted as UTC (backwards-compat).

set -uo pipefail

APP_ID="${1:-}"
if [ -z "$APP_ID" ]; then
  echo "fetch.sh: APP_ID required as first argument" >&2
  exit 2
fi

API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"
SERVICE_TOKEN=$(cat /data/service-token.txt)
TODAY=$(date -u +%Y-%m-%d)
NOW=$(date -u +%H:%M:%S)
LOG_DIR=/data/cron-logs
LOG_FILE="$LOG_DIR/news.log"
WORK_DIR=$(mktemp -d -t app-news.XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$LOG_DIR"

log() {
  echo "[$TODAY $(date -u +%H:%M:%S)] $*" >> "$LOG_FILE"
}

log "Starting digest fetch for app_id=$APP_ID"

# 1. Pull the user's prompt
PROMPT_FILE="$WORK_DIR/prompt.md"
HTTP_CODE=$(curl -sS -o "$PROMPT_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/prompt.md") || HTTP_CODE=000

if [ "$HTTP_CODE" != "200" ]; then
  log "ERROR: failed to fetch prompt.md (HTTP $HTTP_CODE)"
  exit 1
fi

# 2. Resolve the chosen provider (defaults to "claude" for backwards-compat).
#    agent.json is owner-written via the Settings tab; missing file or
#    missing field falls through to "claude".
AGENT_FILE="$WORK_DIR/agent.json"
AGENT_CODE=$(curl -sS -o "$AGENT_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/agent.json") || AGENT_CODE=000
PROVIDER="claude"
if [ "$AGENT_CODE" = "200" ]; then
  PROVIDER=$(python3 -c "
import json, sys
try:
    obj = json.load(open('$AGENT_FILE'))
    p = obj.get('provider', 'claude')
    if p in ('claude', 'codex'):
        print(p)
    else:
        print('claude')
except Exception:
    print('claude')
")
fi
log "Using provider: $PROVIDER"

# 3. Run the chosen CLI.
#
# Strategy: tell the agent the API endpoint + token and let it PUT the
# report itself via Bash/curl. The "agent returns JSON, fetch.sh parses"
# variant we tried first kept hitting `claude -p ... --allowedTools` exit-1
# under the new pin — the agent couldn't web-search AND emit clean JSON
# under the same turn. Telling it to save the file directly (the prod
# news-app's original pattern) gives it room to: search → assemble → curl
# in separate tool calls. Output to stdout is then optional, just there
# so the JSON-parse fallback below can still salvage a stub on failure.
RAW_OUTPUT="$WORK_DIR/agent.out"
REPORT_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.json"
USER_TURN="Today is $TODAY. Search the web for today's major news, build the digest per the schema in the system prompt, and SAVE IT YOURSELF by PUTting the JSON body to: $REPORT_URL — use bash + curl with header 'Authorization: Bearer $SERVICE_TOKEN' and 'Content-Type: application/json'. The body must be the raw JSON object (no wrapping). Reply with 'done' once saved."

if [ "$PROVIDER" = "claude" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    log "ERROR: provider=claude but claude CLI not installed"
    exit 1
  fi
  log "Invoking claude CLI"
  CLAUDE_CONFIG_DIR=/data/cli-auth/claude claude -p "$USER_TURN" \
    --system-prompt-file "$PROMPT_FILE" \
    --allowedTools "Bash(command)" "WebSearch" \
    --permission-mode bypassPermissions \
    --max-turns 30 \
    > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  CLI_EXIT=$?
else
  if ! command -v codex >/dev/null 2>&1; then
    log "ERROR: provider=codex but codex CLI not installed"
    exit 1
  fi
  log "Invoking codex CLI"
  PROMPT_BODY=$(cat "$PROMPT_FILE")
  printf '%s\n\n---\n\n%s\n' "$PROMPT_BODY" "$USER_TURN" \
    | codex exec --json - > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  CLI_EXIT=$?
fi

if [ "$CLI_EXIT" -ne 0 ]; then
  log "ERROR: agent exited with code $CLI_EXIT"
fi

# 4. The agent should have PUT the report itself. Confirm by GETting it
#    back. If present, we're done. If not, fall through to the JSON-parse
#    salvage path so a stub at least lands instead of leaving the previous
#    day's report.
CHECK_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$REPORT_URL") || CHECK_CODE=000

if [ "$CHECK_CODE" = "200" ]; then
  log "Digest saved by agent (GET $TODAY.json: $CHECK_CODE)"
  curl -sS -X POST "$API_BASE_URL/api/notifications/send" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"title\": \"News digest ready\",
      \"body\": \"Your daily news digest for $TODAY is ready.\",
      \"source_type\": \"app\",
      \"source_id\": \"$APP_ID\",
      \"target\": \"/app/$APP_ID\",
      \"actions\": [
        {\"action\": \"open_app\", \"title\": \"Read\", \"target\": \"/app/$APP_ID\"}
      ]
    }" >> "$LOG_FILE" 2>&1
  log "Done."
  exit 0
fi

log "Agent did not save report (GET $TODAY.json: $CHECK_CODE). Trying salvage parse from agent stdout..."

# 5. Salvage path: parse JSON from the agent's stdout. Only fires when
#    the agent didn't save the report itself.
REPORT_JSON="$WORK_DIR/report.json"
python3 - "$RAW_OUTPUT" "$REPORT_JSON" "$TODAY" <<'PY' 2>>"$LOG_FILE"
import json, re, sys, pathlib

raw_path, out_path, today = sys.argv[1], sys.argv[2], sys.argv[3]
raw = pathlib.Path(raw_path).read_text(errors="replace") if pathlib.Path(raw_path).exists() else ""

def try_parse(s):
    try:
        return json.loads(s)
    except Exception:
        return None

obj = try_parse(raw.strip())

# Strip code fences if present
if obj is None:
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if m:
        obj = try_parse(m.group(1))

# Last resort: greedy outer-brace match
if obj is None:
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        obj = try_parse(raw[start:end + 1])

if obj is None or not isinstance(obj, dict):
    obj = {
        "date": today,
        "summary": "Today's digest could not be generated — the news curator returned no parseable output. Check /data/cron-logs/news.log for details.",
        "sections": [],
    }

# Ensure date is set
obj.setdefault("date", today)
obj.setdefault("summary", "")
obj.setdefault("sections", [])

pathlib.Path(out_path).write_text(json.dumps(obj))
PY

# 6. PUT the salvaged stub report. Only fires if the agent didn't save.
PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X PUT "$REPORT_URL" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @"$REPORT_JSON") || PUT_CODE=000

if [ "$PUT_CODE" != "200" ] && [ "$PUT_CODE" != "201" ] && [ "$PUT_CODE" != "204" ]; then
  log "ERROR: failed to save salvage report (HTTP $PUT_CODE)"
  exit 1
fi

log "Salvage stub saved (HTTP $PUT_CODE)"

# 7. Notify
curl -sS -X POST "$API_BASE_URL/api/notifications/send" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"News digest ready\",
    \"body\": \"Your daily news digest for $TODAY is ready.\",
    \"source_type\": \"app\",
    \"source_id\": \"$APP_ID\",
    \"target\": \"/app/$APP_ID\",
    \"actions\": [
      {\"action\": \"open_app\", \"title\": \"Read\", \"target\": \"/app/$APP_ID\"}
    ]
  }" >> "$LOG_FILE" 2>&1

log "Done."
