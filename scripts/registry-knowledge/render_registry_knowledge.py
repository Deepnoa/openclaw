"""OpenClaw read-only presentation layer v1 for Registry / NAS knowledge.

Renders the read-only payload returned by ask_registry_knowledge into a
human-readable form. This is NOT an LLM and generates no answer text: it only
formats already-governed, already-cited content with disclosures.

Hard guarantees (fail-closed): the renderer refuses to display a payload that
lacks citations / non-authoritative marker / safe no-write status, or that
indicates any write, AI generation, authority, or mutation. It has no path to
append_runtime_reference, create_runtime_reference(execute=True), dispatcher,
governance/canonical mutation, or retrieval grants.

OpenClaw remains consumer only; the Registry remains the authority.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

# Markers that, if present and truthy in a payload, mean the content is unsafe
# to present (it would imply authority, mutation, a write, or AI generation).
_FORBIDDEN_TRUE_MARKERS = (
    "ai_response_generated",
    "retrieval_grant",
    "governance_mutation",
    "canonical_promotion",
    "runtime_mutation",
    "dispatcher_invocation",
    "openclaw_authority",
    "runtime_reference_written",
    "executed",
)

_BANNER = (
    "Draft / Read-only / Non-authoritative\n"
    "Registry remains source of truth\n"
    "OpenClaw is consumer only"
)


def _error(error: str, **details: Any) -> dict[str, Any]:
    return {"ok": False, "error": error, **details}


def _payload_safety_error(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return a fail-closed error if the payload is unsafe to present."""
    if not isinstance(payload, dict):
        return _error("malformed_payload")

    citations = payload.get("citations")
    if not isinstance(citations, list) or not citations:
        return _error("missing_citations")

    if payload.get("non_authoritative") is not True:
        return _error("missing_or_false_non_authoritative")

    if payload.get("answer_is_draft") is not True:
        return _error("answer_is_draft_not_true")

    nws = payload.get("no_write_status")
    if not isinstance(nws, dict):
        return _error("missing_no_write_status")
    if nws.get("executed") is not False or nws.get("write_operations") != 0 or nws.get("runtime_reference_written") is not False:
        return _error("unsafe_no_write_status", no_write_status=nws)

    # Defensive: any forbidden marker truthy anywhere at payload or no-write level.
    for marker in _FORBIDDEN_TRUE_MARKERS:
        if payload.get(marker) is True:
            return _error("forbidden_marker_true", marker=marker)
        if nws.get(marker) is True and marker not in ("executed",):
            return _error("forbidden_marker_true", marker=marker, scope="no_write_status")

    return None


def format_citations(citations: list[dict[str, Any]]) -> str:
    lines = []
    for i, c in enumerate(citations, 1):
        lines.append(f"  [{i}] {c.get('canonical_title')}  ({c.get('canonical_id')})")
        lines.append(f"      retrieval_enablement_id: {c.get('retrieval_enablement_id')}")
        lines.append(f"      reviewed_summary_id:     {c.get('reviewed_summary_id')}")
        lines.append(f"      evidence_ids:            {', '.join(c.get('evidence_ids') or []) or '-'}")
    return "\n".join(lines)


def format_disclosures(payload: dict[str, Any]) -> str:
    limitations = payload.get("limitations") or []
    sensitivity = payload.get("sensitivity") or []
    stale = payload.get("stale_indicators") or []
    return (
        f"  limitations:      {', '.join(limitations) if limitations else 'none'}\n"
        f"  sensitivity:      {', '.join(sensitivity) if sensitivity else 'none'}\n"
        f"  stale_indicators: {', '.join(stale) if stale else 'none'}"
    )


def format_no_write_status(payload: dict[str, Any]) -> str:
    nws = payload.get("no_write_status") or {}
    return (
        f"  runtime_reference_dry_run_id: {payload.get('runtime_reference_dry_run_id')}\n"
        f"  executed:                  {nws.get('executed')}\n"
        f"  write_operations:          {nws.get('write_operations')}\n"
        f"  runtime_reference_written: {nws.get('runtime_reference_written')}"
    )


