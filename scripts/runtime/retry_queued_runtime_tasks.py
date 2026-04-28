#!/usr/bin/env python3
from __future__ import annotations

import json
from typing import Any

from ollama_health import check_ollama_health
from runtime_event_logger import log_runtime_event
from runtime_queue import load_queue_items, now_iso, write_queue_items
from runtime_runner import run_runtime


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _runtime_status(runtime_result: dict[str, Any]) -> tuple[str, int]:
    result = runtime_result.get("result")
    if not isinstance(result, dict):
        return "unknown", 1
    status = str(result.get("status") or "unknown")
    exit_code = runtime_result.get("exit_code")
    return status, exit_code if isinstance(exit_code, int) else 1


def _save(items: list[dict[str, Any]]) -> None:
    write_queue_items(items)


def main() -> int:
    items = load_queue_items()
    queued = [item for item in items if str(item.get("status") or "") == "queued"]
    if not queued:
        print("queued=0")
        return 0

    health = check_ollama_health()
    if not health.get("online"):
        detail = str(health.get("detail") or "offline")
        for item in queued:
            log_runtime_event(
                component="runtime",
                event_type="runtime.offline",
                task_id=str(item.get("task_id") or "") or None,
                role=str(item.get("role") or "") or None,
                status="queued",
                exit_code=None,
                runtime_status="offline",
                route_reason=f"sense_offline:{detail}",
            )
        print(f"queued={len(queued)} online=false detail={detail}")
        return 1

    completed = 0
    failed = 0
    requeued = 0

    for item in items:
        if str(item.get("status") or "") != "queued":
            continue
        task_id = str(item.get("task_id") or "").strip()
        role = str(item.get("role") or "dev").strip() or "dev"
        max_attempts = max(_as_int(item.get("max_attempts"), 5), 1)
        attempts = _as_int(item.get("attempts"), 0)
        if attempts >= max_attempts:
            item["status"] = "failed"
            item["updated_at"] = now_iso()
            item["reason"] = "max_attempts_exceeded"
            failed += 1
            log_runtime_event(
                component="runtime",
                event_type="runtime.retry_failed",
                task_id=task_id or None,
                role=role,
                status="failed",
                exit_code=None,
                runtime_status="failed",
                route_reason="max_attempts_exceeded",
            )
            _save(items)
            continue

        next_attempt = attempts + 1
        item["attempts"] = next_attempt
        item["updated_at"] = now_iso()
        log_runtime_event(
            component="runtime",
            event_type="runtime.retry_started",
            task_id=task_id or None,
            role=role,
            status="running",
            exit_code=None,
            runtime_status="retrying",
            route_reason=f"attempt_{next_attempt}",
        )
        _save(items)

        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        runtime_result = run_runtime(role=role, task_id=task_id, payload=payload)
        status, exit_code = _runtime_status(runtime_result)
        result_obj = runtime_result.get("result") if isinstance(runtime_result.get("result"), dict) else {}

        if exit_code == 0 and status == "completed":
            item["status"] = "completed"
            item["updated_at"] = now_iso()
            item["reason"] = "retry_completed"
            completed += 1
            log_runtime_event(
                component="runtime",
                event_type="runtime.retry_completed",
                task_id=task_id or None,
                role=role,
                status="completed",
                exit_code=exit_code,
                runtime_status=status,
                route_reason=None,
            )
        else:
            item["status"] = "failed" if next_attempt >= max_attempts else "queued"
            item["updated_at"] = now_iso()
            item["reason"] = "runtime_retry_failed"
            item["last_error"] = {
                "status": status,
                "exit_code": exit_code,
                "stderr": runtime_result.get("stderr") or "",
                "result": result_obj,
            }
            if item["status"] == "failed":
                failed += 1
            else:
                requeued += 1
            log_runtime_event(
                component="runtime",
                event_type="runtime.retry_failed",
                task_id=task_id or None,
                role=role,
                status=str(item["status"]),
                exit_code=exit_code,
                runtime_status=status,
                route_reason="runtime_retry_failed",
            )
        _save(items)

    print(json.dumps({"completed": completed, "failed": failed, "requeued": requeued}, ensure_ascii=False))
    return 0 if failed == 0 and requeued == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
