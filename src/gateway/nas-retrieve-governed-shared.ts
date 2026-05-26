import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Gateway never reimplements retrieval logic. It shells out to retrieve-governed.sh.
const RETRIEVE_SCRIPT =
  process.env.DEEPNOA_RETRIEVE_SCRIPT ??
  "/home/deepnoa/deepnoa-registry/scripts/retrieve-governed.sh";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-retrieval/governed-retrieval-proof.json",
);

const SCRIPT_TIMEOUT_MS = 20_000;
const SCRIPT_MAX_BUFFER = 2 * 1024 * 1024;

export type RetrieveRequest = {
  id?: string | null;
  query?: string | null;
  limit?: number | null;
};

export type RetrieveFailure = {
  ok: false;
  status: number;
  error: string;
};

export type RetrieveSuccess = {
  ok: true;
  classification: string;
  retrieval_allowed: boolean;
  retrieved_count: number;
  blocked_count: number;
  result: Record<string, unknown>;
};

/**
 * Validate one retrieval request.
 * - Either id or query must be provided, not both.
 * - id must be a non-empty string with only safe characters.
 * - query must be a non-empty string.
 * - limit defaults to 5, hard cap 10.
 */
export function validateRetrieveRequest(
  rawId: unknown,
  rawQuery: unknown,
  rawLimit: unknown,
): { ok: true; id: string | null; query: string | null; limit: number } | RetrieveFailure {
  const id = typeof rawId === "string" ? rawId.trim() : null;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : null;

  if (!id && !query) {
    return { ok: false, status: 400, error: "invalid_request: one of 'id' or 'query' is required" };
  }
  if (id && query) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request: provide either 'id' or 'query', not both",
    };
  }
  if (id) {
    if (id.includes("\0") || id.includes("/") || id.includes("..")) {
      return { ok: false, status: 400, error: "invalid_id: id must not contain path characters" };
    }
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) {
      return { ok: false, status: 400, error: "invalid_id: id must be alphanumeric with _ or -" };
    }
  }
  if (query && query.includes("\0")) {
    return { ok: false, status: 400, error: "invalid_query: null byte not allowed" };
  }
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(10, Math.trunc(rawLimit)))
      : 5;

  return { ok: true, id: id || null, query: query || null, limit };
}

function summarize(text: string, max = 400): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…[truncated]` : trimmed;
}

async function writeProof(proof: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(PROOF_PATH), { recursive: true });
    await fs.writeFile(PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Execute governed manifest retrieval by shelling out to retrieve-governed.sh.
 */
export async function runGovernedRetrieval(
  id: string | null,
  query: string | null,
  limit: number,
): Promise<RetrieveSuccess | RetrieveFailure> {
  const args: string[] = [];
  if (id) {
    args.push("--id", id);
  } else if (query) {
    args.push("--query", query);
  }
  args.push("--limit", String(limit));

  const timestamp = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const res = await execFileAsync(RETRIEVE_SCRIPT, args, {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: SCRIPT_MAX_BUFFER,
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
  }

  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    raw = null;
  }

  const classification = typeof raw?.classification === "string" ? raw.classification : null;
  const retrievalAllowed = raw?.retrieval_allowed === true;
  const retrievedEntries = Array.isArray(raw?.retrieved_entries)
    ? (raw.retrieved_entries as unknown[]).length
    : 0;
  const blockedEntries = Array.isArray(raw?.blocked_entries)
    ? (raw.blocked_entries as unknown[]).length
    : 0;

  await writeProof({
    schema_version: "deepnoa.governed-retrieval-proof.v1",
    called_via: "openclaw-gateway:http:post:/nas/retrieve-governed",
    query_id: id,
    query_text: query,
    limit,
    classification: classification ?? (raw ? "WORKING" : "BROKEN"),
    retrieval_allowed: retrievalAllowed,
    retrieved_count: retrievedEntries,
    blocked_count: blockedEntries,
    exit_code: exitCode,
    stdout_summary: summarize(stdout),
    stderr_summary: summarize(stderr),
    timestamp,
    safety_constraints: (raw?.safety_constraints as Record<string, unknown>) ?? null,
  });

  if (!raw) {
    return {
      ok: false,
      status: 502,
      error: `retrieval_output_unparseable: exit=${exitCode} stderr=${summarize(stderr, 200)}`,
    };
  }

  return {
    ok: true,
    classification: classification ?? "UNKNOWN",
    retrieval_allowed: retrievalAllowed,
    retrieved_count: retrievedEntries,
    blocked_count: blockedEntries,
    result: raw,
  };
}
