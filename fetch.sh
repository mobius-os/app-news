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
#   2. Reads agent.json and system background-agent defaults
#   3. GETs system-prompt.md (baked, role + HTML schema), topics.txt
#      (user-editable, what to search for), and recent reader feedback
#      from app storage, then composes them into a combined system prompt
#   4. Runs the chosen CLI with read-only research tools —
#      the agent has no Bash or Write access. Its only output
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
#   8. A reports/YYYY-MM-DD.meta.json sidecar records the STORED report's
#      ready/error status for rerun-overwrite safety, and a
#      reports/YYYY-MM-DD.run.json sidecar records THIS run's lifecycle
#      (started/finished/status) so the app's generate poll can detect
#      completion even when the overwrite guard leaves the report untouched.
#   9. Logs to /data/cron-logs/news.log
#   10. Sends a push notification on success/failure and emits cron_summary.
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
START_TS=$(date +%s)
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_TZ="${NEWS_TIMEZONE:-UTC}"
TODAY=$(TZ="$RUN_TZ" date +%Y-%m-%d)
NOW=$(TZ="$RUN_TZ" date +%H:%M:%S)
LOG_DIR=/data/cron-logs
LOG_FILE="$LOG_DIR/news.log"
LOCK_FILE="$LOG_DIR/news-$APP_ID.lock"
NEWS_TIMEOUT="${NEWS_TIMEOUT:-900}"
WORK_DIR=$(mktemp -d -t app-news.XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$LOG_DIR"

log() {
  echo "[$TODAY $(TZ="$RUN_TZ" date +%H:%M:%S)] $*" >> "$LOG_FILE"
}

emit_cron_summary() {
  status="$1"
  cli_exit="${2:-0}"
  items_fetched="${3:-0}"
  message="${4:-}"
  if [ -z "${SERVICE_TOKEN:-}" ]; then
    return 0
  fi
  duration_s=$(($(date +%s) - START_TS))
  python3 - "$API_BASE_URL" "$APP_ID" "$SERVICE_TOKEN" "$status" "${PROVIDER:-claude}" "$cli_exit" "$duration_s" "$items_fetched" "$message" <<'PY' >>"$LOG_FILE" 2>&1 || true
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

base, app_id, token, status, provider, cli_exit, duration_s, items_fetched, message = sys.argv[1:10]
provider = provider if provider in ("claude", "codex") else "claude"
try:
    cli_exit = int(cli_exit)
except Exception:
    cli_exit = 0
try:
    duration_s = int(duration_s)
except Exception:
    duration_s = 0
try:
    items_fetched = int(items_fetched)
except Exception:
    items_fetched = 0

entry = {
    "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "name": "cron_summary",
    "status": status,
    "provider": provider,
    "cli_exit": cli_exit,
    "duration_s": duration_s,
    "items_fetched": items_fetched,
    "message": (message or "")[:180],
}
path = f"/api/storage/apps/{urllib.parse.quote(app_id, safe='')}/signals.jsonl"
url = base.rstrip("/") + path
headers = {"Authorization": "Bearer " + token}
text = ""
try:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as response:
        if response.status == 200:
            text = response.read().decode("utf-8", errors="replace")
except urllib.error.HTTPError as exc:
    if exc.code != 404:
        pass
except Exception:
    pass

lines = [line for line in text.splitlines() if line.strip()]
lines = (lines + [json.dumps(entry, separators=(",", ":"), ensure_ascii=False)])[-500:]
body = ("\n".join(lines) + "\n").encode("utf-8")
req = urllib.request.Request(
    url,
    data=body,
    method="PUT",
    headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "text/plain; charset=utf-8",
    },
)
with urllib.request.urlopen(req, timeout=15):
    pass
PY
}

