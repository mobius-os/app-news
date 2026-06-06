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
#   3. GETs system-prompt.md (baked, role + HTML schema), topics.txt
#      (user-editable, what to search for), and recent reader feedback
#      from app storage, then composes them into a combined system prompt
#   4. Runs the chosen CLI with WebSearch as the only allowed tool —
#      the agent has no Bash, no Write, no WebFetch. Its only output
#      channel is stdout (the final assistant message).
#   5. Parses the agent's stdout for the HTML report article and PUTs it
#      to reports/YYYY-MM-DD.html ourselves. The service token is NEVER in the agent's
#      prompt — fetch.sh holds it and does the PUT, so a prompt-
#      injection in a poisoned search result has no token to
#      exfiltrate and no Bash to run.
#   6. If the agent's output had no salvageable report (no article,
#      or one without even a summary paragraph), a clearly-marked ERROR
#      report is written — NOT a silent placeholder. It carries the
#      failure reason, the CLI exit code, and a short excerpt of the
#      agent's raw reply, so the feed shows WHAT WENT WRONG for today
#      instead of reading as an empty digest.
#   7. Report lands at reports/YYYY-MM-DD.html (Content-Type: text/html)
#   8. A seeded chat is created and linked at reports/YYYY-MM-DD.meta.json
#      so report feedback can continue in context.
#   9. Logs to /data/cron-logs/news.log
#   10. Sends a push notification on success
#
# Schedule: this job's cron entry is installed from the manifest default,
# then the app's Settings tab may rewrite it through /api/apps/<id>/schedule.

set -uo pipefail

APP_ID="${1:-}"
if [ -z "$APP_ID" ]; then
  echo "fetch.sh: APP_ID required as first argument" >&2
  exit 2
fi
case "$APP_ID" in
  *[!0-9]*)
    echo "fetch.sh: APP_ID must be numeric" >&2
    exit 2
    ;;
esac

