import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { readConsumptionEvents, readManifestUsage } from "./nas-knowledge-consumption.js";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const SAFE_MANIFEST_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-file-ingestion/safe-manifest.jsonl",
);
const ORCHESTRATION_PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/knowledge-orchestration/knowledge-orchestration-proof.json",
);
const RUNTIME_ADVISORY_PATH = path.join(
  REGISTRY_ROOT,
  "observability/knowledge-orchestration/runtime-advisory.jsonl",
);

// Registry-relative path descriptors. These are the strings surfaced to the UI
// via runtime_references[].source_file. They are stable logical paths inside
// the registry — never absolute filesystem paths and never the CIFS mount.
const SOURCE_FILE_ADVISORY = "observability/knowledge-orchestration/runtime-advisory.jsonl";
const SOURCE_FILE_CONSUMPTION = "observability/knowledge-consumption/consumption-log.jsonl";
const SOURCE_FILE_ORCHESTRATION =
  "observability/knowledge-orchestration/knowledge-orchestration-proof.json";

const SUMMARY_MAX_LEN = 140;
const RUNTIME_REFERENCES_MAX_PER_SOURCE = 20;
const RUNTIME_REFERENCES_MAX_TOTAL = 50;

// Fields safe to surface for a single manifest entry. Never expose evidence_ref,
// source_refs, summary_ref, source_summary_path, or any filesystem path: the id
// is the only identifier an operator needs and the safe summary is bounded.
const SAFE_MANIFEST_DETAIL_FIELDS = new Set([
  "id",
  "title",
  "artifact_type",
  "lifecycle_state",
  "decision",
  "decision_reason",
  "sensitivity",
  "retrieval_allowed",
  "export_allowed",
  "rag_safe",
  "created_at",
]);

// Reject ids that could traverse the filesystem or smuggle control characters.
// The id is never used to build a path — it only matches a JSONL field — but we
// validate defensively so a malformed id is a clean 400 rather than a scan miss.
function isValidManifestId(id: string): boolean {
  if (!id || id.length > 128) {
    return false;
  }
  if (id.includes("\0") || id.includes("/") || id.includes("..")) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/u.test(id);
}

function pickSafeFields(entry: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (SAFE_MANIFEST_DETAIL_FIELDS.has(k)) {
      safe[k] = v;
    }
  }
  return safe;
}

// Streaming scan: read line-by-line and stop at the first id match so a large
// manifest does not require fully materializing every parsed entry.
async function findManifestEntryById(id: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(SAFE_MANIFEST_PATH, "utf8");
  } catch {
    return null;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.id === id) {
      return parsed;
    }
  }
  return null;
}

type RetrievalHistoryEntry = {
  timestamp: string;
  query: string | null;
  classification: string | null;
  routed_to: string[];
};

type RuntimeReferenceType = "advisory_citation" | "consumption_event" | "orchestration_citation";

type RuntimeReference = {
  ref_type: RuntimeReferenceType;
  timestamp: string;
  source_file: string;
  summary: string;
  metadata: Record<string, unknown>;
};

function truncateSummary(value: string): string {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed.length <= SUMMARY_MAX_LEN ? trimmed : `${trimmed.slice(0, SUMMARY_MAX_LEN - 1)}…`;
}

function safeVocab(value: unknown, max = 64): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const v = value.trim();
  if (!v) {
    return null;
  }
  return v.slice(0, max);
}

function countOtherIds(allIds: unknown, targetId: string): number {
  if (!Array.isArray(allIds)) {
    return 0;
  }
  let count = 0;
  for (const id of allIds) {
    if (typeof id === "string" && id !== targetId) {
      count += 1;
    }
  }
  return count;
}

