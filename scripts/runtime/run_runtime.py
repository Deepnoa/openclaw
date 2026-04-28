#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Thin runtime entrypoint wrapper.")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--role", default="dev")
    parser.add_argument("--payload-json", default="{}")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    payload = json.loads(args.payload_json)

    from scripts.runtime.core.runtime_runner import run_runtime

    result = run_runtime(role=args.role, task_id=args.task_id, payload=payload)
    print(json.dumps(result, ensure_ascii=False))
    exit_code = result.get("exit_code")
    return exit_code if isinstance(exit_code, int) else 1


if __name__ == "__main__":
    raise SystemExit(main())
