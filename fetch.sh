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
#   3. GETs system-prompt.md (baked, role + JSON schema) and topics.txt
#      (user-editable, what to search for) from app storage, then
#      composes them into a combined system prompt
#   4. Runs the chosen CLI with WebSearch as the only allowed tool —
#      the agent has no Bash, no Write, no WebFetch. Its only output
#      channel is stdout (the final assistant message).
#   5. Parses the agent's stdout for the JSON report object and PUTs it
#      to reports/YYYY-MM-DD.json ourselves, as a BARE object (no
#      {"content":...} envelope — .json storage paths store the bare
#      object verbatim). The service token is NEVER in the agent's
#      prompt — fetch.sh holds it and does the PUT, so a prompt-
#      injection in a poisoned search result has no token to
#      exfiltrate and no Bash to run.
#   6. If the agent's output didn't contain a parseable JSON object,
#      a stub placeholder is written so the UI shows *something* for
#      today instead of yesterday's report.
#   7. Report lands at reports/YYYY-MM-DD.json (Content-Type: application/json)
#   8. Logs to /data/cron-logs/news.log
#   9. Sends a push notification on success
#
# Schedule: this job's cron entry is fixed at install time from the
# manifest's `schedule.default` ("0 10 * * *", i.e. 10:00 UTC daily).
# It does NOT read schedule.json — no platform reconciler re-syncs the
# crontab from a saved time, so there's nothing here to honor one. To
# change the fire time, edit the cron entry (the app's Settings tab
# tells the owner to ask the agent to do exactly that).

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

# 1. Pull the baked system prompt (role + JSON schema, NOT user-editable)
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

# 3. Run the chosen CLI with NO network or disk write tools.
#
# Security model — what closed the prompt-injection vector:
#   - Token is NOT in the agent's context. fetch.sh holds it and does
#     the PUT itself (step 6).
#   - Allowed tools are WebSearch only. The agent has no Bash, no
#     Write, no WebFetch — no channel to make outbound HTTP calls,
#     no channel to write to disk. Even a perfectly-tuned prompt-
#     injection in a search result has no way to exfiltrate: the
#     only output channel the agent has is its final assistant
#     message (stdout), which we extract the JSON report object from.
#   - We drop --permission-mode bypassPermissions: with WebSearch as
#     the only allowed tool, there's nothing left for the permission
#     prompt to gate.
#
# The output channel is stdout. Claude's `-p` returns the final
# assistant message text verbatim. Codex's `exec --json` emits an
# `agent_message` event with the final text. Both shapes are parsed
# the same way: extract the first balanced JSON object.
RAW_OUTPUT="$WORK_DIR/agent.out"
REPORT_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.json"
USER_TURN="Today is $TODAY. Search the web for today's major news, then reply with the JSON report object and nothing else — no prose, no markdown, no code fences. Start with { and end with }. Set \"date\" to $TODAY."

