#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

try:
    from scripts.runtime.contract.runtime_contract import STATUS_FAILED
except ModuleNotFoundError:
    from contract.runtime_contract import STATUS_FAILED

RUNTIME_DIR = "/home/deepnoa/deepnoa-agent-runtime"
PYTHON_BIN = f"{RUNTIME_DIR}/.venv/bin/python"
RUN_SCRIPT = f"{RUNTIME_DIR}/scripts/run_agent.py"


def run_runtime(role: str, task_id: str, payload: dict) -> dict:
    tmp_dir = Path("/tmp/openclaw")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    input_path = tmp_dir / f"task-{task_id}.json"
    output_path = Path(RUNTIME_DIR) / f"runs/{task_id}/result.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    cmd = [
        PYTHON_BIN,
        RUN_SCRIPT,
        "--role",
        role,
        "--task-id",
        task_id,
        "--input",
        str(input_path),
        "--output",
        str(output_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    try:
        result = json.loads(proc.stdout)
    except Exception:
        result = {
            "status": STATUS_FAILED,
            "error": "stdout_json_parse_error",
            "raw_stdout": proc.stdout,
        }
    return {
        "exit_code": proc.returncode,
        "result": result,
        "stderr": proc.stderr,
    }
