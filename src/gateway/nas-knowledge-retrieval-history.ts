import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

// Phase C P4 — append-only per-(event, manifest) retrieval history. Mirrors the
// consumption-log pattern: configurable canonical path (NAS via env), local
// writable fallback. The canonical configuration is the NAS path; the fallback
// is the same observability subtree used by Phase C P1's consumption-log
// fallback so writes are co-located by lifecycle.
const RETRIEVAL_HISTORY_PATH =
  process.env.DEEPNOA_RETRIEVAL_HISTORY_PATH ??
  path.join(REGISTRY_ROOT, "observability/knowledge-consumption/retrieval-history.jsonl");

// Read endpoints scan the tail bounded by this cap to protect manifest detail
// latency even when the file grows. The file itself stays append-only.
const MAX_RECORDS_SCANNED = 10_000;
const MAX_RECORDS_PER_MANIFEST = 50;

// Closed enums — anything outside these vocabularies is reduced to "internal"
// for source, null for actor, null for reason. Centralizing the vocabulary
// here keeps the wire schema stable while call sites evolve.
const ALLOWED_SOURCES = new Set([
  "operator_ui",
  "agent_runtime",
  "gateway_intake",
  "advisory",
  "internal",
]);
const ALLOWED_REASONS = new Set([
  "classification_match",
  "lifecycle_active",
  "advisory_recommended",
  "governance_recommended",
]);
const ALLOWED_OUTCOMES = new Set(["success", "blocked", "not_found"]);
const ALLOWED_EVENT_TYPES = new Set(["retrieve", "discover", "propose"]);

export type RetrievalHistoryEventType = "retrieve" | "discover" | "propose";
export type RetrievalHistorySource =
  | "operator_ui"
  | "agent_runtime"
  | "gateway_intake"
  | "advisory"
  | "internal";
export type RetrievalHistoryReason =
  | "classification_match"
  | "lifecycle_active"
  | "advisory_recommended"
  | "governance_recommended"
  | null;
export type RetrievalHistoryOutcome = "success" | "blocked" | "not_found";

// Wire schema for one append-only record. query is hard-null until the P5
// privacy decision lands. actor accepts a sanitized agent id only — never a
// user email, never an operator name, never a session token.
export type RetrievalHistoryRecord = {
  timestamp: string;
  event_type: RetrievalHistoryEventType;
  manifest_id: string;
  query: null;
  source: RetrievalHistorySource;
  actor: string | null;
  reason: RetrievalHistoryReason;
  outcome: RetrievalHistoryOutcome;
  classification: string | null;
};

function sanitizeManifestId(id: unknown): string | null {
  if (typeof id !== "string" || !id || id.length > 128) {
    return null;
  }
  if (id.includes("\0") || id.includes("/") || id.includes("..")) {
    return null;
  }
  return /^[a-zA-Z0-9_-]+$/u.test(id) ? id : null;
}

function sanitizeActor(actor: unknown): string | null {
  if (typeof actor !== "string" || !actor) {
    return null;
  }
  return /^[a-zA-Z0-9_.-]{1,64}$/u.test(actor) ? actor : null;
}

function sanitizeSource(value: unknown): RetrievalHistorySource {
  return typeof value === "string" && ALLOWED_SOURCES.has(value)
    ? (value as RetrievalHistorySource)
    : "internal";
}

function sanitizeReason(value: unknown): RetrievalHistoryReason {
  return typeof value === "string" && ALLOWED_REASONS.has(value)
    ? (value as RetrievalHistoryReason)
    : null;
}

function sanitizeOutcome(value: unknown): RetrievalHistoryOutcome {
  return typeof value === "string" && ALLOWED_OUTCOMES.has(value)
    ? (value as RetrievalHistoryOutcome)
    : "not_found";
}

function sanitizeClassification(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 64) : null;
}

function sanitizeRecord(record: RetrievalHistoryRecord): RetrievalHistoryRecord | null {
  const manifest_id = sanitizeManifestId(record.manifest_id);
  if (!manifest_id) {
    return null;
  }
  if (!ALLOWED_EVENT_TYPES.has(record.event_type)) {
    return null;
  }
  return {
    timestamp: record.timestamp,
    event_type: record.event_type,
    manifest_id,
    query: null,
    source: sanitizeSource(record.source),
    actor: sanitizeActor(record.actor),
    reason: sanitizeReason(record.reason),
    outcome: sanitizeOutcome(record.outcome),
    classification: sanitizeClassification(record.classification),
  };
}

