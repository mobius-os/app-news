#!/bin/bash
# App-owned lifecycle for News's optional Pocket TTS service.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ACTION="${1:-ensure}"
APP_ID="${2:-}"
if [[ ! "$APP_ID" =~ ^[0-9]+$ ]]; then
  echo "tts-service.sh: numeric APP_ID required" >&2
  exit 2
fi

SLUG="news-tts-$APP_ID"
PORT="${NEWS_TTS_PORT:-8791}"
# The virtualenv and model weights are disposable, reconstructible cache. Keep
# them outside durable app storage so Pocket TTS's ~1.4 GB install cannot consume
# News's 1 GB allowance for reports, preferences, and control markers.
RUNTIME_ROOT="/data/compiled/news-tts-$APP_ID"
VENV="$RUNTIME_ROOT/venv"
CACHE="$RUNTIME_ROOT/cache"
PID_FILE="$RUNTIME_ROOT/server.pid"
LOG_FILE="$RUNTIME_ROOT/server.log"
HEALTH_URL="http://127.0.0.1:$PORT/services/$SLUG/health"
CONFIG_FILE="/data/local-services.json"
CONFIG_LOCK="/data/local-services.lock"

configure_proxy() {
  python3 - "$CONFIG_FILE" "$CONFIG_LOCK" "$SLUG" "$PORT" <<'PY'
import fcntl
import json
import os
import sys
import tempfile

path, lock_path, slug, port = sys.argv[1:5]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(lock_path, "a", encoding="utf-8") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    try:
        with open(path, encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, ValueError, TypeError):
        value = {"version": 1, "services": {}}
    if value.get("version") != 1 or not isinstance(value.get("services"), dict):
        raise SystemExit("local-services.json is not a version 1 service registry")
    expected = {
        "upstream": f"http://127.0.0.1:{int(port)}",
        "access": "upstream_auth",
    }
    if value["services"].get(slug) == expected:
        raise SystemExit(0)
    value["services"][slug] = expected
    fd, temporary = tempfile.mkstemp(prefix=".local-services.", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            # Preserve sibling-service ordering so enabling News does not
            # manufacture unrelated changes in the shared registry.
            json.dump(value, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass
PY
}

healthy() {
  curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
}

verified_pid() {
  [[ -r "$PID_FILE" ]] || return 1
  local pid cmdline
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  [[ "$cmdline" == *"uvicorn tts_server:app"* && "$cmdline" == *"--port $PORT"* ]] || return 1
  printf '%s' "$pid"
}

stop_service() {
  local pid
  if pid=$(verified_pid); then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      [[ ! -r "/proc/$pid/cmdline" ]] && break
      sleep 0.1
    done
    if [[ -r "/proc/$pid/cmdline" ]]; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$PID_FILE"
}

install_runtime() {
  mkdir -p "$RUNTIME_ROOT" "$CACHE"
  if [[ -x "$VENV/bin/python" ]] && "$VENV/bin/python" -c 'import pocket_tts' >/dev/null 2>&1; then
    return 0
  fi
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install --disable-pip-version-check --no-input \
    --index-url https://download.pytorch.org/whl/cpu 'torch>=2.5'
  "$VENV/bin/python" -m pip install --disable-pip-version-check --no-input \
    -r "$SCRIPT_DIR/tts-requirements.txt"
}

ensure_service() {
  mkdir -p "$RUNTIME_ROOT" "$CACHE"
  configure_proxy
  touch "$RUNTIME_ROOT/keepalive"
  if healthy; then return 0; fi
  local pid
  if pid=$(verified_pid); then
    # A live verified process may still be loading the model. Give it one
    # bounded grace window instead of stacking a second 850 MB runtime.
    for _ in $(seq 1 120); do
      healthy && return 0
      [[ -r "/proc/$pid/cmdline" ]] || break
      sleep 1
    done
    stop_service
  else
    rm -f "$PID_FILE"
  fi
  install_runtime
  : > "$LOG_FILE"
  (
    cd "$SCRIPT_DIR"
    export NEWS_APP_ID="$APP_ID"
    export NEWS_TTS_RUNTIME="$RUNTIME_ROOT"
    export HF_HOME="$CACHE"
    export HF_HUB_CACHE="$CACHE/hub"
    export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8000}"
    setsid nohup "$VENV/bin/python" -m uvicorn tts_server:app \
      --host 127.0.0.1 --port "$PORT" --log-level warning \
      >> "$LOG_FILE" 2>&1 < /dev/null &
    echo "$!" > "$PID_FILE"
  )
  for _ in $(seq 1 180); do
    healthy && return 0
    sleep 1
  done
  echo "News TTS did not become healthy; see $LOG_FILE" >&2
  return 1
}

case "$ACTION" in
  ensure) ensure_service ;;
  stop) stop_service ;;
  status) healthy ;;
  *) echo "usage: tts-service.sh {ensure|stop|status} APP_ID" >&2; exit 2 ;;
esac
