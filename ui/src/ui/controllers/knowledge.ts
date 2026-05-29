import type { UiSettings } from "../storage.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export type ManifestEntry = {
  id: string;
  title: string;
  sensitivity: string;
  lifecycle_state: string;
  decision: string;
  decision_reason?: string;
  retrieval_allowed: boolean;
  export_allowed: boolean;
  artifact_type?: string;
  created_at?: string;
  summary_ref?: string;
};

export type KnowledgePanelData = {
  manifest_entries: ManifestEntry[];
  safe_manifest_count: number;
  manifest_by_state: Record<string, number>;
  runtime_pressure: string;
  last_orchestration: {
    action: string | null;
    classification: string | null;
    routed_to: string[];
    confirmation_required: boolean;
    timestamp: string | null;
  } | null;
  last_discovery: {
    query: string | null;
    classification: string | null;
    candidates_returned: number;
    timestamp: string | null;
  } | null;
  last_updated: string;
  safety_constraints: {
    evidence_ref_exposed: boolean;
    source_refs_exposed: boolean;
    raw_content_returned: boolean;
    blocked_summaries_returned: boolean;
  };
};

export type CandidateFile = {
  filename: string;
  path: string;
  file_type?: string;
  size_bytes?: number;
  sensitivity_guess?: string;
  already_in_manifest?: boolean;
  retrieval_available?: boolean;
  recommended_next_action?: string;
};

export type RetrievalEntry = {
  id: string;
  title: string;
  sensitivity?: string;
  lifecycle_state?: string;
  artifact_type?: string;
  // API returns either a plain string or a bounded summary object (never raw content)
  summary?: string | Record<string, unknown>;
  blocked_reason?: string;
  explainability?: { why_retrieval_decision?: string };
};

export type IngestDryRunData = {
  path: string;
  decision: string;
  classification: string;
  sensitivity?: string;
  decision_reason?: string;
  retrieval_allowed?: boolean;
  export_allowed?: boolean;
  confirmation_required: boolean;
  runtime_pressure?: string;
  runtime_pressure_note?: string;
};

export type KnowledgeActionResult = {
  action: string;
  classification: string;
  candidates?: CandidateFile[];
  entries?: RetrievalEntry[];
  dry_run?: IngestDryRunData;
  proposed_action?: string;
  runtime_pressure_note?: string;
  raw?: Record<string, unknown>;
};

// ── Manifest detail (Item 1) ─────────────────────────────────────────────────

export type ManifestDetailEntry = {
  id: string;
  title?: string;
  artifact_type?: string;
  lifecycle_state?: string;
  decision?: string;
  decision_reason?: string;
  sensitivity?: string;
  retrieval_allowed?: boolean;
  export_allowed?: boolean;
  rag_safe?: boolean;
  created_at?: string;
};

export type RetrievalHistoryEntry = {
  timestamp: string;
  query: string | null;
  classification: string | null;
  routed_to: string[];
};

export type RuntimeReference = {
  domain: string;
  reference_type: string;
  timestamp: string;
};

export type ManifestUsage = {
  retrieval_count: number;
  first_retrieved: string | null;
  last_retrieved: string | null;
};

export type ManifestDetailData = {
  entry: ManifestDetailEntry;
  retrieval_history: RetrievalHistoryEntry[];
  runtime_references: RuntimeReference[];
  usage?: ManifestUsage;
};

// ── Runtime reference graph (Item 4a) ─────────────────────────────────────────

export type KnowledgeGraphNode = {
  id: string;
  type: "manifest" | "runtime_domain" | "orchestration";
  label: string;
  properties: Record<string, string | number | boolean>;
};

export type KnowledgeGraphEdge = {
  source: string;
  target: string;
  relation: "retrieved" | "discovered" | "proposed" | "referenced" | "ingested";
  timestamp?: string;
  weight: number;
};

export type KnowledgeGraphData = {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  generated_at: string;
  node_count: number;
  edge_count: number;
};

// ── Consumption stats (Item 5) ────────────────────────────────────────────────

export type ConsumptionStats = {
  total_retrievals: number;
  total_discoveries: number;
  total_proposals: number;
  total_ingestions: number;
  blocked_attempts: number;
  not_found_attempts: number;
  stale_references: number;
  top_manifests: Array<{ id: string; title: string; count: number }>;
  unused_manifests: string[];
  window_days: number;
  event_count: number;
};

