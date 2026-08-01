"""App-owned Pocket TTS service for News.

The generic Möbius local-service proxy forwards requests here, but owns none
of the speech behavior. Each synthesis request proves it carries this News
instance's app token before the model does any work.
"""

from __future__ import annotations

import io
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from pocket_tts.data.audio import stream_audio_chunks
from pocket_tts.models.tts_model import TTSModel


APP_ID = int(os.environ["NEWS_APP_ID"])
API_BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
MOUNT_PATH = f"/services/news-tts-{APP_ID}"
RUNTIME_ROOT = Path(os.environ.get("NEWS_TTS_RUNTIME", f"/data/compiled/news-tts-{APP_ID}"))
HEARTBEAT_PATH = RUNTIME_ROOT / "keepalive"
HEARTBEAT_MAX_AGE_SECONDS = 180
MAX_TEXT_CHARS = 8_000

log = logging.getLogger("news.tts")
app = FastAPI(title="News Pocket TTS", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_methods=["GET", "POST", "OPTIONS"],
  allow_headers=["Content-Type"],
)


class SpeechRequest(BaseModel):
  text: str
  language: str = "english"
  app_token: str


class QueueWriter(io.IOBase):
  def __init__(self, output: queue.Queue):
    self.output = output

  def writable(self):
    return True

  def write(self, data):
    payload = bytes(data)
    if payload:
      self.output.put(payload)
    return len(payload)

  def flush(self):
    return None

  def close(self):
    # The generation worker owns the terminal sentinel so errors cannot be
    # hidden by an early file-like close.
    return None


def _app_token_is_valid(token: str) -> bool:
  if not token or len(token) > 16_384:
    return False
  request = urllib.request.Request(
    f"{API_BASE_URL}/api/storage/apps/{APP_ID}/preferences.json",
    headers={"Authorization": f"Bearer {token}"},
  )
  try:
    with urllib.request.urlopen(request, timeout=8) as response:
      return response.status == 200
  except (OSError, urllib.error.URLError, urllib.error.HTTPError):
    return False


def _heartbeat_watchdog():
  while True:
    time.sleep(30)
    try:
      age = time.time() - HEARTBEAT_PATH.stat().st_mtime
    except OSError:
      age = HEARTBEAT_MAX_AGE_SECONDS + 1
    if age > HEARTBEAT_MAX_AGE_SECONDS:
      log.info("News TTS keepalive expired; stopping app-owned service")
      os._exit(0)


RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
model = TTSModel.load_model(language="english")
voice_state = model.get_state_for_audio_prompt("alba")
generation_lock = threading.Lock()
threading.Thread(target=_heartbeat_watchdog, name="news-tts-watchdog", daemon=True).start()


def _wav_stream(text: str):
  # Do not bound this transport queue: if a phone cancels mid-segment,
  # Starlette closes the response iterator. A bounded queue would then strand
  # the generation thread holding the single-model lock forever. One semantic
  # report block is capped at 8,000 characters, so finishing that block in an
  # unbounded in-process queue has a strict, modest ceiling and lets the next
  # request proceed.
  output: queue.Queue = queue.Queue()
  finished = object()

  def generate():
    try:
      with generation_lock:
        chunks = model.generate_audio_stream(voice_state, text)
        stream_audio_chunks(QueueWriter(output), chunks, model.config.mimi.sample_rate)
    except BaseException:  # Streaming has already started; log and end honestly.
      log.exception("Pocket TTS generation failed")
    finally:
      output.put(finished)

  worker = threading.Thread(target=generate, name="news-tts-generation", daemon=True)
  worker.start()
  while True:
    item = output.get()
    if item is finished:
      break
    yield item
  worker.join()


@app.get(f"{MOUNT_PATH}/health")
def health():
  return {"status": "healthy", "app_id": APP_ID, "language": "english"}


@app.post(f"{MOUNT_PATH}/tts")
def synthesize(
  payload: SpeechRequest,
):
  if not _app_token_is_valid(payload.app_token):
    raise HTTPException(status_code=403, detail="This speech request is not authorized for News.")
  text = " ".join(payload.text.split()).strip()
  if not text:
    raise HTTPException(status_code=400, detail="Speech text is empty.")
  if len(text) > MAX_TEXT_CHARS:
    raise HTTPException(status_code=413, detail="Speech text is too long.")
  if payload.language != "english":
    raise HTTPException(status_code=400, detail="News currently speaks English only.")
  return StreamingResponse(
    _wav_stream(text),
    media_type="audio/wav",
    headers={"Cache-Control": "no-store"},
  )
