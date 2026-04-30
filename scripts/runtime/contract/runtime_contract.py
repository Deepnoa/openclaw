#!/usr/bin/env python3
from __future__ import annotations

# Task id contract
TASK_ID_PREFIX_DOCREQ = "docreq-"


def build_docreq_task_id(inquiry_id: str) -> str:
    return f"{TASK_ID_PREFIX_DOCREQ}{inquiry_id}"


# Queue/runtime status contract
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_UNKNOWN = "unknown"
STATUS_RETRYING = "retrying"
STATUS_OFFLINE = "offline"


# Runtime event contract
EVENT_RUNTIME_STARTED = "runtime.started"
EVENT_RUNTIME_COMPLETED = "runtime.completed"
EVENT_RUNTIME_FAILED = "runtime.failed"
EVENT_RUNTIME_OFFLINE = "runtime.offline"
EVENT_RUNTIME_RETRY_STARTED = "runtime.retry_started"
EVENT_RUNTIME_RETRY_COMPLETED = "runtime.retry_completed"
EVENT_RUNTIME_RETRY_FAILED = "runtime.retry_failed"
EVENT_RUNTIME_STUCK_WARNING = "runtime.stuck_warning"


# Result schema contract
RESULT_TYPE_REPLY_DRAFT = "reply_draft"


# File contract
QUEUE_FILENAME = "queued-runtime-tasks.jsonl"
EVENT_LOG_FILENAME = "runtime-events.jsonl"