# Run-status channel for the app's "Generate report now" poll.
#
# The overwrite guard (existing_ready_report) deliberately leaves
# reports/<date>.html UNTOUCHED when a failed rerun preserves a good digest —
# so the app cannot detect completion from that file's mtime in that case, and
# an mtime-only poll would spin on "Generating…" forever. This side file
# records THIS run's lifecycle so the poll terminates honestly on EVERY
# terminal, including the preserved-good-digest failure.
#
# It is distinct from reports/<date>.meta.json on purpose: meta.json records
# the status of the STORED report (and must stay "ready" when a preserved
# rerun fails, or the guard breaks); this file records the status of the RUN
# ("ok" / "error", or "running" while in flight with a null finished_at).
write_run_status() {
  status="$1"
  message="${2:-}"
  if [ -z "${SERVICE_TOKEN:-}" ] || [ -z "${RUN_STATUS_URL:-}" ]; then
    return 0
  fi
  run_payload="$WORK_DIR/run-status.json"
  python3 - "$run_payload" "$RUN_STARTED_AT" "$status" "$message" <<'PY' 2>>"$LOG_FILE"
import json
import sys
from datetime import datetime, timezone

out_path, started_at, status, message = sys.argv[1:5]
# finished_at stays null while the run is in flight; a non-"running" status is a
# terminal, so it carries the finish timestamp the poll keys completion on.
finished_at = None
if status != "running":
    finished_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
payload = {
    "started_at": started_at,
    "finished_at": finished_at,
    "status": status,
    "message": (message or "")[:180],
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
PY
  curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$RUN_STATUS_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @"$run_payload" >>"$LOG_FILE" 2>&1 || true
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

SCHEDULE_FILE="$WORK_DIR/schedule.json"
SCHEDULE_CODE=$(curl -sS -o "$SCHEDULE_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/schedule.json") || SCHEDULE_CODE=000
if [ "$SCHEDULE_CODE" = "200" ]; then
  SCHEDULE_TZ=$(python3 - "$SCHEDULE_FILE" <<'PY' 2>>"$LOG_FILE"
import json
import sys
try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    tz = data.get("timezone")
    if isinstance(tz, str) and tz:
        if ZoneInfo is not None:
            ZoneInfo(tz)
        print(tz)
except Exception:
    pass
PY
)
  if [ -n "$SCHEDULE_TZ" ]; then
    RUN_TZ="$SCHEDULE_TZ"
    TODAY=$(TZ="$RUN_TZ" date +%Y-%m-%d)
    NOW=$(TZ="$RUN_TZ" date +%H:%M:%S)
    log "Using schedule timezone: $RUN_TZ (report date $TODAY)"
  fi
fi

# TODAY is now final (schedule timezone applied). Key the run-status side file
# to it and mark the run in flight so a manual "Generate report now" poll knows
# a run started even before the first terminal.
RUN_STATUS_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.run.json"
write_run_status "running"

# 1. Pull the baked system prompt (role + HTML schema, NOT user-editable),
#    the user-editable topics text, and recent reader feedback. Compose them
#    into one system prompt file passed to the CLI.
SYSTEM_FILE="$WORK_DIR/system-prompt.md"
SYS_CODE=$(curl -sS -o "$SYSTEM_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/system-prompt.md") || SYS_CODE=000

if [ "$SYS_CODE" != "200" ]; then
  log "ERROR: failed to fetch system-prompt.md (HTTP $SYS_CODE)"
  emit_cron_summary "error" 0 0 "failed to fetch system-prompt.md HTTP $SYS_CODE"
  write_run_status "error" "failed to fetch system-prompt.md HTTP $SYS_CODE"
  exit 1
fi

# system-prompt.md is a baked schema prompt, not an owner-editable brief.
# Some News installs were updated through a JSON-output interlude. App
# updates deliberately do not overwrite storage seeds, so repair any stale
# JSON schema prompt in-memory while leaving topics.txt and feedback alone.
# The "<header>" marker gates the masthead-era schema (h1 headline +
# keypoints + long-tail details): prompts predating it get re-baked too.
if grep -qi "single JSON object" "$SYSTEM_FILE" \
  || ! grep -qi "pure HTML fragment" "$SYSTEM_FILE" \
  || ! grep -qi "private working list of relevant articles" "$SYSTEM_FILE" \
  || ! grep -q "<header>" "$SYSTEM_FILE"; then
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

Output a pure HTML fragment: no JSON, no markdown, no `<html>`/`<head>`/`<body>` wrapper, no external stylesheets, no code fences. Just one `<article>` block with this exact outer shell:

```html
<article class="news-report" data-date="YYYY-MM-DD">
  <header>
    <p>Daily digest · Thursday 12 June 2026</p>
    <h1>One sharp headline naming the day's defining story</h1>
  </header>

  <details class="news-report__summary" open>
    <summary>Today at a glance</summary>
    <p>Two-to-four-sentence tl;dr of the day's stories.</p>
    <ul>
      <li>First key development — concrete and self-contained.</li>
      <li>Second key development.</li>
      <li>Third key development.</li>
    </ul>
  </details>

  <section class="news-report__body">
    <!-- Your flowing narrative goes here. -->
  </section>
</article>
```

Allowed inside the body: `<h2>`, `<h3>`, `<p>`, `<blockquote>`, `<ul>`, `<ol>`, `<li>`, `<table>`, `<figure>`, `<figcaption>`, `<img>`, simple inline `<svg>` diagrams, `<div class="callout">` for key context, and collapsed `<details>`/`<summary>` blocks for the long tail (see below).

Use these elements intentionally: a small table for comparison, a callout for "why it matters", a figure/diagram when it genuinely clarifies a mechanism or timeline. Do not decorate for its own sake.

Inline images: embed 1-2 relevant images for major stories, using the lead/`og:image` URL you discover on a page you actually cite. Use WebFetch to read that page and pull the real image URL. Wrap each in a `<figure>` with a one-line `<figcaption>` crediting the source, e.g. `<figure><img src="https://..." alt="..."><figcaption>Source: Reuters</figcaption></figure>`. Strict rules: omit rather than guess — never fabricate or reconstruct an image URL; only `https://` image URLs that come from a source you cite; never hotlink decorative or stock images. If you can't find a real, relevant image for a story, leave it out.

Structural requirements:

- Masthead: the `<header>` opens with a one-line kicker `<p>` — "Daily digest · {weekday, day month year}" — followed by an `<h1>` headline. Write a real front-page headline (aim for under twelve words) that names the day's defining story; never a generic label like "Today's News" or "Daily Digest".
- Exactly one summary block, directly after the header, and it must be the FIRST `<details>` element in the article. The `<summary>` label is "Today at a glance"; the `<p>` carries a 2-4 sentence tl;dr; the `<ul>` lists 3-5 key developments, one line each, each concrete enough to stand alone — a reader who stops here should still know what happened today.
- The article body opens with a single standfirst paragraph — one or two sentences that anchor the whole digest. It renders slightly larger than body text; write it at that register.
- Section the body with `<h2>` headings for each major story or theme (aim for 3-6 sections). Each section: one or two paragraphs of narrative, then a `<div class="callout">` or `<blockquote>` for key context or a sharp quote when one fits naturally — not as decoration.
- Use `<h3>` for secondary angles inside a section, sparingly. Avoid more than two levels of heading inside any section.
- No walls of text: keep paragraphs to four sentences or fewer, and break any run of more than two consecutive paragraphs with a heading, callout, blockquote, figure, table, or list.
- Long tail: after the main sections, fold minor-but-worth-knowing items into one or two collapsed `<details>` blocks — `<summary>` labels like "Also today" or "In brief", with a `<ul>` of one-line items (with inline source links) inside. These render as tappable drill-downs, collapsed by default; never bury a major story in one.
- Cite sources inline as anchors, e.g. `<a href="https://..." target="_blank" rel="noopener">Reuters reports</a>`. Never fabricate or reconstruct URLs; omit a link rather than guess.
- Set `data-date` to today's date in `YYYY-MM-DD`.
- Body length: roughly 900-1600 words when the brief supports it. Be concise when there is not enough real news.

## Optional: questions for next time

Only when a genuine editorial decision would change FUTURE digests — never as a habit, and never about today's news — you may append ONE questions block as a sibling AFTER `</article>`. The app renders it as native tap cards below the read; the partner's answers are saved and fed back to you on your NEXT run (they do not change today's digest). Omit the block entirely if you have nothing real to ask.

Emit it exactly like this — a `<section data-report-questions>` whose payload is an inert JSON `<script>` (the app extracts and strips it; it never renders inside the page):

```html
<section class="report-questions" data-report-questions>
  <h2>A few questions for next time</h2>
  <p class="rq-note">Your answers guide my next digest — they won't change this one.</p>
  <script type="application/mobius-questions+json">
  {"version":1,"questions":[
    {"question":"Plain-language question?","header":"Short label","multiSelect":false,
     "options":[{"label":"Option A","description":"what this means"},{"label":"Option B"}]}
  ]}
  </script>
</section>
```

Rules: 0-3 questions, each with 2-4 `options` (`label` required, `description` optional); `header` is a 1-2 word category; set `multiSelect` true only when more than one answer makes sense. Ask about durable editorial preferences — depth on a beat, a recurring section, tone — the kind of thing that improves every future digest. The JSON must be valid (a malformed carrier is silently dropped). Do not duplicate a question the "Your answers to my last questions" section shows the partner already answered.
EOF
fi

TOPICS_FILE="$WORK_DIR/topics.txt"
TOPICS_CODE=$(curl -sS -o "$TOPICS_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/topics.txt") || TOPICS_CODE=000

if [ "$TOPICS_CODE" != "200" ]; then
  log "ERROR: failed to fetch topics.txt (HTTP $TOPICS_CODE)"
  emit_cron_summary "error" 0 0 "failed to fetch topics.txt HTTP $TOPICS_CODE"
  write_run_status "error" "failed to fetch topics.txt HTTP $TOPICS_CODE"
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

# The partner's answers to the in-report question cards. These are the
# declarative questions the LAST few digests asked (the carrier the app
# renders as tap cards); the partner's taps were saved to
# question-answers/<date>.json. No live agent waited on them — they're read
# HERE, on the next run, and folded into the brief as editorial direction.
ANSWERS_FILE="$WORK_DIR/question-answers.md"
python3 - "$API_BASE_URL" "$APP_ID" "$SERVICE_TOKEN" >"$ANSWERS_FILE" 2>>"$LOG_FILE" <<'PY' || true
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
    return " ".join(value.split()).strip() or fallback

try:
    cursor = None
    seen = set()
    entries = []
    for _ in range(20):
        path = f"/api/storage/apps-list/{urllib.parse.quote(app_id, safe='')}/question-answers"
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

    # Newest 5 answer files (filenames are <report_date>.json, ISO-sortable).
    entries = sorted(entries, key=lambda e: e.get("name", ""), reverse=True)[:5]
    if not entries:
        print("(no answers yet)")
    for entry in entries:
        stored_path = entry.get("path")
        if not isinstance(stored_path, str) or not stored_path:
            stored_path = "question-answers/" + str(entry.get("name") or "")
        try:
            item = get_json(
                f"/api/storage/apps/{urllib.parse.quote(app_id, safe='')}/"
                + urllib.parse.quote(stored_path, safe="/")
            )
            when = clean(item.get("report_date")) or clean(item.get("answered_at"))
            answers = item.get("answers")
            if isinstance(answers, dict) and answers:
                print(f"From the digest you read on {when}:")
                for q, a in answers.items():
                    print(f"  - {clean(q)} -> {clean(a)}")
        except Exception as exc:
            print(f"- {stored_path}: could not read ({exc})")
except Exception as exc:
    print(f"(could not list answers: {exc})")
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
  printf '\n\n## Your answers to my last questions\n\n'
  cat "$ANSWERS_FILE"
  printf '\n\nThese are the partner'"'"'s taps on the question cards your recent digests offered. Treat each as a confirmed editorial preference for today and going forward. Do not re-ask a question they already answered.\n'
} > "$PROMPT_FILE"

# 2. Resolve the chosen provider + model.
#
# agent.json shape (owner-written via the Settings tab):
#   {
#     "provider": "claude"|"codex",
#     "model": "<model-id>",
#     "effort": "<effort>",
#     "fallback_provider": "claude"|"codex"|null,
#     "fallback_model": "<model-id>"|null,
#     "fallback_effort": "<effort>"|null
#   }
#
# Backwards compat:
#   - Missing file or missing/unknown "provider" → system background primary,
#     then "claude".
#   - Missing "model" → empty MODEL → CLI uses its default (no
#     --model flag appended). This keeps pre-1.3 installs working
#     until the owner opens Settings once.
#   - Missing "effort" → empty EFFORT → CLI uses its default (no
#     effort flag appended).
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
GLOBAL_AGENT_FILE="/data/shared/agent-settings.json"
PROVIDER="claude"
MODEL=""
EFFORT=""
FALLBACK_PROVIDER=""
FALLBACK_MODEL=""
FALLBACK_EFFORT=""
# Emit "provider<TAB>model<TAB>effort<TAB>fallback_provider<TAB>fallback_model<TAB>fallback_effort".
AGENT_PARSED=$(python3 - "$AGENT_FILE" "$GLOBAL_AGENT_FILE" "$AGENT_CODE" <<'PY'
import json
import sys
PROVIDERS = ("claude", "codex")
EFFORTS = {
    "claude": {"low", "medium", "high", "xhigh", "max", "ultracode"},
    "codex": {"none", "minimal", "low", "medium", "high", "xhigh"},
}
KNOWN = {
    "claude": {
        "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
        "claude-opus-4-5-20251001", "claude-sonnet-4-7-20251215",
        "claude-sonnet-4-6", "claude-sonnet-4-5-20251001",
        "claude-haiku-4-5-20251001",
    },
    "codex": {"gpt-5.5", "gpt-5.4"},
}

def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def clean_choice(raw, fallback_provider=None):
    if not isinstance(raw, dict):
        return None
    provider = raw.get("provider")
    if provider not in PROVIDERS:
        provider = fallback_provider if fallback_provider in PROVIDERS else None
    if provider not in PROVIDERS:
        return None
    model = raw.get("model")
    model = model.strip() if isinstance(model, str) and model.strip() else ""
    if model and any(model in ids for p, ids in KNOWN.items() if p != provider):
        model = ""
    effort = raw.get("effort")
    effort = effort.strip() if isinstance(effort, str) and effort.strip() else ""
    if effort not in EFFORTS.get(provider, set()):
        effort = ""
    return provider, model, effort

try:
    app_path, global_path, agent_code = sys.argv[1:4]
    app = load(app_path) if agent_code == "200" else {}
    shared = load(global_path)
    bg = shared.get("background_agents")
    bg = bg if isinstance(bg, dict) else {}
    primary = clean_choice(bg.get("primary"), "claude")
    if primary is None:
        primary = clean_choice({
            "provider": "claude",
            "model": shared.get("model", ""),
            "effort": shared.get("effort", ""),
        }, "claude")
    if app.get("provider") or app.get("model"):
        app_primary = clean_choice({
            "provider": app.get("provider"),
            "model": app.get("model", ""),
            "effort": app.get("effort", ""),
        }, primary[0] if primary else "claude")
        primary = app_primary or primary or ("claude", "", "")
    else:
        primary = primary or ("claude", "", "")
    if app.get("fallback_provider") or app.get("fallback_model"):
        fallback = clean_choice({
            "provider": app.get("fallback_provider"),
            "model": app.get("fallback_model", ""),
            "effort": app.get("fallback_effort", ""),
        })
    else:
        fallback = clean_choice(bg.get("fallback"))
    if fallback == primary:
        fallback = None
    values = [primary[0], primary[1], primary[2], "", "", ""]
    if fallback:
        values[3] = fallback[0]
        values[4] = fallback[1]
        values[5] = fallback[2]
    print("\t".join(values))
except Exception:
    print("claude\t\t\t\t\t")
PY
)
IFS=$'\t' read -r PROVIDER MODEL EFFORT FALLBACK_PROVIDER FALLBACK_MODEL FALLBACK_EFFORT <<< "$AGENT_PARSED"
if [ -n "$MODEL" ]; then
  if [ -n "$EFFORT" ]; then
    log "Using provider: $PROVIDER, model: $MODEL, effort: $EFFORT"
  else
    log "Using provider: $PROVIDER, model: $MODEL"
  fi
else
  if [ -n "$EFFORT" ]; then
    log "Using provider: $PROVIDER (no model override, CLI default), effort: $EFFORT"
  else
    log "Using provider: $PROVIDER (no model override, CLI default)"
  fi
fi
if [ -n "$FALLBACK_PROVIDER" ]; then
  if [ -n "$FALLBACK_MODEL" ]; then
    if [ -n "$FALLBACK_EFFORT" ]; then
      log "Fallback provider: $FALLBACK_PROVIDER, model: $FALLBACK_MODEL, effort: $FALLBACK_EFFORT"
    else
      log "Fallback provider: $FALLBACK_PROVIDER, model: $FALLBACK_MODEL"
    fi
  else
    if [ -n "$FALLBACK_EFFORT" ]; then
      log "Fallback provider: $FALLBACK_PROVIDER (no model override, CLI default), effort: $FALLBACK_EFFORT"
    else
      log "Fallback provider: $FALLBACK_PROVIDER (no model override, CLI default)"
    fi
  fi
fi

# 3. Run the chosen CLI with read-only research tools, no disk writes.
#
# Security model — what keeps the prompt-injection blast radius small:
#   - Token is NOT in the agent's context. fetch.sh holds it and does
#     the PUT itself (step 6). There is no secret in the model's reach
#     to exfiltrate.
#   - Allowed tools are WebSearch + WebFetch only — both read-only.
#     WebFetch lets the curator open a page it cites and read the
#     lead/og:image url so reports can embed real inline images. The
#     agent still has no Bash and no Write: no channel to write to disk,
#     and its only persisted output is the final assistant message
#     (stdout), which we sanitize before extracting the HTML article.
#   - WebFetch does add an outbound-GET channel, so a prompt-injection
#     in a search result could in principle make the agent fetch an
#     attacker url. With no token/secret in context the worst case is
#     leaking the already-public digest content it is researching; the
#     owner accepted this trade to get inline images. Image urls are
#     re-validated to https-only by the server-side sanitizer below.
#   - We drop --permission-mode bypassPermissions: with only the two
#     read-only research tools allowed, there's nothing left for the
#     permission prompt to gate.
#
# The output channel is stdout. Claude's `-p` returns the final
# assistant message text verbatim. Codex's `exec --json` emits an
# `agent_message` event with the final text. Both shapes are parsed
# the same way: extract the first <article>...</article> block.
RAW_OUTPUT="$WORK_DIR/agent.out"
REPORT_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.html"
REPORT_META_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.meta.json"
USER_TURN="Today is $TODAY. Search the web for today's major news, then reply with the HTML report fragment and nothing else — no prose, no markdown, no code fences. Start with <article class=\"news-report\" data-date=\"$TODAY\"> and end with </article>."

write_report_meta() {
  status="$1"
  meta_payload="$WORK_DIR/report-meta-$status.json"
  existing_meta="$WORK_DIR/existing-meta-$status.json"

  # The sidecar is now a small status marker used by the rerun-overwrite guard:
  # a ready meta means a later failed same-day rerun must not replace the good
  # digest with diagnostics HTML. Preserve a legacy chat_id if one exists, but
  # the current app-scoped chat persists separately at chat_id.json.
  CHAT_ID=""
  EXISTING_CODE=$(curl -sS -o "$existing_meta" -w "%{http_code}" \
    -X GET "$REPORT_META_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN") || EXISTING_CODE=000
  if [ "$EXISTING_CODE" = "200" ]; then
    CHAT_ID=$(python3 - "$existing_meta" <<'PY' 2>>"$LOG_FILE"
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    chat_id = data.get("chat_id")
    if isinstance(chat_id, str) and chat_id.strip():
        print(chat_id.strip())
except Exception:
    pass
PY
)
  fi

  if [ -n "$CHAT_ID" ]; then
    log "Preserving legacy report chat id for $TODAY (chat_id=$CHAT_ID)"
  fi

  python3 - "$meta_payload" "$CHAT_ID" "$TODAY" "$PROVIDER" "$MODEL" "$status" <<'PY' 2>>"$LOG_FILE"
import json
import sys
from datetime import datetime, timezone

out_path, chat_id, today, provider, model, status = sys.argv[1:7]
payload = {
    # null unless a prior run already linked a chat to this date; the app
    # opens the main chat on demand when this is absent.
    "chat_id": chat_id or None,
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
    log "Report metadata saved (status=$status)"
  else
    log "WARN: failed to save report metadata (HTTP $META_CODE)"
  fi
}

existing_ready_report() {
  existing_meta="$WORK_DIR/existing-ready-meta.json"
  existing_html="$WORK_DIR/existing-ready-report.html"
  EXISTING_META_CODE=$(curl -sS -o "$existing_meta" -w "%{http_code}" \
    -X GET "$REPORT_META_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN") || EXISTING_META_CODE=000
  if [ "$EXISTING_META_CODE" = "200" ]; then
    EXISTING_STATUS=$(python3 - "$existing_meta" <<'PY' 2>>"$LOG_FILE"
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    status = data.get("status")
    if isinstance(status, str):
        print(status)
except Exception:
    pass
PY
)
    if [ "$EXISTING_STATUS" = "ready" ]; then
      return 0
    fi
  fi

  EXISTING_HTML_CODE=$(curl -sS -o "$existing_html" -w "%{http_code}" \
    -X GET "$REPORT_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN") || EXISTING_HTML_CODE=000
  if [ "$EXISTING_HTML_CODE" = "200" ]; then
    if ! grep -Eqi "Today's digest could not be generated|<h2>Diagnostics</h2>|couldn't be generated|digest unavailable" "$existing_html"; then
      return 0
    fi
  fi
  return 1
}

run_agent_cli() {
  local selected_provider="$1"
  local selected_model="$2"
  local selected_effort="$3"
  : > "$RAW_OUTPUT"
  if [ "$selected_provider" = "claude" ]; then
    if ! command -v claude >/dev/null 2>&1; then
      log "ERROR: provider=claude but claude CLI not installed"
      return 127
    fi
    if [ -n "$selected_effort" ]; then
      log "Invoking claude CLI (effort=$selected_effort)"
    else
      log "Invoking claude CLI"
    fi
    # WebSearch + WebFetch — both read-only research tools. No Bash, no
    # Write: the agent can read pages it cites (for og:image/lead images)
    # but has no path to write to disk. See the security-model note above.
    # --model is appended only when MODEL is non-empty so omitting it
    # falls back to the CLI's default.
    local CLAUDE_FLAGS=(
      --system-prompt-file "$PROMPT_FILE"
      --allowedTools "WebSearch,WebFetch"
      --max-turns 30
    )
    if [ -n "$selected_model" ]; then
      CLAUDE_FLAGS+=(--model "$selected_model")
    fi
    if [ -n "$selected_effort" ]; then
      local claude_effort="$selected_effort"
      if [ "$claude_effort" = "ultracode" ]; then
        claude_effort="xhigh"
      fi
      CLAUDE_FLAGS+=(--effort "$claude_effort")
    fi
    timeout "$NEWS_TIMEOUT" env CLAUDE_CONFIG_DIR=/data/cli-auth/claude claude -p "$USER_TURN" \
      "${CLAUDE_FLAGS[@]}" \
      > "$RAW_OUTPUT" 2>>"$LOG_FILE"
    return $?
  fi

  if ! command -v codex >/dev/null 2>&1; then
    log "ERROR: provider=codex but codex CLI not installed"
    return 127
  fi
  if [ -n "$selected_effort" ]; then
    log "Invoking codex CLI (effort=$selected_effort)"
  else
    log "Invoking codex CLI"
  fi
  local PROMPT_BODY
  PROMPT_BODY=$(cat "$PROMPT_FILE")
  # codex exec accepts --model <MODEL> (also -m). Append only when
  # set; otherwise codex uses the default from ~/.codex/config.toml.
  # Per-invocation hardening (closes the residual risk ticket 068 flagged
  # for this path): --sandbox read-only means any shell command the model
  # is induced to run — e.g. via a prompt-injection planted in a search
  # result — executes with NO disk-write and NO network access, so it
  # can't write to disk or exfiltrate. The built-in WebSearch tool is not
  # a sandboxed shell command, so it still works. Codex lacks Claude's
  # per-tool allowlist; read-only sandbox is the lever instead. Note the
  # Claude path now also allows WebFetch (for embedding og:image/lead
  # images from cited pages), but read-only sandbox blocks Codex from
  # fetching arbitrary urls, so inline images land mainly on the Claude
  # provider — Codex digests stay text/diagram-only, which is fine.
  local CODEX_FLAGS=(exec --json --sandbox read-only)
  if [ -n "$selected_model" ]; then
    CODEX_FLAGS+=(--model "$selected_model")
  fi
  if [ -n "$selected_effort" ]; then
    case "$selected_effort" in
      none|minimal|low|medium|high|xhigh)
        CODEX_FLAGS+=(-c "model_reasoning_effort=\"$selected_effort\"")
        ;;
    esac
  fi
  CODEX_FLAGS+=(-)
  printf '%s\n\n---\n\n%s\n' "$PROMPT_BODY" "$USER_TURN" \
    | timeout "$NEWS_TIMEOUT" env CODEX_HOME=/data/cli-auth/codex codex "${CODEX_FLAGS[@]}" > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  return $?
}

run_agent_cli "$PROVIDER" "$MODEL" "$EFFORT"
CLI_EXIT=$?
if [ "$CLI_EXIT" -ne 0 ] && [ "$CLI_EXIT" -ne 124 ] && [ -n "$FALLBACK_PROVIDER" ]; then
  if [ "$FALLBACK_PROVIDER" != "$PROVIDER" ] || [ "$FALLBACK_MODEL" != "$MODEL" ] || [ "$FALLBACK_EFFORT" != "$EFFORT" ]; then
    if [ -n "$FALLBACK_EFFORT" ]; then
      log "Primary agent failed with code $CLI_EXIT; trying fallback provider=$FALLBACK_PROVIDER effort=$FALLBACK_EFFORT"
    else
      log "Primary agent failed with code $CLI_EXIT; trying fallback provider=$FALLBACK_PROVIDER"
    fi
    PROVIDER="$FALLBACK_PROVIDER"
    MODEL="$FALLBACK_MODEL"
    EFFORT="$FALLBACK_EFFORT"
    run_agent_cli "$PROVIDER" "$MODEL" "$EFFORT"
    CLI_EXIT=$?
  fi
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

# In-report question carrier. The agent emits ONE inert JSON carrier as a
# sibling AFTER </article> (see system-prompt "questions for next time").
# The article-only extraction above would drop it, and the HTML sanitizer
# below strips <script>, so we handle the carrier OUT OF BAND here: parse +
# validate its JSON, then re-emit a CANONICAL carrier built from the parsed
# data (never passing the agent's raw <script> bytes through). A malformed
# or absent carrier yields "" — the report ships without questions, never
# broken. Caps mirror the app's sanitizeQuestions (3 questions, 6 options).
def extract_question_carrier(src):
  m = re.search(
    r'<script\b[^>]*type=["\']application/mobius-questions\+json["\'][^>]*>'
    r'([\s\S]*?)</script>', src, re.I)
  if not m:
    return ""
  try:
    payload = json.loads(m.group(1).strip())
  except Exception:
    return ""
  raw_qs = payload.get("questions") if isinstance(payload, dict) else None
  if not isinstance(raw_qs, list):
    return ""
  questions = []
  for raw in raw_qs:
    if len(questions) >= 3:
      break
    if not isinstance(raw, dict):
      continue
    q = raw.get("question")
    q = q.strip() if isinstance(q, str) else ""
    if not q:
      continue
    opts = raw.get("options") if isinstance(raw.get("options"), list) else []
    options = []
    for o in opts:
      if len(options) >= 6:
        break
      if not isinstance(o, dict):
        continue
      label = o.get("label")
      label = label.strip() if isinstance(label, str) else ""
      if not label:
        continue
      entry = {"label": label}
      desc = o.get("description")
      if isinstance(desc, str) and desc.strip():
        entry["description"] = desc.strip()
      options.append(entry)
    if not options:
      continue
    header = raw.get("header")
    questions.append({
      "question": q,
      "header": header.strip() if isinstance(header, str) else "",
      "multiSelect": raw.get("multiSelect") is True,
      "options": options,
    })
  if not questions:
    return ""
  # Re-emit the canonical carrier. The JSON is escaped so it can't break out
  # of the <script> or smuggle markup; the app reads it back with JSON.parse.
  blob = json.dumps({"version": 1, "questions": questions}, ensure_ascii=False)
  blob = blob.replace("<", "\\u003c").replace(">", "\\u003e")
  return (
    '\n<section class="report-questions" data-report-questions>'
    "<h2>A few questions for next time</h2>"
    '<p class="rq-note">Your answers guide my next digest — '
    "they won’t change this one.</p>"
    '<script type="application/mobius-questions+json">'
    + blob +
    "</script></section>"
  )

question_carrier = extract_question_carrier(text)

class Sanitizer(HTMLParser):
  allowed = {
    "article", "header", "h1", "details", "summary", "section", "p",
    "h2", "h3", "h4",
    "a", "ul", "ol", "li", "blockquote", "strong", "em", "b", "i",
    "span", "time", "br", "div", "figure", "figcaption", "img", "table",
    "thead", "tbody", "tr", "th", "td", "svg", "g", "path", "circle",
    "rect", "line", "polyline", "text",
  }
  void = {"br", "img"}
  def __init__(self):
    super().__init__(convert_charrefs=True)
    self.out = []
    self.skip = []
    self.text = []
    # The first <details> is the "Today at a glance" card (forced open);
    # any later one is a collapsed long-tail drill-down. Tracked here so
    # the class rewrite below can tell them apart.
    self.summary_emitted = False
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
      # First details = the summary card, always open. The rest are
      # long-tail drill-downs, collapsed unless the agent opened them.
      if not self.summary_emitted:
        clean.append(('class', 'news-report__summary'))
        clean.append(('open', ''))
        self.summary_emitted = True
      else:
        clean.append(('class', 'news-report__more'))
        if "open" in attrs:
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
    elif tag == "img":
      # Only https image URLs, plus alt and optional numeric width/height.
      # An img with no usable https src is dropped entirely (a curator that
      # guessed a url shouldn't leave a broken-image box in the digest).
      src = (attrs.get("src") or "").strip()
      try:
        from urllib.parse import urlsplit
        parts = urlsplit(src)
        src_ok = parts.scheme.lower() == "https" and bool(parts.netloc)
      except Exception:
        src_ok = False
      if not src_ok:
        return
      clean.append(("src", src))
      alt = attrs.get("alt")
      if isinstance(alt, str):
        clean.append(("alt", alt))
      for dim in ("width", "height"):
        value = (attrs.get(dim) or "").strip()
        if re.match(r"^\d{1,4}$", value):
          clean.append((dim, value))
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

# Append the validated question carrier (if any) AFTER the sanitized
# article, as a sibling. The app extracts + strips it before rendering the
# iframe; the inert <script> never executes (sandboxed null origin) and the
# JSON was rebuilt by us, not passed through from the agent.
clean = clean + question_carrier

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
    write_report_meta "ready"
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
    emit_cron_summary "ok" 0 1 "digest saved"
    write_run_status "ok" "digest saved"
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

# 7. PUT the error report only if this is a first-run failure or the existing
#    same-day report is already an error. A failed same-day rerun must not
#    replace a good ready digest.
PRESERVED_READY=0
if existing_ready_report; then
  PRESERVED_READY=1
  log "Existing ready digest for $TODAY preserved; not overwriting with error report."
else
  PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$REPORT_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: text/html; charset=utf-8" \
    --data-binary @"$ERROR_FILE") || PUT_CODE=000

  if [ "$PUT_CODE" != "200" ] && [ "$PUT_CODE" != "201" ] && [ "$PUT_CODE" != "204" ]; then
    log "ERROR: failed to save error report (HTTP $PUT_CODE)"
    emit_cron_summary "error" "$CLI_EXIT" 0 "failed to save error report HTTP $PUT_CODE"
    write_run_status "error" "failed to save error report HTTP $PUT_CODE"
    exit 1
  fi

  log "Error report saved (HTTP $PUT_CODE)"
  write_report_meta "error"
fi

# 8. Notify — honestly. A first-run failure writes visible diagnostics; a
#    failed rerun after a ready digest tells the owner that the existing digest
#    was left in place.
if [ "$PRESERVED_READY" -eq 1 ]; then
  NOTIFY_BODY="Today's rerun for $TODAY failed; your existing digest was left in place."
else
  NOTIFY_BODY="Today's digest for $TODAY couldn't be generated — open for details."
fi

curl -sS -X POST "$API_BASE_URL/api/notifications/send" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"News digest unavailable\",
    \"body\": \"$NOTIFY_BODY\",
    \"source_type\": \"app\",
    \"source_id\": \"$APP_ID\",
    \"target\": \"/shell/?app=$APP_ID\",
    \"actions\": [
      {\"action\": \"open_app\", \"title\": \"Details\", \"target\": \"/shell/?app=$APP_ID\"}
    ]
  }" >> "$LOG_FILE" 2>&1

log "Done."
emit_cron_summary "error" "$CLI_EXIT" 0 "digest generation failed"
# Terminal for BOTH the error-report-saved path and the preserved-good-digest
# failure (PRESERVED_READY=1). NOTIFY_BODY already carries the honest,
# case-specific message, so the poll's error banner reads the same as the push.
write_run_status "error" "$NOTIFY_BODY"
exit 1