API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"
TODAY=$(date -u +%Y-%m-%d)
NOW=$(date -u +%H:%M:%S)
LOG_DIR=/data/cron-logs
LOG_FILE="$LOG_DIR/news.log"
LOCK_FILE="$LOG_DIR/news-$APP_ID.lock"
NEWS_TIMEOUT="${NEWS_TIMEOUT:-900}"
WORK_DIR=$(mktemp -d -t app-news.XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$LOG_DIR"

log() {
  echo "[$TODAY $(date -u +%H:%M:%S)] $*" >> "$LOG_FILE"
}

log "Starting digest fetch for app_id=$APP_ID"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another news digest run is already active; skipping this trigger."
  exit 5
fi

if [ ! -r /data/service-token.txt ]; then
  log "ERROR: /data/service-token.txt is missing or unreadable"
  exit 1
fi
SERVICE_TOKEN=$(cat /data/service-token.txt)
if [ -z "$SERVICE_TOKEN" ]; then
  log "ERROR: /data/service-token.txt is empty"
  exit 1
fi

# 1. Pull the baked system prompt (role + HTML schema, NOT user-editable),
#    the user-editable topics text, and recent reader feedback. Compose them
#    into one system prompt file passed to the CLI.
SYSTEM_FILE="$WORK_DIR/system-prompt.md"
SYS_CODE=$(curl -sS -o "$SYSTEM_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/system-prompt.md") || SYS_CODE=000

if [ "$SYS_CODE" != "200" ]; then
  log "ERROR: failed to fetch system-prompt.md (HTTP $SYS_CODE)"
  exit 1
fi

# system-prompt.md is a baked schema prompt, not an owner-editable brief.
# Some News installs were updated through a JSON-output interlude. App
# updates deliberately do not overwrite storage seeds, so repair any stale
# JSON schema prompt in-memory while leaving topics.txt and feedback alone.
if grep -qi "single JSON object" "$SYSTEM_FILE" \
  || ! grep -qi "pure HTML fragment" "$SYSTEM_FILE" \
  || ! grep -qi "private working list of relevant articles" "$SYSTEM_FILE"; then
  log "Replacing stale system-prompt.md with bundled HTML schema prompt"
  cat >"$SYSTEM_FILE" <<'EOF'
# Daily News Curator

You are a news researcher and magazine-style brief writer producing today's HTML digest for the user.

See the "Topics to cover" section at the end of this prompt for the user's editorial brief. That text drives what you cover, which sources to prefer, and the voice/framing to use. This prompt defines the workflow and output schema.

## Workflow

1. First compile a private working list of relevant articles and primary sources. Use it to decide what matters; do not output that raw list unless it becomes useful as a small table in the final article.
2. Prefer recent, reputable sources and primary documents. Cross-check important claims before treating them as central.
3. Write one detailed, engaging article based on the user's brief. It should feel like a finished morning read, not a dashboard.

## Output format

Output a pure HTML fragment: no JSON, no markdown, no `<html>`/`<head>`/
`<body>` wrapper, no external stylesheets, no code fences. Just one
`<article>` block with this exact outer shell:

```html
<article class="news-report" data-date="YYYY-MM-DD">
  <details class="news-report__summary" open>
    <summary>Today at a glance</summary>
    <p>Two-to-four-sentence tl;dr of the day's stories.</p>
  </details>

  <section class="news-report__body">
    <!-- Your flowing narrative goes here. -->
  </section>
</article>
```

Structural requirements:

- Allowed inside the body: `<h2>`, `<h3>`, `<p>`, `<blockquote>`,
  `<ul>`, `<ol>`, `<li>`, `<table>`, `<figure>`, `<figcaption>`,
  simple inline `<svg>` diagrams, and `<div class="callout">` for key context.
- Use these elements intentionally: a small table for comparison, a callout
  for "why it matters", a figure/diagram when it genuinely clarifies a
  mechanism or timeline. Do not decorate for its own sake.
- Exactly one summary block at the top with a 2-4 sentence tl;dr.
- The article body should open with a strong lede paragraph, then use subheads.
- Cite sources inline as anchors, e.g.
  `<a href="https://..." target="_blank" rel="noopener">Reuters reports</a>`.
  Never fabricate or reconstruct URLs; omit a link rather than guess.
- Set `data-date` to today's date in `YYYY-MM-DD`.
- Body length: roughly 900-1600 words when the brief supports it. Be concise
  when there is not enough real news.
EOF
fi

TOPICS_FILE="$WORK_DIR/topics.txt"
TOPICS_CODE=$(curl -sS -o "$TOPICS_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/topics.txt") || TOPICS_CODE=000

if [ "$TOPICS_CODE" != "200" ]; then
  log "ERROR: failed to fetch topics.txt (HTTP $TOPICS_CODE)"
  exit 1
fi

FEEDBACK_FILE="$WORK_DIR/feedback.md"
python3 - "$API_BASE_URL" "$APP_ID" "$SERVICE_TOKEN" >"$FEEDBACK_FILE" 2>>"$LOG_FILE" <<'PY' || true
import json
import sys
import urllib.parse
import urllib.request

base, app_id, token = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
headers = {"Authorization": "Bearer " + token}

def get_json(path):
    req = urllib.request.Request(base + path, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))

def clean(value, fallback=""):
    if not isinstance(value, str):
        return fallback
    normalized = " ".join(value.split()).strip()
    return normalized or fallback

