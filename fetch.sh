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
#   3. GETs system-prompt.md (baked, role + HTML schema) and topics.txt
#      (user-editable, what to search for) from app storage, then
#      composes them into a combined system prompt
#   4. Runs the chosen CLI against the prompt with web search
#   5. The agent saves the HTML report itself; if it didn't, a stub
#      `<article>` placeholder is written so the UI shows *something*
#      for today instead of yesterday's report
#   6. Report lands at reports/YYYY-MM-DD.html (Content-Type: text/html)
#   7. Logs to /data/cron-logs/news.log
#   8. Sends a push notification on success
#
# Schedule (schedule.json) shape:
#   {"hour": <0-23>, "minute": <0-59>,
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

# 1. Pull the baked system prompt (role + HTML schema, NOT user-editable)
#    and the user-editable topics text, then compose them into one
#    system prompt file passed to the CLI.
SYSTEM_FILE="$WORK_DIR/system-prompt.md"
SYS_CODE=$(curl -sS -o "$SYSTEM_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/system-prompt.md") || SYS_CODE=000

if [ "$SYS_CODE" != "200" ]; then
  log "ERROR: failed to fetch system-prompt.md (HTTP $SYS_CODE)"
  exit 1
fi

TOPICS_FILE="$WORK_DIR/topics.txt"
TOPICS_CODE=$(curl -sS -o "$TOPICS_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/topics.txt") || TOPICS_CODE=000

if [ "$TOPICS_CODE" != "200" ]; then
  log "ERROR: failed to fetch topics.txt (HTTP $TOPICS_CODE)"
  exit 1
fi

# Compose: baked system prompt + topics section appended at runtime.
PROMPT_FILE="$WORK_DIR/prompt.md"
{
  cat "$SYSTEM_FILE"
  printf '\n\n## Topics to cover\n\n'
  cat "$TOPICS_FILE"
} > "$PROMPT_FILE"

