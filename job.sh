#!/bin/bash
# News's minute-level app job owns two app concerns:
#   1. keep an already-requested Pocket TTS service alive while enabled;
#   2. launch the daily digest at the owner-selected wall-clock time.
# Manual report and first-listen requests place explicit intent markers before
# triggering this job. Scheduled runs never install speech on their own.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ID="${1:-}"
if [[ ! "$APP_ID" =~ ^[0-9]+$ ]]; then
  echo "job.sh: numeric APP_ID required" >&2
  exit 2
fi

STORAGE_DIR="/data/apps/$APP_ID"
CONTROL_DIR="$STORAGE_DIR/control"
RUNTIME_DIR="/data/compiled/news-tts-$APP_ID"
mkdir -p "$CONTROL_DIR"

claim_marker() {
  local name="$1"
  local claim="$CONTROL_DIR/$name.claim.$$"
  if mv "$CONTROL_DIR/$name.json" "$claim" 2>/dev/null; then
    rm -f "$claim"
    return 0
  fi
  return 1
}

tts_requested=0
if claim_marker "tts-run"; then
  tts_requested=1
fi

tts_enabled=$(python3 - "$STORAGE_DIR/preferences.json" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8"))
    print("1" if value.get("tts", {}).get("enabled") is True else "0")
except Exception:
    print("0")
PY
)
if [[ "$tts_enabled" == "1" ]]; then
  if "$SCRIPT_DIR/tts-service.sh" status "$APP_ID"; then
    mkdir -p "$RUNTIME_DIR"
    touch "$RUNTIME_DIR/keepalive"
  elif [[ "$tts_requested" == "1" ]]; then
    "$SCRIPT_DIR/tts-service.sh" ensure "$APP_ID" || true
  fi
else
  "$SCRIPT_DIR/tts-service.sh" stop "$APP_ID" || true
fi

manual=0
if claim_marker "report-run"; then
  manual=1
fi

due=$(python3 - "$STORAGE_DIR/schedule.json" "$CONTROL_DIR/last-scheduled-date.txt" <<'PY'
import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

schedule_path, state_path = sys.argv[1:3]
try:
    value = json.load(open(schedule_path, encoding="utf-8"))
except Exception:
    value = {}
hour = int(value.get("hour", 10))
minute = int(value.get("minute", 0))
timezone = value.get("timezone") or "UTC"
try:
    now = datetime.now(ZoneInfo(timezone))
except Exception:
    now = datetime.now(ZoneInfo("UTC"))
date = now.date().isoformat()
try:
    last = open(state_path, encoding="utf-8").read().strip()
except OSError:
    last = ""
if now.hour == hour and now.minute == minute and last != date:
    temporary = state_path + f".tmp.{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as output:
        output.write(date + "\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, state_path)
    print("1")
else:
    print("0")
PY
)

if [[ "$manual" == "1" || "$due" == "1" ]]; then
  NEWS_JOB_DISPATCHED=1 exec "$SCRIPT_DIR/fetch.sh" "$APP_ID"
fi