def format_governed_summaries(context_items: list[dict[str, Any]]) -> str | None:
    """Render one verbatim governed summary section per canonical item.

    Fail-closed: returns None (NOT an empty string) if any item is malformed —
    missing summary text, missing citation / reviewed_summary_id, or a citation
    that does not match the item's canonical. The caller MUST treat None as a
    hard rejection, never as a fallback. An empty input list returns None too,
    so a present-but-empty context_items is also rejected rather than masked.
    """
    if not context_items:
        return None
    blocks = []
    for i, item in enumerate(context_items, 1):
        citation = item.get("citation") or {}
        summary_text = item.get("summary")
        reviewed_summary_id = item.get("reviewed_summary_id") or citation.get("reviewed_summary_id")
        if not isinstance(summary_text, str) or not summary_text:
            return None
        if not citation or not reviewed_summary_id:
            return None
        if citation.get("canonical_id") != item.get("canonical_id"):
            return None
        lim = item.get("limitations") or []
        sens = item.get("sensitivity")
        stale = item.get("stale_indicators") or []
        blocks.append(
            f"  [{i}] {item.get('canonical_title')}  ({item.get('canonical_id')})\n"
            f"      summary: {summary_text}\n"
            f"      citation: reviewed_summary_id={citation.get('reviewed_summary_id')} "
            f"evidence_ids={', '.join(citation.get('evidence_ids') or []) or '-'}\n"
            f"      limitations: {', '.join(lim) if lim else 'none'}\n"
            f"      sensitivity: {sens or 'none'}\n"
            f"      stale_indicators: {', '.join(stale) if stale else 'none'}"
        )
    return "\n\n".join(blocks)


def render_registry_knowledge_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Render a read-only knowledge payload. Fail-closed on any unsafe payload.

    Returns {"ok": True, "text": str} or {"ok": False, "error": ...}.
    """
    safety_error = _payload_safety_error(payload)
    if safety_error is not None:
        return safety_error

    citations = payload.get("citations") or []
    selected = payload.get("selected_canonical_ids") or []
    context_items = payload.get("context_items")

    # Distinguish the field being ABSENT (legacy/placeholder is safe) from the
    # field being PRESENT (must validate, fail-closed). Use an explicit None
    # check, not truthiness: a present-but-empty list ([]) is still "present"
    # and must be rejected by format_governed_summaries rather than masked as a
    # safe placeholder. Any malformed or empty governed payload fails closed.
    if context_items is None:
        summary_section = ["SUMMARY", "  (governed answer context — see citations)"]
    else:
        governed = format_governed_summaries(context_items)
        if governed is None:
            return _error("invalid_governed_context_item")
        summary_section = ["GOVERNED SUMMARY (per canonical, verbatim reviewed-summary text)", governed]

    sections = [
        "=" * 64,
        _BANNER,
        "=" * 64,
        "",
        f"QUESTION: {payload.get('question')}",
        "",
        *summary_section,
        "",
        "CITATIONS",
        format_citations(citations),
        "",
        "DISCLOSURES",
        format_disclosures(payload),
        "",
        "SELECTED CANONICAL IDS",
        f"  {', '.join(selected) if selected else '-'}",
        "",
        "RUNTIME REFERENCE DRY-RUN",
        format_no_write_status(payload),
        "",
        "=" * 64,
        "Non-authoritative draft. No write performed. Registry is the source of truth.",
        "=" * 64,
    ]
    return {"ok": True, "text": "\n".join(sections)}


def _main() -> int:
    parser = argparse.ArgumentParser(description="Render Registry knowledge payload (read-only, no LLM).")
    parser.add_argument("question")
    parser.add_argument("--filter", action="append", default=[], help="key=value")
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()

    # Import the landed caller and fetch a read-only payload.
    sys.path.insert(0, __import__("os").path.dirname(__file__))
    import ask_registry_knowledge as caller  # type: ignore

    filters: dict[str, Any] = {}
    for raw in args.filter:
        if "=" in raw:
            key, value = raw.split("=", 1)
            filters[key] = value

    result = caller.ask_registry_knowledge(args.question, filters=filters or None, limit=args.limit)
    if not result.get("ok"):
        print(json.dumps({"ok": False, "error": result.get("error"), "stage": result.get("stage")}, ensure_ascii=False, indent=2))
        return 1

    rendered = render_registry_knowledge_payload(result["payload"])
    if not rendered.get("ok"):
        print(json.dumps(rendered, ensure_ascii=False, indent=2))
        return 1
    print(rendered["text"])
    return 0


if __name__ == "__main__":
    sys.exit(_main())
