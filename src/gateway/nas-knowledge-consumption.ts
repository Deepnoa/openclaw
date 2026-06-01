import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

// The intended canonical location is /mnt/nas/registry/indexes/consumption-log.jsonl,
// but that CIFS mount is read-only from the gateway, so the default is the writable
// observability tree. Ops can repoint via DEEPNOA_CONSUMPTION_LOG_PATH once the NAS
// path is writable. Append-only either way; never mutates the manifest or registry.
const CONSUMPTION_LOG_PATH =
  process.env.DEEPNOA_CONSUMPTION_LOG_PATH ??
  path.join(REGISTRY_ROOT, "observability/knowledge-consumption/consumption-log.jsonl");

const SAFE_MANIFEST_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-file-ingestion/safe-manifest.jsonl",
);

// Cap on lines retained when reading back for stats — protects against an unbounded
// log degrading the stats/graph endpoints. The file itself stays append-only.
const MAX_EVENTS_SCANNED = 10_000;
const STALE_WINDOW_DAYS = 90;

export type ConsumptionOutcome = "success" | "blocked" | "not_found";
export type ConsumptionEventType = "retrieve" | "discover" | "proposal" | "ingestion";

export type ConsumptionEvent = {
  event_type: ConsumptionEventType;
  manifest_ids: string[];
  agent_id: string | null;
  session_key: string | null;
  classification: string | null;
  outcome: ConsumptionOutcome;
  timestamp: string;
};

// Strips anything that is not part of the safe event contract. Deliberately drops
// raw query text, retrieved content, filesystem paths, source refs, and user identity.
function sanitizeEvent(event: ConsumptionEvent): ConsumptionEvent {
  return {
    event_type: event.event_type,
    manifest_ids: (event.manifest_ids ?? [])
      .filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]+$/u.test(id))
      .slice(0, 50),
    agent_id:
      typeof event.agent_id === "string" && /^[a-zA-Z0-9_.-]{1,64}$/u.test(event.agent_id)
        ? event.agent_id
        : null,
    session_key:
      typeof event.session_key === "string" && /^[a-zA-Z0-9_.-]{1,64}$/u.test(event.session_key)
        ? event.session_key
        : null,
    classification:
      typeof event.classification === "string" ? event.classification.slice(0, 64) : null,
    outcome: event.outcome,
    timestamp: event.timestamp,
  };
}

// Fire-and-forget append. Never throws — a logging failure must not break the user
// flow that triggered it. Callers should NOT await this in the request path.
export function appendConsumptionEvent(event: ConsumptionEvent): void {
  void (async () => {
    try {
      const safe = sanitizeEvent(event);
      await mkdir(path.dirname(CONSUMPTION_LOG_PATH), { recursive: true });
      await appendFile(CONSUMPTION_LOG_PATH, `${JSON.stringify(safe)}\n`, "utf8");
    } catch {
      // Best-effort observability only — swallow all errors.
    }
  })();
}

// Maps an assist action + raw orchestration output to a consumption event.
// Returns null when there is nothing meaningful to record. Extracts only manifest
// ids and an outcome — never content, query text, or paths.
export function buildConsumptionEventFromAssist(
  action: string,
  rawResult: Record<string, unknown> | null | undefined,
): ConsumptionEvent | null {
  const timestamp = new Date().toISOString();
  const raw = rawResult ?? {};
  const classification = typeof raw.classification === "string" ? raw.classification : null;

  const idsFrom = (arr: unknown, key: string): string[] =>
    Array.isArray(arr)
      ? arr
          .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>)[key] : null))
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];

  if (action === "retrieve") {
    const retrieved = idsFrom(raw.retrieved_entries, "id");
    const blocked = idsFrom(raw.blocked_entries, "id");
    const outcome: ConsumptionOutcome =
      retrieved.length > 0 ? "success" : blocked.length > 0 ? "blocked" : "not_found";
    return {
      event_type: "retrieve",
      manifest_ids: [...retrieved, ...blocked],
      agent_id: null,
      session_key: null,
      classification,
      outcome,
      timestamp,
    };
  }

  if (action === "discover") {
    const candidateIds = idsFrom(raw.candidates, "manifest_id");
    const candidateCount = Array.isArray(raw.candidates) ? raw.candidates.length : 0;
    return {
      event_type: "discover",
      manifest_ids: candidateIds,
      agent_id: null,
      session_key: null,
      classification,
      outcome: candidateCount > 0 ? "success" : "not_found",
      timestamp,
    };
  }

  if (action === "propose") {
    const proposed = typeof raw.proposed_action === "string" ? raw.proposed_action : null;
    const candidateIds = idsFrom(raw.candidates, "manifest_id");
    return {
      event_type: "proposal",
      manifest_ids: candidateIds,
      agent_id: null,
      session_key: null,
      classification,
      outcome: proposed ? "success" : "not_found",
      timestamp,
    };
  }

  return null;
}