// S1: append-only runtime advisories cited this manifest_id in relevant_manifest_ids.
// Returns one reference per matching advisory line. Never surfaces other manifests'
// ids — only a co_referenced_count integer to indicate the cite was multi-manifest.
async function readAdvisoryReferences(manifestId: string): Promise<RuntimeReference[]> {
  let text: string;
  try {
    text = await readFile(RUNTIME_ADVISORY_PATH, "utf8");
  } catch {
    return [];
  }
  const refs: RuntimeReference[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ids = parsed.relevant_manifest_ids;
    if (!Array.isArray(ids) || !ids.includes(manifestId)) {
      continue;
    }
    const timestamp = safeVocab(parsed.timestamp, 40);
    if (!timestamp) {
      continue;
    }
    const advisoryType = safeVocab(parsed.advisory_type) ?? "advisory";
    const confidence = safeVocab(parsed.confidence) ?? "unknown";
    const action = safeVocab(parsed.recommended_knowledge_action);
    const domain = safeVocab(parsed.domain);
    const incidentType = safeVocab(parsed.incident_type);
    const pressure = safeVocab(parsed.pressure);
    const requiresOperator = parsed.requires_operator_action === true;
    const others = countOtherIds(ids, manifestId);
    const summaryParts = [
      `type=${advisoryType}`,
      `confidence=${confidence}`,
      action ? `action=${action}` : null,
      domain ? `domain=${domain}` : null,
      incidentType ? `incident=${incidentType}` : null,
      others > 0 ? `co_referenced=${others}` : null,
    ].filter((p): p is string => p !== null);
    refs.push({
      ref_type: "advisory_citation",
      timestamp,
      source_file: SOURCE_FILE_ADVISORY,
      summary: truncateSummary(summaryParts.join(" ")),
      metadata: {
        advisory_type: advisoryType,
        confidence,
        recommended_knowledge_action: action,
        domain,
        incident_type: incidentType,
        pressure,
        requires_operator_action: requiresOperator,
        co_referenced_count: others,
      },
    });
  }
  return refs;
}

// S6: append-only consumption events cited this manifest_id in manifest_ids.
// Reuses readConsumptionEvents() which already honors DEEPNOA_CONSUMPTION_LOG_PATH
// (Phase C P1 re-pointed this to the NAS canonical location). Per-manifest detail
// surfaces event_type / outcome / classification only — never agent_id, never
// session_key, never raw query text.
async function readConsumptionReferences(manifestId: string): Promise<RuntimeReference[]> {
  const events = await readConsumptionEvents();
  const refs: RuntimeReference[] = [];
  for (const e of events) {
    if (!Array.isArray(e.manifest_ids) || !e.manifest_ids.includes(manifestId)) {
      continue;
    }
    const timestamp = safeVocab(e.timestamp, 40);
    if (!timestamp) {
      continue;
    }
    const eventType = safeVocab(e.event_type) ?? "event";
    const outcome = safeVocab(e.outcome) ?? "unknown";
    const classification = safeVocab(e.classification);
    const others = countOtherIds(e.manifest_ids, manifestId);
    const summaryParts = [
      `event=${eventType}`,
      `outcome=${outcome}`,
      classification ? `class=${classification}` : null,
      others > 0 ? `co_referenced=${others}` : null,
    ].filter((p): p is string => p !== null);
    refs.push({
      ref_type: "consumption_event",
      timestamp,
      source_file: SOURCE_FILE_CONSUMPTION,
      summary: truncateSummary(summaryParts.join(" ")),
      metadata: {
        event_type: eventType,
        outcome,
        classification,
        co_referenced_count: others,
      },
    });
  }
  return refs;
}