# 2. Resolve the chosen provider + model.
#
# agent.json shape (owner-written via the Settings tab):
#   {"provider": "claude"|"codex", "model": "<model-id>"}
#
# Backwards compat:
#   - Missing file or missing/unknown "provider" → "claude".
#   - Missing "model" → empty MODEL → CLI uses its default (no
#     --model flag appended). This keeps pre-1.3 installs working
#     until the owner opens Settings once.
#
# The model id is passed through verbatim to the chosen CLI's
# --model flag; we deliberately do NOT validate it against a static
# allowlist so a future model id added in the shell's picker keeps
# working here without a fetch.sh edit. If the CLI rejects the id,
# the failure surfaces in /data/cron-logs/news.log and the stub
# salvage path takes over.
AGENT_FILE="$WORK_DIR/agent.json"
AGENT_CODE=$(curl -sS -o "$AGENT_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/agent.json") || AGENT_CODE=000
PROVIDER="claude"
MODEL=""
if [ "$AGENT_CODE" = "200" ]; then
  # Emit "provider<TAB>model" on one line for easy shell-side split.
  AGENT_PARSED=$(python3 -c "
import json
try:
    obj = json.load(open('$AGENT_FILE'))
    p = obj.get('provider', 'claude')
    if p not in ('claude', 'codex'):
        p = 'claude'
    m = obj.get('model', '')
    if not isinstance(m, str):
        m = ''
    print(p + '\t' + m)
except Exception:
    print('claude\t')
")
  PROVIDER="${AGENT_PARSED%%$'\t'*}"
  MODEL="${AGENT_PARSED#*$'\t'}"
fi
if [ -n "$MODEL" ]; then
  log "Using provider: $PROVIDER, model: $MODEL"
else
  log "Using provider: $PROVIDER (no model override, CLI default)"
fi

# 3. Run the chosen CLI.
#
# Strategy: tell the agent the API endpoint + token and let it PUT the
# HTML report itself via Bash/curl. Telling it to save the file directly
# gives it room to: search → assemble → curl in separate tool calls.
# Output to stdout is then optional, just there so the salvage path
# below can at least write a stub on failure.
RAW_OUTPUT="$WORK_DIR/agent.out"
REPORT_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.html"
USER_TURN="Today is $TODAY. Search the web for today's major news, write the integrated HTML narrative per the schema in the system prompt, and SAVE IT YOURSELF by PUTting the HTML body to: $REPORT_URL — use bash + curl with header 'Authorization: Bearer $SERVICE_TOKEN' and 'Content-Type: text/html; charset=utf-8'. The body must be the raw HTML fragment starting with <article class=\"news-report\" ...> (no JSON wrapping, no markdown fences). Reply with 'done' once saved."

if [ "$PROVIDER" = "claude" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    log "ERROR: provider=claude but claude CLI not installed"
    exit 1
  fi
  log "Invoking claude CLI"
  # Build the flag array; --model is appended only when MODEL is
  # non-empty so omitting it falls back to the CLI's default.
  CLAUDE_FLAGS=(
    --system-prompt-file "$PROMPT_FILE"
    --allowedTools "Bash(command)" "WebSearch"
    --permission-mode bypassPermissions
    --max-turns 30
  )
  if [ -n "$MODEL" ]; then
    CLAUDE_FLAGS+=(--model "$MODEL")
  fi
  CLAUDE_CONFIG_DIR=/data/cli-auth/claude claude -p "$USER_TURN" \
    "${CLAUDE_FLAGS[@]}" \
    > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  CLI_EXIT=$?
else
  if ! command -v codex >/dev/null 2>&1; then
    log "ERROR: provider=codex but codex CLI not installed"
    exit 1
  fi
  log "Invoking codex CLI"
  PROMPT_BODY=$(cat "$PROMPT_FILE")
  # codex exec accepts --model <MODEL> (also -m). Append only when
  # set; otherwise codex uses the default from ~/.codex/config.toml.
  CODEX_FLAGS=(exec --json)
  if [ -n "$MODEL" ]; then
    CODEX_FLAGS+=(--model "$MODEL")
  fi
  CODEX_FLAGS+=(-)
  printf '%s\n\n---\n\n%s\n' "$PROMPT_BODY" "$USER_TURN" \
    | codex "${CODEX_FLAGS[@]}" > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  CLI_EXIT=$?
fi

if [ "$CLI_EXIT" -ne 0 ]; then
  log "ERROR: agent exited with code $CLI_EXIT"
fi

# 4. The agent should have PUT the report itself. Confirm by GETting it
#    back. If present, we're done. If not, write a stub article so the
#    UI shows a "could not be generated" message for today instead of
#    yesterday's report.
CHECK_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$REPORT_URL") || CHECK_CODE=000

if [ "$CHECK_CODE" = "200" ]; then
  log "Digest saved by agent (GET $TODAY.html: $CHECK_CODE)"
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

log "Agent did not save report (GET $TODAY.html: $CHECK_CODE). Writing stub..."

# 5. Salvage path: write a stub <article> placeholder so the date shows
#    up in the UI's dropdown with an honest "could not be generated"
#    message. No JSON-parse heuristics — there's no JSON to parse now.
STUB_FILE="$WORK_DIR/stub.html"
cat > "$STUB_FILE" <<HTML
<article class="news-report" data-date="$TODAY">
  <details class="news-report__summary" open>
    <summary>Today at a glance</summary>
    <p>Today's digest could not be generated. The news curator did not return a report — check <code>/data/cron-logs/news.log</code> for details.</p>
  </details>
  <section class="news-report__body">
    <p>No stories available for $TODAY. The next scheduled run will try again.</p>
  </section>
</article>
HTML

# 6. PUT the stub. Only fires if the agent didn't save.
PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X PUT "$REPORT_URL" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: text/html; charset=utf-8" \
  --data-binary @"$STUB_FILE") || PUT_CODE=000

if [ "$PUT_CODE" != "200" ] && [ "$PUT_CODE" != "201" ] && [ "$PUT_CODE" != "204" ]; then
  log "ERROR: failed to save stub report (HTTP $PUT_CODE)"
  exit 1
fi

log "Stub saved (HTTP $PUT_CODE)"

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
