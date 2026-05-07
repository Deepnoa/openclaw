#!/usr/bin/env python3
from __future__ import annotations

import json
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from scripts.runtime.contract.runtime_contract import QUEUE_FILENAME

QUEUE_PATH = Path(f"/home/deepnoa/openclaw/runs/{QUEUE_FILENAME}")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_queue_items() -> list[dict[str, Any]]:
    if not QUEUE_PATH.exists():
        return []
    latest: OrderedDict[str, dict[str, Any]] = OrderedDict()
    for raw_line in QUEUE_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict):
            continue
        task_id = str(item.get("task_id") or "").strip()
        if not task_id:
            continue
        latest.pop(task_id, None)
        latest[task_id] = item
    return list(latest.values())


def write_queue_items(items: list[dict[str, Any]]) -> None:
    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=str(QUEUE_PATH.parent)) as tmp:
        for item in items:
            tmp.write(json.dumps(item, ensure_ascii=False) + "\n")
        temp_path = Path(tmp.name)
    temp_path.replace(QUEUE_PATH)
