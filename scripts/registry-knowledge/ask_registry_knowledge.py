"""OpenClaw -> Deepnoa Registry knowledge consumption caller v1 (read-only).

Minimal, consumer-only caller. OpenClaw has NO authority here. Every access
goes through the landed Registry-side adapter
(runtime/knowledge_intelligence/openclaw_consumption_adapter.py). This module:

  - calls ONLY the four allowed adapter entrypoints
        prepare_openclaw_knowledge_context
        verify_openclaw_consumption_context
        assert_no_write_invariants
        build_openclaw_consumption_summary
  - never calls F1/F2/F3/F4 functions directly
  - never writes a runtime reference (append_runtime_reference /
    create_runtime_reference(execute=True) are NEVER referenced)
  - never touches dispatcher / governance / canonical / retrieval-grant /
    evidence-ingestion surfaces
  - generates no LLM answer
  - fails closed on any contract / invariant violation or adapter exception

Returns a read-only payload only; it exposes no mutation capability.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Locate the landed Registry adapter. OpenClaw is a consumer of the Registry;
# the Registry remains the authority. Path is overridable via DEEPNOA_REGISTRY.
_REGISTRY_ROOT = Path(os.environ.get("DEEPNOA_REGISTRY", "/home/deepnoa/deepnoa-registry"))
_ADAPTER_DIR = _REGISTRY_ROOT / "runtime" / "knowledge_intelligence"

_CONTEXT_SCHEMA_VERSION = "deepnoa.openclaw-consumption-context.v1"

# Invariants every successful consumption must satisfy (caller-side enforcement).
_REQUIRED_SAFETY = {
    "read_only": True,
    "non_authoritative": True,
    "retrieval_grant": False,
    "governance_mutation": False,
    "canonical_promotion": False,
    "runtime_mutation": False,
    "dispatcher_invocation": False,
    "openclaw_authority": False,
    "ai_response_generated": False,
    "runtime_reference_written": False,
}


def _error(error: str, **details: Any) -> dict[str, Any]:
    return {"ok": False, "error": error, **details}


def _load_adapter() -> Any:
    if str(_ADAPTER_DIR) not in sys.path:
        sys.path.insert(0, str(_ADAPTER_DIR))
    import openclaw_consumption_adapter as adapter  # type: ignore

    return adapter


def ask_registry_knowledge(
    question: str,
    filters: dict[str, Any] | None = None,
    limit: int = 5,
) -> dict[str, Any]:
    """Ask the Deepnoa Registry for knowledge context about a question.

    Read-only. Returns {"ok": True, "payload": {...}} on success or a
    fail-closed {"ok": False, "error": ..., "stage": ...} otherwise.
    """
    if not isinstance(question, str) or not question.strip():
        return _error("invalid_question", stage="input")

    # Adapter exception -> fail closed.
    try:
        adapter = _load_adapter()
    except Exception as exc:  # noqa: BLE001 - fail closed on any import problem
        return _error("adapter_unavailable", stage="load_adapter", detail=str(exc))

    try:
        prepared = adapter.prepare_openclaw_knowledge_context(
            question, runtime_actor="openclaw", filters=filters, limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        return _error("adapter_exception", stage="prepare_openclaw_knowledge_context", detail=str(exc))

    if not prepared.get("ok"):
        return _error(prepared.get("error", "prepare_failed"), stage="prepare_openclaw_knowledge_context", detail=prepared)

    context = prepared.get("consumption_context") or {}

    # 1) Schema gate.
    if context.get("schema_version") != _CONTEXT_SCHEMA_VERSION:
        return _error("unexpected_schema_version", stage="schema_gate", schema_version=context.get("schema_version"))

    # 2) Re-verify the context (hash + safety + citations) through the adapter.
    try:
        verification = adapter.verify_openclaw_consumption_context(context)
    except Exception as exc:  # noqa: BLE001
        return _error("adapter_exception", stage="verify_openclaw_consumption_context", detail=str(exc))
    if not verification.get("ok"):
        return _error(verification.get("error", "verification_failed"), stage="verify_openclaw_consumption_context")

    # 3) No-write invariant via the adapter's own assertion helper.
    safety = context.get("safety") or {}
    dry_run = context.get("runtime_reference_dry_run") or {}
    invariant_view = {
        **safety,
        "executed": dry_run.get("executed"),
        "write_operations": dry_run.get("write_operations"),
        "record": context,
    }
    invariant_error = adapter.assert_no_write_invariants(invariant_view)
    if invariant_error is not None:
        return _error(invariant_error.get("error", "write_invariant_violation"), stage="assert_no_write_invariants", detail=invariant_error)

    # 4) Caller-side enforcement of every required invariant (defense in depth).
    if dry_run.get("executed") is not False or dry_run.get("write_operations") != 0:
        return _error("write_detected", stage="caller_invariant_check")
    for key, expected in _REQUIRED_SAFETY.items():
        if safety.get(key) != expected:
            return _error("safety_marker_violation", stage="caller_invariant_check", marker=key, expected=expected, actual=safety.get(key))

    # 5) Read-only summary via the adapter.
    try:
        summary = adapter.build_openclaw_consumption_summary(context)
    except Exception as exc:  # noqa: BLE001
        return _error("adapter_exception", stage="build_openclaw_consumption_summary", detail=str(exc))
    if not summary.get("ok"):
        return _error(summary.get("error", "summary_failed"), stage="build_openclaw_consumption_summary")

    # 6) Build the read-only return payload (no mutation capability exposed).
    items = context.get("answer_context", {}).get("context_items") or []
    citations = (context.get("citation_bundle") or {}).get("citations") or []
    if not citations:
        return _error("missing_citations", stage="payload")

    limitations = sorted({lim for item in items for lim in (item.get("limitations") or [])})
    sensitivity = sorted({str(item.get("sensitivity")) for item in items if item.get("sensitivity")})
    stale_indicators = sorted({s for item in items for s in (item.get("stale_indicators") or [])})

    # Verbatim, read-only copy of the already-verified governed summary text.
    # No synthesis, no concatenation, no LLM. Each item keeps its own citation.
    context_items: list[dict[str, Any]] = []
    for item in items:
        citation = item.get("citation") or {}
        summary_text = item.get("summary")
        reviewed_summary_id = item.get("reviewed_summary_id")
        # Fail closed: governed summary must be present, sourced, and citation-bound,
        # and the citation must match the item's canonical.
        if not isinstance(summary_text, str) or not summary_text:
            return _error("context_item_missing_summary", stage="context_items", canonical_id=item.get("canonical_id"))
        if not reviewed_summary_id:
            return _error("context_item_missing_reviewed_summary_id", stage="context_items", canonical_id=item.get("canonical_id"))
        if not citation:
            return _error("context_item_missing_citation", stage="context_items", canonical_id=item.get("canonical_id"))
        if citation.get("canonical_id") != item.get("canonical_id"):
            return _error("context_item_citation_canonical_mismatch", stage="context_items", canonical_id=item.get("canonical_id"))
        if citation.get("reviewed_summary_id") != reviewed_summary_id:
            return _error("context_item_citation_summary_mismatch", stage="context_items", canonical_id=item.get("canonical_id"))
        context_items.append({
            "canonical_id": item.get("canonical_id"),
            "canonical_title": item.get("canonical_title"),
            "summary": summary_text,
            "limitations": item.get("limitations") or [],
            "sensitivity": item.get("sensitivity"),
            "stale_indicators": item.get("stale_indicators") or [],
            "citation": {
                "canonical_id": citation.get("canonical_id"),
                "retrieval_enablement_id": citation.get("retrieval_enablement_id"),
                "retrieval_review_id": citation.get("retrieval_review_id"),
                "reviewed_summary_id": citation.get("reviewed_summary_id"),
                "evidence_ids": citation.get("evidence_ids") or [],
            },
        })

    payload = {
        "question": context.get("question"),
        "summary": summary,
        "context_items": context_items,
        "selected_canonical_ids": summary.get("selected_canonical_ids"),
        "citations": citations,
        "limitations": limitations,
        "sensitivity": sensitivity,
        "stale_indicators": stale_indicators,
        "runtime_reference_dry_run_id": dry_run.get("runtime_reference_id"),
        "no_write_status": {
            "executed": False,
            "write_operations": 0,
            "runtime_reference_written": False,
        },
        "answer_is_draft": True,
        "non_authoritative": True,
    }
    return {"ok": True, "payload": payload}


def _main() -> int:
    parser = argparse.ArgumentParser(description="OpenClaw read-only Registry knowledge caller v1.")
    parser.add_argument("question")
    parser.add_argument("--filter", action="append", default=[], help="key=value")
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()

    filters: dict[str, Any] = {}
    for raw in args.filter:
        if "=" in raw:
            key, value = raw.split("=", 1)
            filters[key] = value

    result = ask_registry_knowledge(args.question, filters=filters or None, limit=args.limit)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(_main())