if [ "$PROVIDER" = "claude" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    log "ERROR: provider=claude but claude CLI not installed"
    exit 1
  fi
  log "Invoking claude CLI"
  # WebSearch-only — no Bash, no Write, no WebFetch. The agent has
  # no path to write to disk or hit any network endpoint other than
  # the (read-only) web-search API the tool wraps.
  # --model is appended only when MODEL is non-empty so omitting it
  # falls back to the CLI's default.
  CLAUDE_FLAGS=(
    --system-prompt-file "$PROMPT_FILE"
    --allowedTools "WebSearch"
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
  # NOTE: Codex's tool surface is configured in ~/.codex/config.toml
  # at the system level — we can't tighten it per-invocation the way
  # Claude lets us. The token still isn't in the prompt so the worst
  # a poisoned search could do is execute a shell command under the
  # mobius user with no bearer to exfiltrate. Acceptable until Codex
  # gains per-invocation tool gating; tracked as a residual risk on
  # ticket 068 (Codex path remains the looser one).
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

# 4. Extract the JSON report object from the agent's output.
#    - Claude -p: stdout is the final assistant message text verbatim.
#    - Codex exec --json: stdout is JSONL; the final `agent_message`
#      event carries the text. python3 grabs the last `agent_message`
#      payload, or falls back to the raw bytes if parsing fails.
#    The agent is told to reply with bare JSON, but we tolerate a
#    ```json fence or surrounding prose by scanning for the first
#    balanced {...} object. We then normalize it to the schema the
#    UI renders — coercing types, dropping non-string source_urls and
#    URLs that aren't http(s), and requiring a top-level summary +
#    at least one article. The normalized object is written to
#    EXTRACTED_FILE as a BARE JSON object (no {"content":...} wrapper)
#    so the .json storage path stores it verbatim.
EXTRACTED_FILE="$WORK_DIR/extracted.json"
python3 - "$RAW_OUTPUT" "$EXTRACTED_FILE" "$PROVIDER" "$TODAY" <<'PY' 2>>"$LOG_FILE"
import json
import sys

raw_path, out_path, provider, today = sys.argv[1:5]
with open(raw_path, "r", encoding="utf-8", errors="replace") as f:
    raw = f.read()

text = raw
if provider == "codex":
  # Last `agent_message` event holds the final text. Fall back to raw
  # if no parseable lines (older codex shapes, mid-stream truncation).
  last = ""
  for line in raw.splitlines():
    line = line.strip()
    if not line:
      continue
    try:
      obj = json.loads(line)
    except json.JSONDecodeError:
      continue
    # Codex shape: {"type": "agent_message", "message": "..."} OR
    # {"msg": {"type": "agent_message", "message": "..."}}.
    msg = obj.get("msg", obj)
    if isinstance(msg, dict) and msg.get("type") == "agent_message":
      m = msg.get("message", "")
      if isinstance(m, str):
        last = m
  if last:
    text = last


def first_json_object(s):
  """Return the first balanced top-level {...} substring, or None.

  Scans for an opening brace, then walks forward tracking brace depth
  while respecting JSON string literals (so a `}` inside a string
  doesn't close the object early). Lets us pull the report object out
  even if the model wrapped it in a ```json fence or stray prose.
  """
  start = s.find("{")
  while start != -1:
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
      c = s[i]
      if in_str:
        if esc:
          esc = False
        elif c == "\\":
          esc = True
        elif c == '"':
          in_str = False
        continue
      if c == '"':
        in_str = True
      elif c == "{":
        depth += 1
      elif c == "}":
        depth -= 1
        if depth == 0:
          return s[start:i + 1]
    start = s.find("{", start + 1)
  return None


def is_http_url(v):
  return isinstance(v, str) and (v.startswith("http://") or v.startswith("https://"))


def normalize(report, today):
  """Coerce a parsed report dict to the UI schema.

  Returns the cleaned dict, or None if it lacks the minimum the UI
  needs (a top-level summary and at least one article). Drops a
  source_url that isn't a real http(s) string rather than rendering a
  fabricated or relative link.
  """
  if not isinstance(report, dict):
    return None
  summary = report.get("summary")
  if not isinstance(summary, str) or not summary.strip():
    return None
  date = report.get("date")
  if not isinstance(date, str) or not date.strip():
    date = today
  out_sections = []
  for section in report.get("sections", []) or []:
    if not isinstance(section, dict):
      continue
    title = section.get("title")
    title = title.strip() if isinstance(title, str) else ""
    out_articles = []
    for art in section.get("articles", []) or []:
      if not isinstance(art, dict):
        continue
      headline = art.get("headline")
      art_summary = art.get("summary")
      if not isinstance(headline, str) or not headline.strip():
        continue
      if not isinstance(art_summary, str) or not art_summary.strip():
        continue
      clean = {"headline": headline.strip(), "summary": art_summary.strip()}
      src = art.get("source_url")
      if is_http_url(src):
        clean["source_url"] = src
      out_articles.append(clean)
    if out_articles:
      out_sections.append({"title": title, "articles": out_articles})
  if not out_sections:
    return None
  return {"date": date, "summary": summary.strip(), "sections": out_sections}


candidate = first_json_object(text)
if candidate is None:
  sys.exit(2)
try:
  parsed = json.loads(candidate)
except json.JSONDecodeError:
  sys.exit(2)
report = normalize(parsed, today)
if report is None:
  sys.exit(2)
with open(out_path, "w", encoding="utf-8") as f:
  json.dump(report, f, ensure_ascii=False)
PY
EXTRACT_RC=$?

if [ "$EXTRACT_RC" -eq 0 ] && [ -s "$EXTRACTED_FILE" ]; then
  # 5. PUT the extracted JSON ourselves, as a bare object. fetch.sh
  #    holds the token — the agent never saw it.
  PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$REPORT_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @"$EXTRACTED_FILE") || PUT_CODE=000

  if [ "$PUT_CODE" = "200" ] || [ "$PUT_CODE" = "201" ] || [ "$PUT_CODE" = "204" ]; then
    log "Digest saved (PUT $TODAY.json: $PUT_CODE)"
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
  log "ERROR: failed to save extracted report (HTTP $PUT_CODE)"
fi

log "Agent did not produce a usable report (extract_rc=$EXTRACT_RC). Writing stub..."

# 6. Salvage path: write a stub JSON report so the date shows up in the
#    UI's picker with an honest "could not be generated" summary. Same
#    bare-object shape the UI renders — an empty sections array, the
#    explanation in the top-level summary.
STUB_FILE="$WORK_DIR/stub.json"
python3 - "$STUB_FILE" "$TODAY" <<'PY' 2>>"$LOG_FILE"
import json, sys
out_path, today = sys.argv[1], sys.argv[2]
stub = {
  "date": today,
  "summary": (
    "Today's digest could not be generated. The news curator did not "
    "return a usable report — check /data/cron-logs/news.log for "
    "details. The next scheduled run will try again."
  ),
  "sections": [],
}
with open(out_path, "w", encoding="utf-8") as f:
  json.dump(stub, f, ensure_ascii=False)
PY

# 7. PUT the stub. Only fires if the agent didn't produce a usable
#    report object.
PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X PUT "$REPORT_URL" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
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