// Fire-and-forget batch append. Never throws — a logging failure must not break
// the user-facing flow that triggered it. Callers MUST NOT await this in the
// request path. Records are emitted one JSON object per line.
export function appendRetrievalHistoryRecords(records: RetrievalHistoryRecord[]): void {
  if (records.length === 0) {
    return;
  }
  void (async () => {
    try {
      const safe = records
        .map((r) => sanitizeRecord(r))
        .filter((r): r is RetrievalHistoryRecord => r !== null);
      if (safe.length === 0) {
        return;
      }
      await mkdir(path.dirname(RETRIEVAL_HISTORY_PATH), { recursive: true });
      const payload = safe.map((r) => JSON.stringify(r)).join("\n");
      await appendFile(RETRIEVAL_HISTORY_PATH, `${payload}\n`, "utf8");
    } catch {
      // Best-effort observability only — swallow all errors.
    }
  })();
}

type AssistBuildOpts = {
  source: RetrievalHistorySource;
  actor: string | null;
};

// Fanout one assist orchestration result into N per-manifest records. retrieve
// emits separate records for retrieved vs blocked manifests so the operator can
// distinguish them on the manifest detail view. discover / propose emit one
// record per candidate.
export function buildRetrievalHistoryRecordsFromAssist(
  action: string,
  rawResult: Record<string, unknown> | null | undefined,
  opts: AssistBuildOpts,
): RetrievalHistoryRecord[] {
  const timestamp = new Date().toISOString();
  const raw = rawResult ?? {};
  const classification = typeof raw.classification === "string" ? raw.classification : null;

  const idsFrom = (arr: unknown, key: string): string[] =>
    Array.isArray(arr)
      ? arr
          .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>)[key] : null))
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];

  const make = (
    event_type: RetrievalHistoryEventType,
    id: string,
    outcome: RetrievalHistoryOutcome,
    reason: RetrievalHistoryReason,
  ): RetrievalHistoryRecord => ({
    timestamp,
    event_type,
    manifest_id: id,
    query: null,
    source: opts.source,
    actor: opts.actor,
    reason,
    outcome,
    classification,
  });

  if (action === "retrieve") {
    const retrieved = idsFrom(raw.retrieved_entries, "id");
    const blocked = idsFrom(raw.blocked_entries, "id");
    return [
      ...retrieved.map((id) => make("retrieve", id, "success", "classification_match")),
      ...blocked.map((id) => make("retrieve", id, "blocked", "governance_recommended")),
    ];
  }

  if (action === "discover") {
    const candidates = idsFrom(raw.candidates, "manifest_id");
    return candidates.map((id) => make("discover", id, "success", "classification_match"));
  }

  if (action === "propose") {
    const proposed = typeof raw.proposed_action === "string" ? raw.proposed_action : null;
    const candidates = idsFrom(raw.candidates, "manifest_id");
    const outcome: RetrievalHistoryOutcome = proposed ? "success" : "not_found";
    return candidates.map((id) => make("propose", id, outcome, "classification_match"));
  }

  return [];
}

type AdvisoryBuildOpts = {
  source: RetrievalHistorySource;
  actor: string | null;
  recommendedAction: string | null;
  confidence: string;
};

// Fanout one runtime-context advisory into N per-manifest records. event_type
// is fixed to "retrieve" because an advisory recommends per-manifest retrieval;
// outcome reflects whether the advisor surfaced the manifest as actionable.
export function buildRetrievalHistoryRecordsFromAdvisory(
  relevantManifestIds: readonly string[],
  opts: AdvisoryBuildOpts,
): RetrievalHistoryRecord[] {
  if (relevantManifestIds.length === 0) {
    return [];
  }
  const timestamp = new Date().toISOString();
  const outcome: RetrievalHistoryOutcome =
    opts.recommendedAction === "retrieve" ? "success" : "not_found";
  const classification = `advisory_${opts.confidence}`;
  return relevantManifestIds.map((id) => ({
    timestamp,
    event_type: "retrieve",
    manifest_id: id,
    query: null,
    source: opts.source,
    actor: opts.actor,
    reason: "advisory_recommended",
    outcome,
    classification,
  }));
}

// Reader for the manifest detail endpoint. Streams the file, filters by
// manifest_id, returns the newest N records (capped). Returns [] on any error
// — the history file is optional observability, not a hard dependency.
export async function readRetrievalHistoryForManifest(
  manifestId: string,
  limit: number = MAX_RECORDS_PER_MANIFEST,
): Promise<RetrievalHistoryRecord[]> {
  let text: string;
  try {
    text = await readFile(RETRIEVAL_HISTORY_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-MAX_RECORDS_SCANNED);
  const matches: RetrievalHistoryRecord[] = [];
  for (const line of tail) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (rec.manifest_id !== manifestId) {
      continue;
    }
    const safe = sanitizeRecord({
      timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
      event_type: rec.event_type as RetrievalHistoryEventType,
      manifest_id: manifestId,
      query: null,
      source: rec.source as RetrievalHistorySource,
      actor: typeof rec.actor === "string" ? rec.actor : null,
      reason: rec.reason as RetrievalHistoryReason,
      outcome: rec.outcome as RetrievalHistoryOutcome,
      classification: typeof rec.classification === "string" ? rec.classification : null,
    });
    if (safe) {
      matches.push(safe);
    }
  }
  return matches.toSorted((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}
