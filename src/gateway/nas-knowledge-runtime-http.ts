import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const SAFE_MANIFEST_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-file-ingestion/safe-manifest.jsonl",
);
// Append-only advisory stream. The knowledge layer is the ONLY writer; the runtime
// loop consumes it read-only. There is no reverse write path.
const RUNTIME_ADVISORY_LOG_PATH = path.join(
  REGISTRY_ROOT,
  "observability/knowledge-orchestration/runtime-advisory.jsonl",
);

const DEFAULT_BODY_BYTES = 16 * 1024;
const MAX_CONTEXT_QUERY_LEN = 100;

// ── In-process sliding-window rate limiter: 10 requests / 60s for this endpoint ──
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

function rateLimitAllows(now: number): boolean {
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  requestTimestamps.push(now);
  return true;
}

type ManifestMeta = {
  id: string;
  title: string;
  decision: string;
  lifecycle_state: string;
  sensitivity: string;
  decision_reason: string;
  retrieval_allowed: boolean;
};

async function readManifests(): Promise<ManifestMeta[]> {
  let text: string;
  try {
    text = await readFile(SAFE_MANIFEST_PATH, "utf8");
  } catch {
    return [];
  }
  const out: ManifestMeta[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const e = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof e.id !== "string") {
        continue;
      }
      out.push({
        id: e.id,
        title: typeof e.title === "string" ? e.title : e.id,
        decision: typeof e.decision === "string" ? e.decision : "unknown",
        lifecycle_state: typeof e.lifecycle_state === "string" ? e.lifecycle_state : "unknown",
        sensitivity: typeof e.sensitivity === "string" ? e.sensitivity : "unknown",
        decision_reason: typeof e.decision_reason === "string" ? e.decision_reason : "",
        retrieval_allowed: e.retrieval_allowed === true,
      });
    } catch {
      // skip
    }
  }
  return out;
}

type RelevantManifest = {
  id: string;
  title: string;
  relevance_score: number;
  suggested_action: "retrieve" | "review" | "none";
};

// Safe, metadata-only relevance scoring — no embeddings, no content. Tokens of the
// context query are matched against title and decision_reason. Blocked and
// non-retrievable manifests are suppressed from advisory results entirely.
function scoreManifests(contextQuery: string, manifests: ManifestMeta[]): RelevantManifest[] {
  const tokens = contextQuery
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((tok) => tok.length >= 3);
  if (tokens.length === 0) {
    return [];
  }

  const scored: RelevantManifest[] = [];
  for (const m of manifests) {
    // Governance-aware suppression: never advise on blocked or non-retrievable items.
    if (m.decision === "blocked" || !m.retrieval_allowed) {
      continue;
    }
    const title = m.title.toLowerCase();
    const reason = m.decision_reason.toLowerCase();
    let hits = 0;
    for (const tok of tokens) {
      if (title.includes(tok)) {
        hits += 2;
      } else if (reason.includes(tok)) {
        hits += 1;
      }
    }
    if (hits === 0) {
      continue;
    }
    const canonicalBoost = m.lifecycle_state === "active" ? 1.2 : 1.0;
    const score = Math.min(1, (hits / (tokens.length * 2)) * canonicalBoost);
    scored.push({
      id: m.id,
      title: m.title,
      relevance_score: Math.round(score * 100) / 100,
      suggested_action: score >= 0.5 ? "retrieve" : score >= 0.2 ? "review" : "none",
    });
  }
  return scored.toSorted((a, b) => b.relevance_score - a.relevance_score).slice(0, 5);
}

function appendAdvisoryLog(entry: Record<string, unknown>): void {
  void (async () => {
    try {
      await mkdir(path.dirname(RUNTIME_ADVISORY_LOG_PATH), { recursive: true });
      await appendFile(RUNTIME_ADVISORY_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // best-effort
    }
  })();
}

function asBoundedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const trimmed = v.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, max);
}

export async function handleNasKnowledgeRuntimeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    maxBodyBytes?: number;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/nas/knowledge-runtime-context") {
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
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", allow: ["POST"] });
    return true;
  }

  if (!rateLimitAllows(Date.now())) {
    sendJson(res, 429, {
      ok: false,
      error: "rate_limited: max 10 requests per minute for /nas/knowledge-runtime-context",
    });
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as {
    domain?: unknown;
    context_query?: unknown;
    pressure?: unknown;
    incident_type?: unknown;
  };

  const contextQuery = asBoundedString(body.context_query, MAX_CONTEXT_QUERY_LEN);
  if (!contextQuery) {
    sendJson(res, 400, { ok: false, error: "invalid_context_query: non-empty string required" });
    return true;
  }
  const domain = asBoundedString(body.domain, 64);
  const pressure = asBoundedString(body.pressure, 32);
  const incidentType = asBoundedString(body.incident_type, 64);

  const manifests = await readManifests();
  const relevant = scoreManifests(contextQuery, manifests);

  const topScore = relevant.length > 0 ? relevant[0].relevance_score : 0;
  const confidence: "high" | "medium" | "low" =
    topScore >= 0.6 ? "high" : topScore >= 0.3 ? "medium" : "low";
  const recommendedKnowledgeAction = relevant.some((r) => r.suggested_action === "retrieve")
    ? "retrieve"
    : relevant.some((r) => r.suggested_action === "review")
      ? "review"
      : null;

  // ADVISORY ONLY. requires_operator_review is always true — the runtime loop must
  // never auto-act on this. No mutation, ingestion, or execution happens here.
  const advisory = {
    relevant_manifests: relevant,
    recommended_knowledge_action: recommendedKnowledgeAction,
    confidence,
    requires_operator_review: true as const,
  };

  // Append-only advisory record. Knowledge layer writes; runtime reads only.
  appendAdvisoryLog({
    advisory_type: "runtime_context_response",
    domain,
    pressure,
    incident_type: incidentType,
    relevant_manifest_ids: relevant.map((r) => r.id),
    recommended_knowledge_action: recommendedKnowledgeAction,
    confidence,
    requires_operator_action: false,
    timestamp: new Date().toISOString(),
  });

  sendJson(res, 200, {
    ok: true,
    advisory,
    safety_constraints: {
      advisory_only: true,
      autonomous_execution: false,
      runtime_mutation: false,
      manifest_mutation: false,
      ingestion_triggered: false,
      blocked_manifests_suppressed: true,
    },
  });
  return true;
}