try:
    cursor = None
    seen = set()
    entries = []
    for _ in range(20):
        path = f"/api/storage/apps-list/{urllib.parse.quote(app_id, safe='')}/feedback"
        params = {"limit": "500"}
        if cursor:
            params["cursor"] = cursor
        path += "?" + urllib.parse.urlencode(params)
        data = get_json(path)
        for entry in data.get("entries", []):
            name = entry.get("name")
            if entry.get("type") == "file" and isinstance(name, str) and name.endswith(".json"):
                entries.append(entry)
        nxt = data.get("next_cursor")
        if not nxt or nxt in seen:
            break
        seen.add(nxt)
        cursor = nxt

    entries = sorted(entries, key=lambda entry: entry.get("modified_at", ""), reverse=True)[:20]
    if not entries:
        print("(no recent feedback)")
    for entry in entries:
        stored_path = entry.get("path")
        if not isinstance(stored_path, str) or not stored_path:
            stored_path = "feedback/" + str(entry.get("name") or "")
        try:
            item = get_json(
                f"/api/storage/apps/{urllib.parse.quote(app_id, safe='')}/"
                + urllib.parse.quote(stored_path, safe="/")
            )
            signal = clean(item.get("signal"), "note")
            created = clean(item.get("created_at"))
            report_date = clean(item.get("report_date"))
            text = clean(item.get("text"), "(no note)")
            headlines = item.get("article_headlines")
            if isinstance(headlines, list):
                headline_text = "; ".join(clean(headline) for headline in headlines if clean(headline))[:500]
            else:
                headline_text = ""
            when = report_date or created
            print(f"- [{signal}] {when}: {text}")
            if headline_text:
                print(f"  Headlines: {headline_text}")
        except Exception as exc:
            print(f"- {stored_path}: could not read ({exc})")
except Exception as exc:
    print(f"(could not list feedback: {exc})")
PY