export type KnowledgeState = {
  settings: UiSettings;
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  password?: string | null;
  connected: boolean;
  knowledgePanelLoading: boolean;
  knowledgePanelError: string | null;
  knowledgePanel: KnowledgePanelData | null;
  knowledgeActionLoading: boolean;
  knowledgeActionError: string | null;
  knowledgeActionResult: KnowledgeActionResult | null;
  knowledgeQuery: string;
  knowledgeConfirmPending: { path: string; dryRunResult: IngestDryRunData } | null;
  knowledgeConfirmExecuting: boolean;
  knowledgeConfirmResult: string | null;
  knowledgeManifestDetailId: string | null;
  knowledgeManifestDetail: ManifestDetailData | null;
  knowledgeManifestDetailLoading: boolean;
  knowledgeManifestDetailError: string | null;
  knowledgeGraph: KnowledgeGraphData | null;
  knowledgeGraphLoading: boolean;
  knowledgeGraphError: string | null;
  knowledgeGraphFilter: { nodeType: string | null; relation: string | null };
  knowledgeConsumptionStats: ConsumptionStats | null;
  knowledgeConsumptionStatsLoading: boolean;
  knowledgeConsumptionStatsError: string | null;
};

// ── Fetch helpers ──────────────────────────────────────────────────────────

// Reads the session token directly from sessionStorage as a fallback when the
// in-memory state (hello.auth.deviceToken, settings.token, password) is not yet
// populated — e.g. on first load before applySettings has run, or after a gateway
// restart where the Lit element was initialized before the token was re-persisted.
// Uses the same key format as storage.ts#tokenSessionKeyForGateway.
function sessionStorageFallbackToken(gatewayUrl: string): string | null {
  try {
    if (typeof sessionStorage === "undefined") {
      return null;
    }
    const parsed = new URL(gatewayUrl);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    const scope = `${parsed.protocol}//${parsed.host}${pathname}`;
    const key = `openclaw.control.token.v1:${scope}`;
    const raw = sessionStorage.getItem(key)?.trim() ?? null;
    if (!raw) {
      return null;
    }
    // Reject tokens that would smuggle CR/LF into the HTTP header (same check as sanitizeHeaderToken).
    return /[\r\n]/.test(raw) ? null : raw;
  } catch {
    return null;
  }
}

// Resolves the Authorization header for HTTP NAS requests.
// IMPORTANT: hello.auth.deviceToken must NOT take priority here.
// Device tokens from the WebSocket hello are issued by the gateway for WS session
// management and device pairing — they are a different credential type from the
// gateway shared secret (gateway.auth.token / gateway.auth.password).
// HTTP endpoints in token/password mode validate against the shared secret only;
// device tokens are tried last-resort so pure device-auth deployments still work.
// Priority order: settings.token → password → sessionStorage → hello.auth.deviceToken
function resolveKnowledgeHttpAuthHeader(state: KnowledgeState): {
  header: string | null;
  source: "settings" | "password" | "sessionStorage" | "deviceToken" | "none";
} {
  if (state.settings?.token?.trim()) {
    const header = `Bearer ${state.settings.token.trim()}`;
    return { header, source: "settings" };
  }
  if (state.password?.trim()) {
    const header = `Bearer ${state.password.trim()}`;
    return { header, source: "password" };
  }
  const ssToken = sessionStorageFallbackToken(state.settings.gatewayUrl);
  if (ssToken) {
    return { header: `Bearer ${ssToken}`, source: "sessionStorage" };
  }
  // Device token from WebSocket hello — last resort for pure device-auth deployments
  // where no shared secret is configured. Requires a valid, non-expired device pairing.
  const deviceToken = state.hello?.auth?.deviceToken?.trim();
  if (deviceToken) {
    return { header: `Bearer ${deviceToken}`, source: "deviceToken" };
  }
  return { header: null, source: "none" };
}

function gatewayFetch(state: KnowledgeState, path: string, opts?: RequestInit): Promise<Response> {
  // settings.gatewayUrl is a WebSocket URL (ws:// or wss://); convert to HTTP for fetch().
  const httpBase = state.settings.gatewayUrl
    .replace(/\/$/, "")
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");
  const { header: authHeader } = resolveKnowledgeHttpAuthHeader(state);
  return fetch(`${httpBase}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...opts?.headers,
    },
  });
}

function extractErrorMessage(
  err: string | Record<string, unknown> | unknown,
  fallback: string,
): string {
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") {
      return e.message;
    }
  }
  return fallback;
}

// ── Controllers ────────────────────────────────────────────────────────────

export async function loadKnowledgePanel(state: KnowledgeState): Promise<void> {
  state.knowledgePanelLoading = true;
  state.knowledgePanelError = null;
  try {
    const res = await gatewayFetch(state, "/nas/knowledge-panel");
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string | Record<string, unknown>;
      } | null;
      state.knowledgePanelError = extractErrorMessage(body?.error, `HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { ok: boolean; panel: KnowledgePanelData };
    if (data.ok && data.panel) {
      state.knowledgePanel = data.panel;
    } else {
      state.knowledgePanelError = "Unexpected response from /nas/knowledge-panel";
    }
  } catch (err) {
    state.knowledgePanelError = err instanceof Error ? err.message : String(err);
  } finally {
    state.knowledgePanelLoading = false;
  }
}