// Records an actual governed ingestion (mode=execute only). The ingest decision
// object carries no manifest id, so manifest_ids is empty; we record the outcome
// derived from the governance decision. Never call this for dry-run.
export function buildConsumptionEventFromIngestion(decision: {
  decision: string | null;
  manifest_entry_created: boolean;
}): ConsumptionEvent {
  const verdict = (decision.decision ?? "").toLowerCase();
  const outcome: ConsumptionOutcome =
    verdict === "blocked"
      ? "blocked"
      : decision.manifest_entry_created || verdict === "allowed"
        ? "success"
        : "not_found";
  return {
    event_type: "ingestion",
    manifest_ids: [],
    agent_id: null,
    session_key: null,
    classification: decision.decision ?? null,
    outcome,
    timestamp: new Date().toISOString(),
  };
}

export type ConsumptionEventRecord = ConsumptionEvent;

// Reads the append-only log back (bounded). Returns [] on any error — the log is
// optional observability, not a hard dependency.
export async function readConsumptionEvents(): Promise<ConsumptionEventRecord[]> {
  let text: string;
  try {
    text = await readFile(CONSUMPTION_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-MAX_EVENTS_SCANNED);
  const events: ConsumptionEventRecord[] = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as ConsumptionEventRecord;
      if (parsed && typeof parsed.event_type === "string") {
        events.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  return events;
}

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

type ManifestMeta = { id: string; title: string; lifecycle_state: string };

async function readManifestMeta(): Promise<ManifestMeta[]> {
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
      if (typeof e.id === "string") {
        out.push({
          id: e.id,
          title: typeof e.title === "string" ? e.title : e.id,
          lifecycle_state: typeof e.lifecycle_state === "string" ? e.lifecycle_state : "unknown",
        });
      }
    } catch {
      // skip
    }
  }
  return out;
}

export async function readConsumptionStats(): Promise<ConsumptionStats> {
  const [events, manifests] = await Promise.all([readConsumptionEvents(), readManifestMeta()]);

  const manifestById = new Map(manifests.map((m) => [m.id, m]));
  const titleById = (id: string): string => manifestById.get(id)?.title ?? id;

  let total_retrievals = 0;
  let total_discoveries = 0;
  let total_proposals = 0;
  let total_ingestions = 0;
  let blocked_attempts = 0;
  let not_found_attempts = 0;
  let stale_references = 0;

  const refCount = new Map<string, number>();
  const referencedIds = new Set<string>();

  for (const ev of events) {
    if (ev.event_type === "retrieve") {
      total_retrievals += 1;
    } else if (ev.event_type === "discover") {
      total_discoveries += 1;
    } else if (ev.event_type === "proposal") {
      total_proposals += 1;
    } else if (ev.event_type === "ingestion") {
      total_ingestions += 1;
    }

    if (ev.outcome === "blocked") {
      blocked_attempts += 1;
    }
    if (ev.outcome === "not_found") {
      not_found_attempts += 1;
    }

    for (const id of ev.manifest_ids ?? []) {
      refCount.set(id, (refCount.get(id) ?? 0) + 1);
      referencedIds.add(id);
      // A reference to a manifest that is no longer active is "stale".
      const meta = manifestById.get(id);
      if (meta && meta.lifecycle_state !== "active") {
        stale_references += 1;
      }
    }
  }

  const top_manifests = [...refCount.entries()]
    .map(([id, count]) => ({ id, title: titleById(id), count }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 5);

  // Active manifests never referenced in the log window.
  const unused_manifests = manifests
    .filter((m) => m.lifecycle_state === "active" && !referencedIds.has(m.id))
    .map((m) => m.id);

  return {
    total_retrievals,
    total_discoveries,
    total_proposals,
    total_ingestions,
    blocked_attempts,
    not_found_attempts,
    stale_references,
    top_manifests,
    unused_manifests,
    window_days: STALE_WINDOW_DAYS,
    event_count: events.length,
  };
}

// Per-manifest usage metrics for the detail view (retrieval count, first/last seen).
export async function readManifestUsage(id: string): Promise<{
  retrieval_count: number;
  first_retrieved: string | null;
  last_retrieved: string | null;
}> {
  const events = await readConsumptionEvents();
  let count = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const ev of events) {
    if (!ev.manifest_ids?.includes(id)) {
      continue;
    }
    count += 1;
    if (!first || ev.timestamp < first) {
      first = ev.timestamp;
    }
    if (!last || ev.timestamp > last) {
      last = ev.timestamp;
    }
  }
  return { retrieval_count: count, first_retrieved: first, last_retrieved: last };
}

export { CONSUMPTION_LOG_PATH };
