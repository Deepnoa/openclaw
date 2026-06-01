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
import { readManifestUsage } from "./nas-knowledge-consumption.js";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const SAFE_MANIFEST_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-file-ingestion/safe-manifest.jsonl",
);
const ORCHESTRATION_PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/knowledge-orchestration/knowledge-orchestration-proof.json",
);

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

  const [retrievalHistory, usage] = await Promise.all([
    readRetrievalHistory(),
    readManifestUsage(rawId),
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
    // Runtime references are stubbed in Phase A; populated once runtime integration
    // (Phase B Item 6) wires manifest ids into loop-state references.
    runtime_references: [],
    safety_constraints: {
      evidence_ref_exposed: false,
      source_refs_exposed: false,
      summary_ref_exposed: false,
      raw_content_returned: false,
      filesystem_paths_exposed: false,
    },
  });
  return true;
}
