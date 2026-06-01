import { readFile, readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";

// Phase C P2 — read-only governance aggregator. No mutation, no ingestion trigger,
// no cleanup trigger, no promotion trigger, no runtime action.
//
// Surfaces only counts and policy-flag booleans. Never exposes manifest ids,
// filesystem paths, evidence_ref, source_refs, summary_ref, raw content, or
// operator identity. Every source read is best-effort; a missing source
// becomes a zero/null in the response, never an error.

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const SAFE_MANIFEST_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-file-ingestion/safe-manifest.jsonl",
);
const REVIEW_DIR = path.join(REGISTRY_ROOT, "observability/cognition-review/reviewed");
const LIFECYCLE_PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/cognition-lifecycle/cognition-lifecycle-proof.json",
);
const CLEANUP_CANDIDATES_PATH = path.join(
  REGISTRY_ROOT,
  "observability/cognition-lifecycle/cleanup-candidates.json",
);
const COMPACTION_CANDIDATES_PATH = path.join(
  REGISTRY_ROOT,
  "observability/cognition-lifecycle/compaction-candidates.json",
);
const INGESTION_CATALOG_PATH = path.join(
  REGISTRY_ROOT,
  "observability/artifact-ingestion/ingestion-catalog.json",
);
const LOOP_STATE_PATH = path.join(REGISTRY_ROOT, "observability/runtime-loop/loop-state.json");

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readJsonlFile(filePath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(filePath, "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function readReviewDir(): Promise<Array<Record<string, unknown>>> {
  try {
    const entries = await readdir(REVIEW_DIR);
    const records: Array<Record<string, unknown>> = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const data = await readJsonFile(path.join(REVIEW_DIR, name));
      if (data) {
        records.push(data);
      }
    }
    return records;
  } catch {
    return [];
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function incCounter(counter: Record<string, number>, key: string | null | undefined): void {
  const k = typeof key === "string" && key ? key : "unknown";
  counter[k] = (counter[k] ?? 0) + 1;
}

function buildManifestAggregates(entries: Array<Record<string, unknown>>): {
  total: number;
  by_state: Record<string, number>;
  decision: { allowed: number; blocked: number };
  access: {
    retrieval_allowed: number;
    retrieval_denied: number;
    export_allowed: number;
    export_denied: number;
  };
} {
  const by_state: Record<string, number> = {};
  let allowed = 0;
  let blocked = 0;
  let retrieval_allowed = 0;
  let retrieval_denied = 0;
  let export_allowed = 0;
  let export_denied = 0;
  for (const e of entries) {
    incCounter(by_state, asString(e.lifecycle_state) ?? "unknown");
    const decision = asString(e.decision);
    if (decision === "allowed") {
      allowed += 1;
    } else if (decision === "blocked") {
      blocked += 1;
    }
    if (e.retrieval_allowed === true) {
      retrieval_allowed += 1;
    } else if (e.retrieval_allowed === false) {
      retrieval_denied += 1;
    }
    if (e.export_allowed === true) {
      export_allowed += 1;
    } else if (e.export_allowed === false) {
      export_denied += 1;
    }
  }
  return {
    total: entries.length,
    by_state,
    decision: { allowed, blocked },
    access: { retrieval_allowed, retrieval_denied, export_allowed, export_denied },
  };
}

function buildReviewQueue(records: Array<Record<string, unknown>>): {
  pending_operator_review: number;
  reviewed: number;
  auto_promoted: number;
  canonical_promoted: number;
  by_lifecycle_class: Record<string, number>;
  promotion_gate_requires_operator_for_L4: boolean;
} {
  let pending = 0;
  let reviewed = 0;
  let auto_promoted = 0;
  let canonical_promoted = 0;
  const by_lifecycle_class: Record<string, number> = {};
  let promotion_gate_requires_operator_for_L4 = false;
  for (const r of records) {
    if (r.reviewed_by_operator === true) {
      reviewed += 1;
    } else {
      pending += 1;
    }
    if (r.auto_promoted === true) {
      auto_promoted += 1;
    }
    if (asString(r.promoted_to_canonical_at)) {
      canonical_promoted += 1;
    }
    const lc = asString(r.lifecycle_class);
    if (lc) {
      incCounter(by_lifecycle_class, lc);
    }
    if (asString(r.promotion_gate) === "operator_explicit_approval_required_for_L4") {
      promotion_gate_requires_operator_for_L4 = true;
    }
  }
  return {
    pending_operator_review: pending,
    reviewed,
    auto_promoted,
    canonical_promoted,
    by_lifecycle_class,
    promotion_gate_requires_operator_for_L4,
  };
}

function buildPolicy(proof: Record<string, unknown> | null): Record<string, unknown> {
  if (!proof) {
    return {
      modes_defined: [],
      auto_remediation_disabled: false,
      operator_confirmation_required: false,
      self_modification_disabled: false,
      deterministic_mode_selection: false,
      runbook_assistance_allowed_actions_count: 0,
    };
  }
  const modes = Array.isArray(proof.governance_modes_defined)
    ? proof.governance_modes_defined.filter((m): m is string => typeof m === "string")
    : [];
  const allowedActions = Array.isArray(proof.runbook_assistance_allowed_actions)
    ? proof.runbook_assistance_allowed_actions.filter((a): a is string => typeof a === "string")
    : [];
  return {
    modes_defined: modes,
    auto_remediation_disabled: asBoolean(proof.auto_remediation_disabled),
    operator_confirmation_required: asBoolean(proof.operator_confirmation_required),
    self_modification_disabled: asBoolean(proof.self_modification_disabled),
    deterministic_mode_selection: asBoolean(proof.deterministic_mode_selection),
    runbook_assistance_allowed_actions_count: allowedActions.length,
  };
}

function buildCleanup(snapshot: Record<string, unknown> | null): Record<string, unknown> {
  const summary =
    snapshot && typeof snapshot.summary === "object" && snapshot.summary
      ? (snapshot.summary as Record<string, unknown>)
      : {};
  return {
    candidates_total: asNumber(summary.total_candidates),
    L5_expired_forgettable: asNumber(summary.l5_expired_forgettable),
    L6_dangerous_to_restore: asNumber(summary.l6_dangerous_to_restore),
    protected_l4_count: asNumber(summary.protected_l4_count),
    auto_delete_enabled: snapshot ? asBoolean(snapshot.auto_delete_enabled) : false,
  };
}

function buildCompaction(snapshot: Record<string, unknown> | null): Record<string, unknown> {
  const summary =
    snapshot && typeof snapshot.summary === "object" && snapshot.summary
      ? (snapshot.summary as Record<string, unknown>)
      : {};
  const governance =
    snapshot && typeof snapshot.governance === "object" && snapshot.governance
      ? (snapshot.governance as Record<string, unknown>)
      : {};
  const forbidden = Array.isArray(governance.lifecycle_transitions_forbidden)
    ? governance.lifecycle_transitions_forbidden.length
    : 0;
  return {
    clusters_total: asNumber(summary.total_clusters),
    intake_consolidation_candidates: asNumber(summary.intake_consolidation_candidates),
    auto_compaction_enabled: snapshot ? asBoolean(snapshot.auto_compaction_enabled) : false,
    lifecycle_transitions_forbidden_count: forbidden,
  };
}

function buildCatalog(snapshot: Record<string, unknown> | null): Record<string, unknown> {
  const records = Array.isArray(snapshot?.records) ? (snapshot.records as unknown[]) : [];
  const by_artifact_class: Record<string, number> = {};
  const by_lifecycle: Record<string, number> = {};
  const by_eligibility: Record<string, number> = {};
  for (const r of records) {
    if (!r || typeof r !== "object") {
      continue;
    }
    const rec = r as Record<string, unknown>;
    incCounter(by_artifact_class, asString(rec.artifact_class) ?? "unknown");
    incCounter(by_lifecycle, asString(rec.lifecycle) ?? "unknown");
    incCounter(by_eligibility, asString(rec.eligibility) ?? "unknown");
  }
  return {
    total_records: records.length,
    by_artifact_class,
    by_lifecycle,
    by_eligibility,
    generated_at: snapshot ? asString(snapshot.generated_at) : null,
  };
}

function buildLoop(snapshot: Record<string, unknown> | null): Record<string, unknown> {
  if (!snapshot) {
    return {
      last_run_at: null,
      last_status: null,
      freshness_threshold_s: null,
      is_stale: null,
    };
  }
  const last_run_at = asString(snapshot.last_run_at);
  const last_status = asString(snapshot.last_status);
  const threshold =
    typeof snapshot.freshness_threshold_s === "number" ? snapshot.freshness_threshold_s : null;
  let is_stale: boolean | null = null;
  if (last_run_at && threshold !== null) {
    const t = Date.parse(last_run_at);
    if (Number.isFinite(t)) {
      is_stale = Date.now() - t > threshold * 1000;
    }
  }
  return {
    last_run_at,
    last_status,
    freshness_threshold_s: threshold,
    is_stale,
  };
}

function deriveGovernanceIntegrationStatus(loopSnapshot: Record<string, unknown> | null): {
  status: string;
  source: string;
} {
  if (loopSnapshot && typeof loopSnapshot.governance_integration_status === "string") {
    return {
      status: loopSnapshot.governance_integration_status,
      source: "loop-state",
    };
  }
  return { status: "unknown", source: "none" };
}

export async function handleNasKnowledgeGovernanceStatusHttpRequest(
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
  if (url.pathname !== "/nas/knowledge-governance-status") {
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

  const [
    manifests,
    reviewRecords,
    lifecycleProof,
    cleanupSnapshot,
    compactionSnapshot,
    catalogSnapshot,
    loopSnapshot,
  ] = await Promise.all([
    readJsonlFile(SAFE_MANIFEST_PATH),
    readReviewDir(),
    readJsonFile(LIFECYCLE_PROOF_PATH),
    readJsonFile(CLEANUP_CANDIDATES_PATH),
    readJsonFile(COMPACTION_CANDIDATES_PATH),
    readJsonFile(INGESTION_CATALOG_PATH),
    readJsonFile(LOOP_STATE_PATH),
  ]);

  const manifestAggregates = buildManifestAggregates(manifests);
  const reviewQueue = buildReviewQueue(reviewRecords);
  const policy = buildPolicy(lifecycleProof);
  const cleanup = buildCleanup(cleanupSnapshot);
  const compaction = buildCompaction(compactionSnapshot);
  const catalog = buildCatalog(catalogSnapshot);
  const loop = buildLoop(loopSnapshot);
  const governanceStatus = deriveGovernanceIntegrationStatus(loopSnapshot);

  sendJson(res, 200, {
    ok: true,
    schema_version: "deepnoa.knowledge-governance-status.v1",
    generated_at: new Date().toISOString(),
    governance_integration_status: governanceStatus,
    manifest_lifecycle: {
      total: manifestAggregates.total,
      by_state: manifestAggregates.by_state,
    },
    manifest_decision: manifestAggregates.decision,
    manifest_access: manifestAggregates.access,
    review_queue: reviewQueue,
    policy,
    cleanup,
    compaction,
    catalog,
    loop,
    sources_available: {
      safe_manifest: manifests.length > 0,
      cognition_review: reviewRecords.length > 0,
      cognition_lifecycle_proof: lifecycleProof !== null,
      cleanup_candidates: cleanupSnapshot !== null,
      compaction_candidates: compactionSnapshot !== null,
      ingestion_catalog: catalogSnapshot !== null,
      loop_state: loopSnapshot !== null,
    },
    safety_constraints: {
      advisory_only: true,
      autonomous_execution: false,
      manifest_mutation: false,
      ingestion_triggered: false,
      cleanup_triggered: false,
      promotion_triggered: false,
      evidence_ref_exposed: false,
      source_refs_exposed: false,
      summary_ref_exposed: false,
      raw_content_returned: false,
      filesystem_paths_exposed: false,
      manifest_ids_exposed: false,
      operator_identity_exposed: false,
      blocked_summaries_returned: false,
    },
  });
  return true;
}
