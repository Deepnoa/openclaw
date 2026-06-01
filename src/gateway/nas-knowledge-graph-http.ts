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
import { readConsumptionEvents } from "./nas-knowledge-consumption.js";

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
const LOOP_STATE_PATH = path.join(REGISTRY_ROOT, "observability/runtime-loop/loop-state.json");

type NodeType = "manifest" | "runtime_domain" | "orchestration";
type EdgeRelation = "retrieved" | "discovered" | "proposed" | "referenced" | "ingested";

type GraphNode = {
  id: string;
  type: NodeType;
  label: string;
  properties: Record<string, string | number | boolean>;
};

type GraphEdge = {
  source: string;
  target: string;
  relation: EdgeRelation;
  timestamp?: string;
  weight: number;
};

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ManifestNodeSource = {
  id: string;
  title: string;
  decision: string;
  lifecycle_state: string;
  sensitivity: string;
};

async function readManifests(): Promise<ManifestNodeSource[]> {
  let text: string;
  try {
    text = await readFile(SAFE_MANIFEST_PATH, "utf8");
  } catch {
    return [];
  }
  const out: ManifestNodeSource[] = [];
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
      });
    } catch {
      // skip
    }
  }
  return out;
}

function manifestNodeId(id: string): string {
  return `m:${id}`;
}

// Conservative keyword match between an orchestration query and a manifest, used
// to draw fallback edges from the proof files (which do not record returned ids).
// Only matches tokens of length >= 3 against the manifest title/id (case-insensitive).
function queryMatchesManifest(query: string | null, m: ManifestNodeSource): boolean {
  if (!query) {
    return false;
  }
  const haystack = `${m.title} ${m.id}`.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((tok) => tok.length >= 3);
  return tokens.some((tok) => haystack.includes(tok));
}

const ACTION_TO_RELATION: Record<string, EdgeRelation> = {
  retrieve: "retrieved",
  discover: "discovered",
  propose: "proposed",
  proposal: "proposed",
  ingest: "ingested",
  ingestion: "ingested",
};

export async function handleNasKnowledgeGraphHttpRequest(
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
  if (url.pathname !== "/nas/knowledge-graph") {
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

  const [manifests, loopState, orchProof, discoveryProof, consumptionEvents] = await Promise.all([
    readManifests(),
    readJson(LOOP_STATE_PATH),
    readJson(ORCHESTRATION_PROOF_PATH),
    readJson(DISCOVERY_PROOF_PATH),
    readConsumptionEvents(),
  ]);

  const nodes = new Map<string, GraphNode>();
  // Edge dedup keyed by source|target|relation; weight accumulates.
  const edges = new Map<string, GraphEdge>();

  const addEdge = (
    source: string,
    target: string,
    relation: EdgeRelation,
    timestamp?: string,
  ): void => {
    // Only connect nodes that exist.
    if (!nodes.has(source) || !nodes.has(target)) {
      return;
    }
    const key = `${source}|${target}|${relation}`;
    const existing = edges.get(key);
    if (existing) {
      existing.weight += 1;
      if (timestamp && (!existing.timestamp || timestamp > existing.timestamp)) {
        existing.timestamp = timestamp;
      }
    } else {
      edges.set(key, { source, target, relation, timestamp, weight: 1 });
    }
  };

  // ── Manifest nodes (blocked manifests appear as metadata-only) ──────────────
  for (const m of manifests) {
    nodes.set(manifestNodeId(m.id), {
      id: manifestNodeId(m.id),
      type: "manifest",
      label: m.title,
      properties: {
        decision: m.decision,
        lifecycle_state: m.lifecycle_state,
        sensitivity: m.sensitivity,
        blocked: m.decision === "blocked",
      },
    });
  }

  // ── Runtime domain nodes ────────────────────────────────────────────────────
  const domains = (loopState?.domains ?? {}) as Record<string, Record<string, unknown>>;
  for (const [domain, state] of Object.entries(domains)) {
    const nodeId = `rt:${domain}`;
    const props: Record<string, string | number | boolean> = {};
    if (typeof state.status === "string") {
      props.status = state.status;
    }
    if (typeof state.pressure === "string") {
      props.pressure = state.pressure;
    }
    if (typeof state.overall_severity === "string") {
      props.severity = state.overall_severity;
    }
    nodes.set(nodeId, { id: nodeId, type: "runtime_domain", label: domain, properties: props });
  }

  // ── Orchestration nodes + fallback edges from proof files ───────────────────
  const addProofOrchestration = (proof: Record<string, unknown> | null, nodeKey: string): void => {
    if (!proof) {
      return;
    }
    const action = typeof proof.action === "string" ? proof.action : null;
    const query = typeof proof.query === "string" ? proof.query : null;
    const classification = typeof proof.classification === "string" ? proof.classification : null;
    const timestamp = typeof proof.timestamp === "string" ? proof.timestamp : undefined;
    const relation = action ? ACTION_TO_RELATION[action] : undefined;
    if (!relation) {
      return;
    }
    const nodeId = `orch:${nodeKey}`;
    nodes.set(nodeId, {
      id: nodeId,
      type: "orchestration",
      label: action ?? "orchestration",
      properties: {
        action: action ?? "",
        ...(classification ? { classification } : {}),
        ...(query ? { query: query.slice(0, 50) } : {}),
      },
    });
    // Keyword-match fallback edges to manifests likely touched by this query.
    for (const m of manifests) {
      if (queryMatchesManifest(query, m)) {
        addEdge(nodeId, manifestNodeId(m.id), relation, timestamp);
      }
    }
  };

  addProofOrchestration(orchProof, "latest");
  addProofOrchestration(discoveryProof, "discovery");

  // ── Consumption-log edges (real manifest ids) ───────────────────────────────
  let consumptionIdx = 0;
  for (const ev of consumptionEvents) {
    const relation = ACTION_TO_RELATION[ev.event_type];
    if (!relation || !Array.isArray(ev.manifest_ids) || ev.manifest_ids.length === 0) {
      continue;
    }
    const nodeId = `orch:c${consumptionIdx++}`;
    nodes.set(nodeId, {
      id: nodeId,
      type: "orchestration",
      label: ev.event_type,
      properties: {
        action: ev.event_type,
        ...(ev.classification ? { classification: ev.classification } : {}),
        ...(ev.outcome ? { outcome: ev.outcome } : {}),
      },
    });
    for (const mid of ev.manifest_ids) {
      addEdge(nodeId, manifestNodeId(mid), relation, ev.timestamp);
    }
  }

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];

  sendJson(res, 200, {
    ok: true,
    nodes: nodeList,
    edges: edgeList,
    generated_at: new Date().toISOString(),
    node_count: nodeList.length,
    edge_count: edgeList.length,
    safety_constraints: {
      evidence_ref_exposed: false,
      source_refs_exposed: false,
      summary_ref_exposed: false,
      raw_content_returned: false,
      filesystem_paths_exposed: false,
      blocked_content_exposed: false,
    },
  });
  return true;
}
