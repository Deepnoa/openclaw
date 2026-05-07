#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

try:
    from scripts.runtime.contract.runtime_contract import EVENT_LOG_FILENAME
except ModuleNotFoundError:
    from contract.runtime_contract import EVENT_LOG_FILENAME

EVENT_LOG_PATH = Path(f"/home/deepnoa/openclaw/runs/{EVENT_LOG_FILENAME}")


def log_runtime_event(
    *,
    component: str,
    event_type: str,
    task_id: str | None = None,
    role: str | None = None,
    status: str | None = None,
    exit_code: int | None = None,
    runtime_status: str | None = None,
    route_reason: str | None = None,
) -> None:
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "component": component,
        "event_type": event_type,
        "task_id": task_id,
        "role": role,
        "status": status,
        "exit_code": exit_code,
        "runtime_status": runtime_status,
        "route_reason": route_reason,
    }
    try:
        EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with EVENT_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        # Logging must not affect runtime flow.
        return