// S4: the latest orchestration proof points at this manifest_id when action=retrieve
// and proof.id === manifestId. Discover/propose proofs are aggregate and do not pin
// a single manifest, so they are not emitted here (consumption events from the same
// flow already provide per-manifest coverage via S6).
async function readOrchestrationReference(manifestId: string): Promise<RuntimeReference[]> {
  let proof: Record<string, unknown> | null = null;
  try {
    proof = JSON.parse(await readFile(ORCHESTRATION_PROOF_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!proof) {
    return [];
  }
  const action = safeVocab(proof.action);
  const proofId = safeVocab(proof.id);
  if (action !== "retrieve" || proofId !== manifestId) {
    return [];
  }
  const timestamp = safeVocab(proof.timestamp, 40) ?? safeVocab(proof.generated_at, 40);
  if (!timestamp) {
    return [];
  }
  const classification = safeVocab(proof.classification);
  const routedTo = Array.isArray(proof.routed_to)
    ? proof.routed_to.filter((v): v is string => typeof v === "string").slice(0, 8)
    : [];
  const summaryParts = [
    `action=${action}`,
    classification ? `class=${classification}` : null,
    routedTo.length > 0 ? `routed_to=${routedTo.length}` : null,
  ].filter((p): p is string => p !== null);
  return [
    {
      ref_type: "orchestration_citation",
      timestamp,
      source_file: SOURCE_FILE_ORCHESTRATION,
      summary: truncateSummary(summaryParts.join(" ")),
      metadata: {
        action,
        classification,
        routed_to: routedTo,
      },
    },
  ];
}

async function buildRuntimeReferences(manifestId: string): Promise<{
  references: RuntimeReference[];
  per_source_counts: { advisory: number; consumption: number; orchestration: number };
  truncated: boolean;
}> {
  const [advisory, consumption, orchestration] = await Promise.all([
    readAdvisoryReferences(manifestId),
    readConsumptionReferences(manifestId),
    readOrchestrationReference(manifestId),
  ]);
  // Cap per source first to prevent any one source from dominating the response.
  const advisoryCapped = advisory
    .toSorted((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, RUNTIME_REFERENCES_MAX_PER_SOURCE);
  const consumptionCapped = consumption
    .toSorted((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, RUNTIME_REFERENCES_MAX_PER_SOURCE);
  const orchestrationCapped = orchestration.slice(0, RUNTIME_REFERENCES_MAX_PER_SOURCE);
  const combined = [...advisoryCapped, ...consumptionCapped, ...orchestrationCapped].toSorted(
    (a, b) => b.timestamp.localeCompare(a.timestamp),
  );
  const truncated = combined.length > RUNTIME_REFERENCES_MAX_TOTAL;
  return {
    references: combined.slice(0, RUNTIME_REFERENCES_MAX_TOTAL),
    per_source_counts: {
      advisory: advisory.length,
      consumption: consumption.length,
      orchestration: orchestration.length,
    },
    truncated,
  };
}

// Phase A retrieval history is derived from the single latest orchestration proof.
// The proof does not record which manifest ids were returned, so we surface it as
// recent read activity only when the latest action was a read (retrieve/discover).
// When no proof exists or the latest action was not a read, return [] — never error.
async function readRetrievalHistory(): Promise<RetrievalHistoryEntry[]> {
  let proof: Record<string, unknown> | null = null;
  try {
    proof = JSON.parse(await readFile(ORCHESTRATION_PROOF_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!proof) {
    return [];
  }
  const action = typeof proof.action === "string" ? proof.action : null;
  if (action !== "retrieve" && action !== "discover") {
    return [];
  }
  const timestamp =
    typeof proof.timestamp === "string"
      ? proof.timestamp
      : typeof proof.generated_at === "string"
        ? proof.generated_at
        : null;
  if (!timestamp) {
    return [];
  }
  return [
    {
      timestamp,
      query: typeof proof.query === "string" ? proof.query : null,
      classification: typeof proof.classification === "string" ? proof.classification : null,
      routed_to: Array.isArray(proof.routed_to)
        ? proof.routed_to.filter((v): v is string => typeof v === "string")
        : [],
    },
  ];
}

export async function handleNasKnowledgeManifestHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/nas/knowledge-manifest/")) {
    return false;
  }
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: "agent",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", allow: ["GET"] });
    return true;
  }

  const rawId = decodeURIComponent(url.pathname.slice("/nas/knowledge-manifest/".length));
  if (!isValidManifestId(rawId)) {
    sendJson(res, 400, {
      ok: false,
      error: "invalid_id: must be alphanumeric with _ or - and contain no path characters",
    });
    return true;
  }

  const rawEntry = await findManifestEntryById(rawId);
  if (!rawEntry) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return true;
  }

  const [retrievalHistory, usage, runtimeRefs] = await Promise.all([
    readRetrievalHistory(),
    readManifestUsage(rawId),
    buildRuntimeReferences(rawId),
  ]);

  sendJson(res, 200, {
    ok: true,
    entry: pickSafeFields(rawEntry),
    retrieval_history: retrievalHistory,
    // Per-manifest usage metrics from the append-only consumption log (Phase B Item 5).
    usage: {
      retrieval_count: usage.retrieval_count,
      first_retrieved: usage.first_retrieved,
      last_retrieved: usage.last_retrieved,
    },
    // Phase C P3 — runtime references reverse-lookup from S1 (runtime-advisory.jsonl),
    // S6 (consumption-log.jsonl, NAS canonical via DEEPNOA_CONSUMPTION_LOG_PATH), and
    // S4 (knowledge-orchestration-proof.json). Surfaces ref_type/timestamp/source_file/
    // summary/metadata only — never other manifests' ids, never operator identity,
    // never filesystem absolute paths, never raw content.
    runtime_references: runtimeRefs.references,
    runtime_references_meta: {
      per_source_counts: runtimeRefs.per_source_counts,
      truncated: runtimeRefs.truncated,
      max_per_source: RUNTIME_REFERENCES_MAX_PER_SOURCE,
      max_total: RUNTIME_REFERENCES_MAX_TOTAL,
    },
    safety_constraints: {
      evidence_ref_exposed: false,
      source_refs_exposed: false,
      summary_ref_exposed: false,
      raw_content_returned: false,
      filesystem_paths_exposed: false,
      other_manifest_ids_exposed: false,
      operator_identity_exposed: false,
    },
  });
  return true;
}
