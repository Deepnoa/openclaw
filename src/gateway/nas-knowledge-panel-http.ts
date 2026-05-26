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

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const SAFE_MANIFEST_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-file-ingestion/safe-manifest.jsonl",
);
const ORCHESTRATION_PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/knowledge-orchestration/knowledge-orchestration-proof.json",
);
const DISCOVERY_PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/file-discovery/file-discovery-proof.json",
);
const MEMORY_STATE_PATH = path.join(
  REGISTRY_ROOT,
  "observability/memory-coordination/memory-state.json",
);
const LOOP_STATE_PATH = path.join(REGISTRY_ROOT, "observability/runtime-loop/loop-state.json");

// Fields safe to surface from manifest entries — never expose evidence_ref, source_refs,
// or summary_ref (internal filesystem path with no operator UI value; id is sufficient).
const SAFE_MANIFEST_FIELDS = new Set([
  "id",
  "title",
  "sensitivity",
  "lifecycle_state",
  "decision",
  "decision_reason",
  "retrieval_allowed",
  "export_allowed",
  "artifact_type",
  "created_at",
]);

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

function stripSensitiveFields(entry: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (SAFE_MANIFEST_FIELDS.has(k)) {
      safe[k] = v;
    }
  }
  return safe;
}

async function readRuntimePressure(): Promise<string> {
  for (const [filePath, keys] of [
    [MEMORY_STATE_PATH, ["pressure"]] as const,
    [LOOP_STATE_PATH, ["domains", "memory_coordination", "pressure"]] as const,
  ]) {
    try {
      const data = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      let cur: unknown = data;
      for (const k of keys) {
        cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
      }
      if (typeof cur === "string" && cur) {
        return cur;
      }
    } catch {
      // try next source
    }
  }
  return "unknown";
}

export async function handleNasKnowledgePanelHttpRequest(
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
  if (url.pathname !== "/nas/knowledge-panel") {
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

  const [rawManifestEntries, orchestrationProof, discoveryProof, runtimePressure] =
    await Promise.all([
      readJsonlFile(SAFE_MANIFEST_PATH),
      readJsonFile(ORCHESTRATION_PROOF_PATH),
      readJsonFile(DISCOVERY_PROOF_PATH),
      readRuntimePressure(),
    ]);

  // Strip evidence_ref, source_refs, and any non-safe fields before surfacing.
  const manifestEntries = rawManifestEntries.map(stripSensitiveFields);

  // Aggregate counts by governance state.
  const byState = manifestEntries.reduce<Record<string, number>>((acc, e) => {
    const decision = typeof e.decision === "string" ? e.decision : "unknown";
    acc[decision] = (acc[decision] ?? 0) + 1;
    return acc;
  }, {});

  const lastOrchestrationAt =
    typeof orchestrationProof?.generated_at === "string"
      ? orchestrationProof.generated_at
      : typeof orchestrationProof?.timestamp === "string"
        ? orchestrationProof.timestamp
        : null;

  const lastDiscoveryAt =
    typeof discoveryProof?.timestamp === "string" ? discoveryProof.timestamp : null;

  sendJson(res, 200, {
    ok: true,
    panel: {
      manifest_entries: manifestEntries,
      safe_manifest_count: manifestEntries.length,
      manifest_by_state: byState,
      runtime_pressure: runtimePressure,
      last_orchestration: orchestrationProof
        ? {
            action: orchestrationProof.action ?? null,
            classification: orchestrationProof.classification ?? null,
            routed_to: orchestrationProof.routed_to ?? [],
            confirmation_required: orchestrationProof.confirmation_required ?? false,
            timestamp: lastOrchestrationAt,
          }
        : null,
      last_discovery: discoveryProof
        ? {
            query: discoveryProof.query ?? null,
            classification: discoveryProof.classification ?? null,
            candidates_returned: discoveryProof.candidates_returned ?? 0,
            timestamp: lastDiscoveryAt,
          }
        : null,
      last_updated: new Date().toISOString(),
      safety_constraints: {
        evidence_ref_exposed: false,
        source_refs_exposed: false,
        raw_content_returned: false,
        blocked_summaries_returned: false,
      },
    },
  });
  return true;
}
