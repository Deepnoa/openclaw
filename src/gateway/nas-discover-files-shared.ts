import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DISCOVER_SCRIPT =
  process.env.DEEPNOA_DISCOVER_SCRIPT ?? "/home/deepnoa/deepnoa-registry/scripts/discover-files.sh";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/file-discovery/file-discovery-proof.json",
);

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 4 * 1024 * 1024;

// Roots that the gateway will pass through; anything outside this set is rejected.
const ALLOWED_ROOT_ALIASES = new Set([
  "registry",
  "openclaw_docs",
  "nas_registry",
  "nas_knowledge",
]);

export type DiscoverRequest = {
  query?: string | null;
  roots?: string[] | null;
  limit?: number | null;
};

export type DiscoverFailure = {
  ok: false;
  status: number;
  error: string;
};

export type DiscoverSuccess = {
  ok: true;
  classification: string;
  candidates_returned: number;
  result: Record<string, unknown>;
};

export function validateDiscoverRequest(
  rawQuery: unknown,
  rawRoots: unknown,
  rawLimit: unknown,
): { ok: true; query: string; roots: string[] | null; limit: number } | DiscoverFailure {
  if (typeof rawQuery !== "string" || !rawQuery.trim()) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request: 'query' is required (non-empty string)",
    };
  }
  const query = rawQuery.trim();
  if (query.includes("\0")) {
    return { ok: false, status: 400, error: "invalid_query: null byte not allowed" };
  }
  if (query.length > 200) {
    return { ok: false, status: 400, error: "invalid_query: query too long (max 200 chars)" };
  }

  let roots: string[] | null = null;
  if (rawRoots !== undefined && rawRoots !== null) {
    if (!Array.isArray(rawRoots)) {
      return {
        ok: false,
        status: 400,
        error: "invalid_roots: must be array of root alias strings",
      };
    }
    const cleaned: string[] = [];
    for (const r of rawRoots) {
      if (typeof r !== "string") {
        return { ok: false, status: 400, error: "invalid_roots: each root must be a string alias" };
      }
      const alias = r.trim();
      if (!ALLOWED_ROOT_ALIASES.has(alias)) {
        return {
          ok: false,
          status: 403,
          error: `forbidden_root: '${alias}' is not an allowed root alias. Allowed: ${[...ALLOWED_ROOT_ALIASES].join(", ")}`,
        };
      }
      cleaned.push(alias);
    }
    roots = cleaned.length > 0 ? cleaned : null;
  }

  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(20, Math.trunc(rawLimit)))
      : 10;

  return { ok: true, query, roots, limit };
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

export async function runFileDiscovery(
  query: string,
  roots: string[] | null,
  limit: number,
): Promise<DiscoverSuccess | DiscoverFailure> {
  const args: string[] = ["--query", query, "--limit", String(limit)];
  if (roots && roots.length > 0) {
    args.push("--roots", roots.join(","));
  }

  const timestamp = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const res = await execFileAsync(DISCOVER_SCRIPT, args, {
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
  const candidatesReturned =
    typeof raw?.candidates_returned === "number" ? raw.candidates_returned : 0;

  await writeProof({
    schema_version: "deepnoa.file-discovery-proof.v1",
    called_via: "openclaw-gateway:http:post:/nas/discover-files",
    query,
    roots,
    limit,
    classification: classification ?? (raw ? "WORKING" : "BROKEN"),
    candidates_returned: candidatesReturned,
    excluded_paths_count: raw?.excluded_paths_count ?? null,
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
      error: `discovery_output_unparseable: exit=${exitCode} stderr=${summarize(stderr, 200)}`,
    };
  }

  return {
    ok: true,
    classification: classification ?? "UNKNOWN",
    candidates_returned: candidatesReturned,
    result: raw,
  };
}
