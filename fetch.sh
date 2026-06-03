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
#   6. If the agent's output had no salvageable report (no JSON object,
#      or one without even a top-level summary), a clearly-marked ERROR
#      report is written — NOT a silent placeholder. It carries the
#      failure reason, the CLI exit code, and a short excerpt of the
#      agent's raw reply, so the feed shows WHAT WENT WRONG for today
#      instead of reading as an empty digest. A report with a usable
#      summary but no parseable articles is kept as-is (summary-only),
#      not discarded.
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
  # Per-invocation hardening (closes the residual risk ticket 068 flagged
  # for this path): --sandbox read-only means any shell command the model
  # is induced to run — e.g. via a prompt-injection planted in a search
  # result — executes with NO disk-write and NO network access, so it
  # can't write to disk or exfiltrate. The built-in WebSearch tool is not
  # a sandboxed shell command, so it still works. Codex lacks Claude's
  # per-tool allowlist, but read-only sandbox removes the dangerous
  # capability, matching the Claude path's "no Bash/Write/WebFetch" posture.
  CODEX_FLAGS=(exec --json --sandbox read-only)
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
#    URLs that aren't http(s). The ONLY hard requirement is a non-empty
#    top-level summary; a report with a good summary but no parseable
#    articles is KEPT (summary-only) rather than discarded, since the
#    UI renders that fine and a real tl;dr beats an error card. The
#    normalized object is written to EXTRACTED_FILE as a BARE JSON
#    object (no {"content":...} wrapper) so the .json storage path
#    stores it verbatim.
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
  """Coerce a parsed report dict to the UI schema, or return None.

  The ONLY hard requirement is a non-empty top-level summary — that is
  the lede the feed shows collapsed, and the same minimum the client's
  normalizeReport enforces (report-schema.mjs). Everything below it is
  best-effort: sections without a complete article are dropped, but a
  report whose article details didn't parse is STILL kept (with an
  empty sections list) rather than thrown away. Discarding a digest
  that has a perfectly good summary just because the article objects
  came back malformed is the silent-failure this salvage exists to
  avoid — the UI renders summary-only reports fine ("No stories in
  this digest"), and a real tl;dr beats a "could not be generated"
  stub every time.

  Drops a source_url that isn't a real http(s) string rather than
  rendering a fabricated or relative link.
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
        \"target\": \"/shell/?app=$APP_ID\",
        \"actions\": [
          {\"action\": \"open_app\", \"title\": \"Read\", \"target\": \"/shell/?app=$APP_ID\"}
        ]
      }" >> "$LOG_FILE" 2>&1
    log "Done."
    exit 0
  fi
  log "ERROR: failed to save extracted report (HTTP $PUT_CODE)"
fi

log "Agent did not produce a usable report (extract_rc=$EXTRACT_RC, cli_exit=$CLI_EXIT). Writing error report..."

# 6. Error-report path: the agent's output had no salvageable report
#    (no JSON object at all, or the object lacked even a top-level
#    summary). We do NOT write a silent placeholder that reads like an
#    empty digest — instead we write a clearly-marked ERROR report so
#    the feed surfaces WHAT WENT WRONG and the next run retries.
#
#    Same bare-object schema the UI renders (date + summary + sections),
#    so it shows up as a normal-looking card whose lede announces the
#    failure, with a "Diagnostics" section carrying the CLI exit code,
#    the failure reason, and a short excerpt of the agent's raw reply.
#    The excerpt is sliced + control-chars-stripped in Python (never
#    interpolated into the shell), so a poisoned search result that the
#    agent echoed back can't break out into a command — the only sink is
#    json.dump, which escapes everything.
ERROR_FILE="$WORK_DIR/error.json"
python3 - "$ERROR_FILE" "$TODAY" "$EXTRACT_RC" "$CLI_EXIT" "$RAW_OUTPUT" <<'PY' 2>>"$LOG_FILE"
import json, sys

out_path, today, extract_rc, cli_exit, raw_path = sys.argv[1:6]

# Read whatever the agent emitted, defensively. A truncated or binary
# reply must not throw here — we want the error report written no
# matter what the upstream failure was.
raw = ""
try:
  with open(raw_path, "r", encoding="utf-8", errors="replace") as f:
    raw = f.read()
except Exception:
  raw = ""

# Human-readable cause. extract_rc==2 is "extraction found nothing
# usable" (no JSON object, unparseable JSON, or no top-level summary);
# a non-zero CLI exit means the agent process itself failed (auth,
# model id rejected, timeout). Both can be true; report what we know.
if cli_exit not in ("", "0"):
  reason = (
    "The news curator (CLI) exited with code %s before returning a "
    "usable report. Common causes: an expired provider login, a model "
    "id the CLI rejected, or the run timing out." % cli_exit
  )
else:
  reason = (
    "The news curator returned a reply, but it contained no report we "
    "could parse — no JSON object with a summary. The model may have "
    "answered in prose, refused, or been cut off."
  )

# A short, sanitized excerpt of the raw reply so the reader (and a
# future debugger) can see what actually came back, without dumping a
# huge or control-char-laden blob into the card. Strip control chars
# (keep tab/newline), collapse to a single trimmed window.
def excerpt(s, limit=600):
  cleaned = "".join(
    c for c in s if c in ("\t", "\n") or (ord(c) >= 32 and ord(c) != 127)
  ).strip()
  if not cleaned:
    return ""
  return cleaned[:limit] + ("…" if len(cleaned) > limit else "")

raw_excerpt = excerpt(raw)

diag_articles = [{
  "headline": "Why today's digest is missing",
  "summary": reason + " The next scheduled run will try again; you can "
             "also press Run now in Settings. Full logs: "
             "/data/cron-logs/news.log.",
}]
if raw_excerpt:
  diag_articles.append({
    "headline": "What the curator returned",
    "summary": raw_excerpt,
  })

error_report = {
  "date": today,
  "summary": (
    "Today's digest could not be generated. Expand for what went wrong "
    "— the next scheduled run will retry automatically."
  ),
  "sections": [{"title": "Diagnostics", "articles": diag_articles}],
}
with open(out_path, "w", encoding="utf-8") as f:
  json.dump(error_report, f, ensure_ascii=False)
PY

# 7. PUT the error report. Only fires when extraction yielded nothing
#    usable — a successful (even summary-only) digest took the exit-0
#    path above.
PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X PUT "$REPORT_URL" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @"$ERROR_FILE") || PUT_CODE=000

if [ "$PUT_CODE" != "200" ] && [ "$PUT_CODE" != "201" ] && [ "$PUT_CODE" != "204" ]; then
  log "ERROR: failed to save error report (HTTP $PUT_CODE)"
  exit 1
fi

log "Error report saved (HTTP $PUT_CODE)"

# 8. Notify — honestly. The error report IS the day's content, so the
#    date still shows up in the feed, but the notification says it
#    couldn't be generated rather than claiming a fresh digest is ready.
curl -sS -X POST "$API_BASE_URL/api/notifications/send" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"News digest unavailable\",
    \"body\": \"Today's digest for $TODAY couldn't be generated — open for details.\",
    \"source_type\": \"app\",
    \"source_id\": \"$APP_ID\",
    \"target\": \"/shell/?app=$APP_ID\",
    \"actions\": [
      {\"action\": \"open_app\", \"title\": \"Details\", \"target\": \"/shell/?app=$APP_ID\"}
    ]
  }" >> "$LOG_FILE" 2>&1

log "Done."
