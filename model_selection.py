#!/usr/bin/env python3
"""One-way migration for model ids stored in News agent settings."""

from __future__ import annotations

import json
from pathlib import Path
import sys

RETIRED_MODEL_IDS = {
  "claude-opus-4-5-20251001": "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20251001": "claude-sonnet-4-5-20250929",
  "claude-opus-4-6-20251015": "claude-opus-4-6",
  "claude-opus-4-7-20251215": "claude-opus-4-7",
  "claude-sonnet-4-7-20251215": "claude-sonnet-4-6",
}


def migrate_agent_models(settings: object) -> tuple[object, bool]:
  if not isinstance(settings, dict):
    return settings, False
  migrated = dict(settings)
  changed = False
  for key in ("model", "fallback_model"):
    replacement = RETIRED_MODEL_IDS.get(settings.get(key))
    if replacement:
      migrated[key] = replacement
      changed = True
  return (migrated, True) if changed else (settings, False)


def migrate_file(path: Path) -> bool:
  try:
    value = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, ValueError):
    return False
  migrated, changed = migrate_agent_models(value)
  if changed:
    path.write_text(json.dumps(migrated, separators=(",", ":")), encoding="utf-8")
  return changed


if __name__ == "__main__":
  print("changed" if migrate_file(Path(sys.argv[1])) else "unchanged")
