#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.runtime.contract.runtime_contract import (
    EVENT_LOG_FILENAME,
    EVENT_RUNTIME_STUCK_WARNING,
    STATUS_RUNNING,
)
from scripts.runtime.core.runtime_event_logger import log_runtime_event

EVENT_LOG_PATH = Path(f"/home/deepnoa/openclaw/runs/{EVENT_LOG_FILENAME}")
RUN_START_EVENTS = {"runtime.started", "runtime.retry_started"}
TERMINAL_EVENTS = {
    "runtime.completed",
    "runtime.failed",
    "runtime.retry_completed",
    "runtime.retry_failed",
    "runtime.queued",
    "runtime.requeued",
    "runtime.exit",
    "runtime.offline",
}
DEFAULT_THRESHOLD_SECONDS = 300


@dataclass
class RunningTask:
    task_id: str
    role: str | None
    started_at: datetime
    last_event_type: str
    warning_after_start: bool = False


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _load_events() -> list[dict[str, Any]]:
    if not EVENT_LOG_PATH.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in EVENT_LOG_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            events.append(item)
    return events


def detect_stuck_tasks(*, threshold_seconds: int = DEFAULT_THRESHOLD_SECONDS) -> dict[str, Any]:
    events = _load_events()
    running: dict[str, RunningTask] = {}
    warnings_emitted = 0
    now = datetime.now(timezone.utc)
    threshold = timedelta(seconds=max(threshold_seconds, 1))

    for event in events:
        task_id = str(event.get("task_id") or "").strip()
        if not task_id:
            continue
        event_type = str(event.get("event_type") or "").strip()
        ts = _parse_ts(event.get("timestamp"))
        if ts is None:
            continue
        if event_type in RUN_START_EVENTS:
            running[task_id] = RunningTask(
                task_id=task_id,
                role=str(event.get("role") or "").strip() or None,
                started_at=ts,
                last_event_type=event_type,
            )
            continue
        if event_type == EVENT_RUNTIME_STUCK_WARNING:
            current = running.get(task_id)
            if current and ts >= current.started_at:
                current.warning_after_start = True
                current.last_event_type = event_type
            continue
        if event_type in TERMINAL_EVENTS:
            running.pop(task_id, None)
            continue
        current = running.get(task_id)
        if current and ts >= current.started_at:
            current.last_event_type = event_type

    stuck: list[dict[str, Any]] = []
    for task in running.values():
        age = now - task.started_at
        if age < threshold:
            continue
        age_seconds = int(age.total_seconds())
        stuck.append(
            {
                "task_id": task.task_id,
                "role": task.role,
                "started_at": task.started_at.isoformat(),
                "age_seconds": age_seconds,
                "last_event_type": task.last_event_type,
                "warning_emitted": task.warning_after_start,
            }
        )
        if task.warning_after_start:
            continue
        log_runtime_event(
            component="runtime",
            event_type=EVENT_RUNTIME_STUCK_WARNING,
            task_id=task.task_id,
            role=task.role,
            status=STATUS_RUNNING,
            exit_code=None,
            runtime_status="stuck",
            route_reason=f"running_for:{age_seconds}s",
        )
        warnings_emitted += 1

    return {
        "checked": len(events),
        "running": len(running),
        "stuck": len(stuck),
        "warnings_emitted": warnings_emitted,
        "tasks": stuck,
    }


def main() -> int:
    threshold_seconds = DEFAULT_THRESHOLD_SECONDS
    if len(sys.argv) > 1:
        try:
            threshold_seconds = int(sys.argv[1])
        except ValueError:
            print("usage: detect_stuck_runtime_tasks.py [threshold_seconds]", file=sys.stderr)
            return 2
    result = detect_stuck_tasks(threshold_seconds=threshold_seconds)
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result["stuck"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
