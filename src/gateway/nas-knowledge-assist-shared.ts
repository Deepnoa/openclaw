import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ORCHESTRATE_SCRIPT =
  process.env.DEEPNOA_ORCHESTRATE_SCRIPT ??
  "/home/deepnoa/deepnoa-registry/scripts/orchestrate-knowledge.sh";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/knowledge-orchestration/knowledge-orchestration-proof.json",
);

const SCRIPT_TIMEOUT_MS = 60_000;
const SCRIPT_MAX_BUFFER = 8 * 1024 * 1024;

const VALID_ACTIONS = new Set(["discover", "retrieve", "ingest_dry_run", "propose"]);
const ALLOWED_ROOT_ALIASES = new Set([
  "registry",
  "openclaw_docs",
  "nas_registry",
  "nas_knowledge",
]);

export type AssistRequest = {
  action: string;
  query?: string | null;
  path?: string | null;
  id?: string | null;
  roots?: string[] | null;
  limit?: number | null;
};

export type AssistFailure = {
  ok: false;
  status: number;
  error: string;
};

export type AssistSuccess = {
  ok: true;
  action: string;
  classification: string;
  confirmation_required: boolean;
  result: Record<string, unknown>;
};

export function validateAssistRequest(
  rawAction: unknown,
  rawQuery: unknown,
  rawPath: unknown,
  rawId: unknown,
  rawRoots: unknown,
  rawLimit: unknown,
):
  | {
      ok: true;
      action: string;
      query: string | null;
      filePath: string | null;
      id: string | null;
      roots: string[] | null;
      limit: number;
    }
  | AssistFailure {
  if (typeof rawAction !== "string" || !rawAction.trim()) {
    return { ok: false, status: 400, error: "invalid_request: 'action' is required" };
  }
  const action = rawAction.trim();
  if (!VALID_ACTIONS.has(action)) {
    return {
      ok: false,
      status: 400,
      error: `invalid_action: '${action}'. Valid actions: ${[...VALID_ACTIONS].toSorted().join(", ")}`,
    };
  }

  const query = typeof rawQuery === "string" && rawQuery.trim() ? rawQuery.trim() : null;
  if (query && query.includes("\0")) {
    return { ok: false, status: 400, error: "invalid_query: null byte not allowed" };
  }
  if (query && query.length > 200) {
    return { ok: false, status: 400, error: "invalid_query: too long (max 200 chars)" };
  }

  const filePath = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : null;
  if (filePath) {
    if (filePath.includes("\0") || filePath.includes("..")) {
      return {
        ok: false,
        status: 400,
        error: "invalid_path: path must not contain null bytes or ..",
      };
    }
    if (!path.isAbsolute(filePath)) {
      return { ok: false, status: 400, error: "invalid_path: path must be absolute" };
    }
  }

  const id = typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
  if (id) {
    if (id.includes("\0") || id.includes("/") || id.includes("..")) {
      return { ok: false, status: 400, error: "invalid_id: must not contain path characters" };
    }
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) {
      return { ok: false, status: 400, error: "invalid_id: must be alphanumeric with _ or -" };
    }
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
          error: `forbidden_root: '${alias}' not allowed. Allowed: ${[...ALLOWED_ROOT_ALIASES].join(", ")}`,
        };
      }
      cleaned.push(alias);
    }
    roots = cleaned.length > 0 ? cleaned : null;
  }

  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(20, Math.trunc(rawLimit)))
      : 5;

  return { ok: true, action, query, filePath, id, roots, limit };
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

export async function runKnowledgeOrchestration(
  action: string,
  query: string | null,
  filePath: string | null,
  id: string | null,
  roots: string[] | null,
  limit: number,
): Promise<AssistSuccess | AssistFailure> {
  const args: string[] = ["--action", action, "--limit", String(limit)];
  if (query) {
    args.push("--query", query);
  }
  if (filePath) {
    args.push("--path", filePath);
  }
  if (id) {
    args.push("--id", id);
  }
  if (roots && roots.length > 0) {
    args.push("--roots", roots.join(","));
  }

  const timestamp = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const res = await execFileAsync(ORCHESTRATE_SCRIPT, args, {
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
  const orch = (raw?.orchestration ?? {}) as Record<string, unknown>;
  const confirmationRequired = orch.confirmation_required === true;

  await writeProof({
    schema_version: "deepnoa.knowledge-orchestration-proof.v1",
    called_via: "openclaw-gateway:http:post:/nas/knowledge-assist",
    action,
    query,
    path: filePath,
    id,
    roots,
    limit,
    classification: classification ?? (raw ? "WORKING" : "BROKEN"),
    routed_to: orch.routed_to ?? [],
    confirmation_required: confirmationRequired,
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
      error: `orchestration_output_unparseable: exit=${exitCode} stderr=${summarize(stderr, 200)}`,
    };
  }

  return {
    ok: true,
    action,
    classification: classification ?? "UNKNOWN",
    confirmation_required: confirmationRequired,
    result: raw,
  };
}