export async function loadManifestDetail(state: KnowledgeState, id: string): Promise<void> {
  state.knowledgeManifestDetailId = id;
  state.knowledgeManifestDetail = null;
  state.knowledgeManifestDetailError = null;
  state.knowledgeManifestDetailLoading = true;
  try {
    const res = await gatewayFetch(state, `/nas/knowledge-manifest/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string | Record<string, unknown>;
      } | null;
      state.knowledgeManifestDetailError = extractErrorMessage(body?.error, `HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as {
      ok: boolean;
      entry?: ManifestDetailEntry;
      retrieval_history?: RetrievalHistoryEntry[];
      runtime_references?: RuntimeReference[];
      usage?: ManifestUsage;
    };
    if (data.ok && data.entry) {
      state.knowledgeManifestDetail = {
        entry: data.entry,
        retrieval_history: Array.isArray(data.retrieval_history) ? data.retrieval_history : [],
        runtime_references: Array.isArray(data.runtime_references) ? data.runtime_references : [],
        usage: data.usage,
      };
    } else {
      state.knowledgeManifestDetailError = "Unexpected response from /nas/knowledge-manifest";
    }
  } catch (err) {
    state.knowledgeManifestDetailError = err instanceof Error ? err.message : String(err);
  } finally {
    state.knowledgeManifestDetailLoading = false;
  }
}

export function closeManifestDetail(state: KnowledgeState): void {
  state.knowledgeManifestDetailId = null;
  state.knowledgeManifestDetail = null;
  state.knowledgeManifestDetailError = null;
  state.knowledgeManifestDetailLoading = false;
}

export async function loadKnowledgeGraph(state: KnowledgeState): Promise<void> {
  state.knowledgeGraphLoading = true;
  state.knowledgeGraphError = null;
  try {
    const res = await gatewayFetch(state, "/nas/knowledge-graph");
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string | Record<string, unknown>;
      } | null;
      state.knowledgeGraphError = extractErrorMessage(body?.error, `HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { ok: boolean } & KnowledgeGraphData;
    if (data.ok) {
      state.knowledgeGraph = {
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        edges: Array.isArray(data.edges) ? data.edges : [],
        generated_at: data.generated_at ?? "",
        node_count: data.node_count ?? 0,
        edge_count: data.edge_count ?? 0,
      };
    } else {
      state.knowledgeGraphError = "Unexpected response from /nas/knowledge-graph";
    }
  } catch (err) {
    state.knowledgeGraphError = err instanceof Error ? err.message : String(err);
  } finally {
    state.knowledgeGraphLoading = false;
  }
}

export async function loadConsumptionStats(state: KnowledgeState): Promise<void> {
  state.knowledgeConsumptionStatsLoading = true;
  state.knowledgeConsumptionStatsError = null;
  try {
    const res = await gatewayFetch(state, "/nas/knowledge-consumption-stats");
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string | Record<string, unknown>;
      } | null;
      state.knowledgeConsumptionStatsError = extractErrorMessage(body?.error, `HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { ok: boolean; stats?: ConsumptionStats };
    if (data.ok && data.stats) {
      state.knowledgeConsumptionStats = data.stats;
    } else {
      state.knowledgeConsumptionStatsError =
        "Unexpected response from /nas/knowledge-consumption-stats";
    }
  } catch (err) {
    state.knowledgeConsumptionStatsError = err instanceof Error ? err.message : String(err);
  } finally {
    state.knowledgeConsumptionStatsLoading = false;
  }
}

export async function runKnowledgeAction(
  state: KnowledgeState,
  action: "discover" | "retrieve" | "ingest_dry_run" | "propose",
  opts: { query?: string; path?: string; id?: string; limit?: number },
): Promise<void> {
  state.knowledgeActionLoading = true;
  state.knowledgeActionError = null;
  state.knowledgeActionResult = null;
  state.knowledgeConfirmPending = null;
  state.knowledgeConfirmResult = null;
  try {
    const body: Record<string, unknown> = { action };
    if (opts.query) {
      body.query = opts.query;
    }
    if (opts.path) {
      body.path = opts.path;
    }
    if (opts.id) {
      body.id = opts.id;
    }
    if (opts.limit) {
      body.limit = opts.limit;
    }

    const res = await gatewayFetch(state, "/nas/knowledge-assist", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      ok: boolean;
      action?: string;
      classification?: string;
      result?: Record<string, unknown>;
      error?: string | Record<string, unknown>;
    };
    if (!data.ok) {
      state.knowledgeActionError = extractErrorMessage(data.error, `HTTP ${res.status}`);
      return;
    }
    const result: KnowledgeActionResult = {
      action: data.action ?? action,
      classification: data.classification ?? "unknown",
      raw: data.result,
    };
    const r = data.result ?? {};
    // discover → candidates[]
    if (r.candidates && Array.isArray(r.candidates)) {
      result.candidates = r.candidates as CandidateFile[];
    }
    // retrieve → retrieved_entries[] + blocked_entries[]
    const retrievedEntries = Array.isArray(r.retrieved_entries)
      ? (r.retrieved_entries as RetrievalEntry[])
      : [];
    const blockedEntries = Array.isArray(r.blocked_entries)
      ? (r.blocked_entries as Array<{ id?: string; title?: string; blocked_reason?: string }>).map(
          (b) =>
            ({
              id: b.id ?? "",
              title: b.title ?? b.id ?? "",
              blocked_reason: b.blocked_reason ?? "blocked",
            }) as RetrievalEntry,
        )
      : [];
    if (retrievedEntries.length || blockedEntries.length) {
      result.entries = [...retrievedEntries, ...blockedEntries];
    }
    // ingest_dry_run → ingest_dry_run object
    const dryRunRaw = r.ingest_dry_run ?? r.dry_run;
    if (dryRunRaw && typeof dryRunRaw === "object") {
      const dr = dryRunRaw as Record<string, unknown>;
      result.dry_run = {
        path: (typeof dr.path === "string" ? dr.path : null) ?? opts.path ?? "",
        decision: typeof dr.decision === "string" ? dr.decision : "unknown",
        classification: typeof dr.classification === "string" ? dr.classification : "unknown",
        sensitivity: typeof dr.sensitivity === "string" ? dr.sensitivity : undefined,
        decision_reason: typeof dr.decision_reason === "string" ? dr.decision_reason : undefined,
        retrieval_allowed:
          typeof dr.retrieval_allowed === "boolean" ? dr.retrieval_allowed : undefined,
        export_allowed: typeof dr.export_allowed === "boolean" ? dr.export_allowed : undefined,
        confirmation_required: Boolean(dr.confirmation_required),
        runtime_pressure: typeof dr.runtime_pressure === "string" ? dr.runtime_pressure : undefined,
        runtime_pressure_note:
          typeof dr.runtime_pressure_note === "string" ? dr.runtime_pressure_note : undefined,
      };
    }
    // propose → may have proposed_action at top-level or in result
    const proposedAction = r.proposed_action ?? (data as Record<string, unknown>).proposed_action;
    if (typeof proposedAction === "string") {
      result.proposed_action = proposedAction;
    }
    // runtime_pressure_note from orchestration block
    const orch = r.orchestration as Record<string, unknown> | undefined;
    const pressureNote = r.runtime_pressure_note ?? orch?.runtime_pressure_note;
    if (typeof pressureNote === "string") {
      result.runtime_pressure_note = pressureNote;
    }
    state.knowledgeActionResult = result;
    // If dry-run returned, set confirm pending using the resolved path
    if (result.dry_run) {
      const resolvedPath = result.dry_run.path || opts.path;
      if (resolvedPath) {
        state.knowledgeConfirmPending = { path: resolvedPath, dryRunResult: result.dry_run };
      }
    }
  } catch (err) {
    state.knowledgeActionError = err instanceof Error ? err.message : String(err);
  } finally {
    state.knowledgeActionLoading = false;
  }
}

export async function executeConfirmedIngest(
  state: KnowledgeState,
  filePath: string,
): Promise<void> {
  state.knowledgeConfirmExecuting = true;
  state.knowledgeConfirmResult = null;
  try {
    const res = await gatewayFetch(state, "/nas/ingest-governed-file", {
      method: "POST",
      body: JSON.stringify({ path: filePath, mode: "execute", confirm: true }),
    });
    const data = (await res.json()) as { ok: boolean; decision?: string; error?: string };
    if (data.ok) {
      state.knowledgeConfirmResult = `Ingested: ${data.decision ?? "allowed"}`;
      state.knowledgeConfirmPending = null;
      await loadKnowledgePanel(state);
    } else {
      state.knowledgeConfirmResult = `Error: ${data.error ?? `HTTP ${res.status}`}`;
    }
  } catch (err) {
    state.knowledgeConfirmResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    state.knowledgeConfirmExecuting = false;
  }
}