# Compose: baked system prompt + topics + recent feedback appended at runtime.
PROMPT_FILE="$WORK_DIR/prompt.md"
{
  cat "$SYSTEM_FILE"
  printf '\n\n## Topics to cover\n\n'
  cat "$TOPICS_FILE"
  printf '\n\n## Recent reader feedback\n\n'
  cat "$FEEDBACK_FILE"
  printf '\n\nUse this feedback as editorial preference for today'"'"'s digest. Prefer concrete repeated signals over one-off notes. Do not mention the feedback unless it directly affects coverage.\n'
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
  AGENT_PARSED=$(python3 - "$AGENT_FILE" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        obj = json.load(f)
    p = obj.get('provider', 'claude')
    if p not in ('claude', 'codex'):
        p = 'claude'
    m = obj.get('model', '')
    if not isinstance(m, str):
        m = ''
    print(p + '\t' + m)
except Exception:
    print('claude\t')
PY
)
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
#     message (stdout), which we extract the HTML report article from.
#   - We drop --permission-mode bypassPermissions: with WebSearch as
#     the only allowed tool, there's nothing left for the permission
#     prompt to gate.
#
# The output channel is stdout. Claude's `-p` returns the final
# assistant message text verbatim. Codex's `exec --json` emits an
# `agent_message` event with the final text. Both shapes are parsed
# the same way: extract the first <article>...</article> block.
RAW_OUTPUT="$WORK_DIR/agent.out"
REPORT_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.html"
REPORT_META_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.meta.json"
USER_TURN="Today is $TODAY. Search the web for today's major news, then reply with the HTML report fragment and nothing else — no prose, no markdown, no code fences. Start with <article class=\"news-report\" data-date=\"$TODAY\"> and end with </article>."

write_report_chat_meta() {
  report_file="$1"
  status="$2"
  chat_payload="$WORK_DIR/chat-payload-$status.json"
  chat_response="$WORK_DIR/chat-response-$status.json"
  meta_payload="$WORK_DIR/report-meta-$status.json"

  python3 - "$chat_payload" "$TODAY" "$PROVIDER" "$MODEL" "$status" "$USER_TURN" "$report_file" <<'PY' 2>>"$LOG_FILE"
import json
import sys

out_path, today, provider, model, status, user_turn, report_path = sys.argv[1:8]
try:
    with open(report_path, "r", encoding="utf-8", errors="replace") as f:
        report = f.read()
except Exception:
    report = ""

model_label = model or "(CLI default)"
messages = [
    {
        "role": "user",
        "content": (
            f"Generate the News digest for {today} using the saved News app "
            f"editorial brief and recent feedback.\n\n"
            f"Provider: {provider}\nModel: {model_label}\n\n"
            f"Original cron turn:\n{user_turn}"
        ),
    },
    {
        "role": "assistant",
        "content": (
            f"Generated News digest for {today} (status: {status}).\n\n"
            f"{report}"
        ),
    },
]
payload = {
    "title": f"News digest - {today}",
    "messages": messages,
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
PY

  CHAT_CODE=$(curl -sS -o "$chat_response" -w "%{http_code}" \
    -X POST "$API_BASE_URL/api/chats" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @"$chat_payload") || CHAT_CODE=000

  if [ "$CHAT_CODE" != "200" ] && [ "$CHAT_CODE" != "201" ]; then
    log "WARN: failed to create feedback chat for $TODAY (HTTP $CHAT_CODE)"
    return 0
  fi

  CHAT_ID=$(python3 - "$chat_response" <<'PY' 2>>"$LOG_FILE"
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    chat_id = data.get("id")
    if isinstance(chat_id, str) and chat_id:
        print(chat_id)
except Exception:
    pass
PY
)
  if [ -z "$CHAT_ID" ]; then
    log "WARN: chat create response did not include an id"
    return 0
  fi

  python3 - "$meta_payload" "$CHAT_ID" "$TODAY" "$PROVIDER" "$MODEL" "$status" <<'PY' 2>>"$LOG_FILE"
import json
import sys
from datetime import datetime, timezone

out_path, chat_id, today, provider, model, status = sys.argv[1:7]
payload = {
    "chat_id": chat_id,
    "report_date": today,
    "provider": provider,
    "model": model or None,
    "status": status,
    "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
PY

  META_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$REPORT_META_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @"$meta_payload") || META_CODE=000
  if [ "$META_CODE" = "200" ] || [ "$META_CODE" = "201" ] || [ "$META_CODE" = "204" ]; then
    log "Report metadata saved (chat_id=$CHAT_ID)"
  else
    log "WARN: failed to save report metadata (HTTP $META_CODE)"
  fi
}

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
  timeout "$NEWS_TIMEOUT" env CLAUDE_CONFIG_DIR=/data/cli-auth/claude claude -p "$USER_TURN" \
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
    | timeout "$NEWS_TIMEOUT" codex "${CODEX_FLAGS[@]}" > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  CLI_EXIT=$?
fi

if [ "$CLI_EXIT" -ne 0 ]; then
  log "ERROR: agent exited with code $CLI_EXIT"
  if [ "$CLI_EXIT" -eq 124 ]; then
    log "ERROR: agent timed out after ${NEWS_TIMEOUT}s"
  fi
fi

# 4. Extract the HTML report article from the agent's output.
#    - Claude -p: stdout is the final assistant message text verbatim.
#    - Codex exec --json: stdout is JSONL; the final `agent_message`
#      event carries the text. python3 grabs the last `agent_message`
#      payload, or falls back to the raw bytes if parsing fails.
#    The agent is told to reply with bare HTML, but we tolerate
#    surrounding prose by scanning for the first <article> block. Then
#    we sanitize server-side: scripts/styles/event handlers are removed,
#    only a small article-writing tag set is kept, and anchors keep only
#    http(s) hrefs with safe target/rel attributes.
EXTRACTED_FILE="$WORK_DIR/extracted.html"
python3 - "$RAW_OUTPUT" "$EXTRACTED_FILE" "$PROVIDER" "$TODAY" <<'PY' 2>>"$LOG_FILE"
from html import escape
from html.parser import HTMLParser
import json
import re
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

match = re.search(r"<article\b[\s\S]*?</article>", text, re.I)
if not match:
  sys.exit(2)
article = match.group(0)

class Sanitizer(HTMLParser):
  allowed = {
    "article", "details", "summary", "section", "p", "h2", "h3", "h4",
    "a", "ul", "ol", "li", "blockquote", "strong", "em", "b", "i",
    "span", "time", "br", "div", "figure", "figcaption", "table",
    "thead", "tbody", "tr", "th", "td", "svg", "g", "path", "circle",
    "rect", "line", "polyline", "text",
  }
  void = {"br"}
  def __init__(self):
    super().__init__(convert_charrefs=True)
    self.out = []
    self.skip = []
    self.text = []
  def handle_starttag(self, tag, attrs):
    tag = tag.lower()
    if tag in ("script", "style"):
      self.skip.append(tag)
      return
    if self.skip or tag not in self.allowed:
      return
    clean = []
    attrs = dict(attrs or [])
    if tag == "article":
      clean.append(('class', 'news-report'))
      clean.append(('data-date', today))
    elif tag == "details":
      clean.append(('class', 'news-report__summary'))
      clean.append(('open', ''))
    elif tag == "section":
      clean.append(('class', 'news-report__body'))
    elif tag == "a":
      href = (attrs.get("href") or "").strip()
      try:
        from urllib.parse import urlsplit
        parts = urlsplit(href)
        href_ok = parts.scheme.lower() in ("http", "https") and bool(parts.netloc)
      except Exception:
        href_ok = False
      if href_ok:
        clean.extend([
          ("href", href),
          ("target", "_blank"),
          ("rel", "noopener noreferrer"),
        ])
    elif tag == "div":
      if attrs.get("class") == "callout":
        clean.append(("class", "callout"))
    elif tag == "svg":
      for key in ("viewBox", "width", "height", "role", "aria-label"):
        value = attrs.get(key) or attrs.get(key.lower())
        if value and re.match(r"^[\w\s.,:;#()%/+=\"'-]{1,200}$", value):
          clean.append((key, value))
    elif tag in ("g", "path", "circle", "rect", "line", "polyline", "text"):
      safe_attrs = {
        "g": ("fill", "stroke", "stroke-width"),
        "path": ("d", "fill", "stroke", "stroke-width"),
        "circle": ("cx", "cy", "r", "fill", "stroke", "stroke-width"),
        "rect": ("x", "y", "width", "height", "rx", "fill", "stroke", "stroke-width"),
        "line": ("x1", "y1", "x2", "y2", "stroke", "stroke-width"),
        "polyline": ("points", "fill", "stroke", "stroke-width"),
        "text": ("x", "y", "fill", "font-size", "text-anchor"),
      }[tag]
      for key in safe_attrs:
        value = attrs.get(key)
        if value and re.match(r"^[\w\s.,:;#()%/+=\"'-]{1,500}$", value):
          clean.append((key, value))
    bits = [tag]
    for k, v in clean:
      bits.append(k if v == "" else f'{k}="{escape(v, quote=True)}"')
    self.out.append("<" + " ".join(bits) + ">")
  def handle_endtag(self, tag):
    tag = tag.lower()
    if self.skip:
      if tag == self.skip[-1]:
        self.skip.pop()
      return
    if tag in self.allowed and tag not in self.void:
      self.out.append(f"</{tag}>")
  def handle_data(self, data):
    if self.skip:
      return
    self.out.append(escape(data))
    if data.strip():
      self.text.append(data.strip())
  def handle_entityref(self, name):
    self.handle_data(f"&{name};")
  def handle_charref(self, name):
    self.handle_data(f"&#{name};")

parser = Sanitizer()
parser.feed(article)
clean = "".join(parser.out).strip()
plain = " ".join(parser.text)
if "<article" not in clean or "news-report__summary" not in clean or len(plain) < 80:
  sys.exit(2)

with open(out_path, "w", encoding="utf-8") as f:
  f.write(clean)
PY
EXTRACT_RC=$?

if [ "$EXTRACT_RC" -eq 0 ] && [ -s "$EXTRACTED_FILE" ]; then
  # 5. PUT the extracted HTML ourselves. fetch.sh holds the token —
  #    the agent never saw it.
  PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$REPORT_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: text/html; charset=utf-8" \
    --data-binary @"$EXTRACTED_FILE") || PUT_CODE=000

  if [ "$PUT_CODE" = "200" ] || [ "$PUT_CODE" = "201" ] || [ "$PUT_CODE" = "204" ]; then
    log "Digest saved (PUT $TODAY.html: $PUT_CODE)"
    write_report_chat_meta "$EXTRACTED_FILE" "ready"
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

log "Agent did not produce a usable HTML report (extract_rc=$EXTRACT_RC, cli_exit=$CLI_EXIT). Writing error report..."

# 6. Error-report path: the agent's output had no salvageable report
#    (no article at all, or the article lacked a usable summary). We do
#    NOT write a silent placeholder that reads like an
#    empty digest — instead we write a clearly-marked ERROR report so
#    the feed surfaces WHAT WENT WRONG and the next run retries.
#
#    Same HTML report shell the UI renders, so it shows up as a normal
#    report whose lede announces the failure, with a Diagnostics section
#    carrying the CLI exit code, the failure reason, and a short excerpt.
#    The excerpt is sliced + control-chars-stripped in Python (never
#    interpolated into the shell), so a poisoned search result that the
#    agent echoed back can't break out into a command — the only sink is
#    HTML escaping, which keeps it inert.
ERROR_FILE="$WORK_DIR/error.html"
python3 - "$ERROR_FILE" "$TODAY" "$EXTRACT_RC" "$CLI_EXIT" "$RAW_OUTPUT" <<'PY' 2>>"$LOG_FILE"
from html import escape
import sys

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
# usable" (no article, unsafe HTML, or no usable summary); a non-zero
# CLI exit means the agent process itself failed (auth, model id
# rejected, timeout). Both can be true; report what we know.
if cli_exit not in ("", "0"):
  reason = (
    "The news curator (CLI) exited with code %s before returning a "
    "usable report. Common causes: an expired provider login, a model "
    "id the CLI rejected, or the run timing out." % cli_exit
  )
else:
  reason = (
    "The news curator returned a reply, but it contained no report we "
    "could parse — no HTML article with a summary. The model may have "
    "answered in the wrong format, refused, or been cut off."
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

with open(out_path, "w", encoding="utf-8") as f:
  f.write(f'''<article class="news-report" data-date="{escape(today)}">
  <details class="news-report__summary" open>
    <summary>Today at a glance</summary>
    <p>Today's digest could not be generated. Expand for what went wrong — the next scheduled run will retry automatically.</p>
  </details>
  <section class="news-report__body">
    <h2>Diagnostics</h2>
    <p>{escape(reason)} The next scheduled run will try again; you can also press Run now in Settings. Full logs: /data/cron-logs/news.log.</p>
''')
  if raw_excerpt:
    f.write(f'    <h3>What the curator returned</h3><blockquote>{escape(raw_excerpt)}</blockquote>\n')
  f.write('  </section>\n</article>\n')
PY

# 7. PUT the error report. Only fires when extraction yielded nothing
#    usable — a successful digest took the exit-0 path above.
PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X PUT "$REPORT_URL" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: text/html; charset=utf-8" \
  --data-binary @"$ERROR_FILE") || PUT_CODE=000

if [ "$PUT_CODE" != "200" ] && [ "$PUT_CODE" != "201" ] && [ "$PUT_CODE" != "204" ]; then
  log "ERROR: failed to save error report (HTTP $PUT_CODE)"
  exit 1
fi

log "Error report saved (HTTP $PUT_CODE)"
write_report_chat_meta "$ERROR_FILE" "error"

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
