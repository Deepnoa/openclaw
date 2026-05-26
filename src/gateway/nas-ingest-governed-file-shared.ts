import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The gateway never reimplements ingestion logic. It only shells out to the
// existing bounded single-file ingestion script. Both are overridable by env
// for staging, but default to the Ubuntu-ai runtime paths.
const INGEST_SCRIPT =
  process.env.DEEPNOA_INGEST_SCRIPT ??
  "/home/deepnoa/deepnoa-registry/scripts/ingest-governed-file.sh";

const REGISTRY_ROOT = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";

const PROOF_PATH = path.join(
  REGISTRY_ROOT,
  "observability/governed-file-ingestion/openclaw-gateway-ingestion-proof.json",
);

// Hard cap on script runtime; ingestion is bounded and must be fast.
const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 4 * 1024 * 1024;

export type IngestMode = "dry-run" | "execute";

// Defense-in-depth deny list at the gateway boundary. intake.py also enforces
// its own block patterns; this rejects secret-like files before we ever exec.
const DENY_BASENAME_PATTERNS: RegExp[] = [
  /\.env$/i,
  /\.env\./i,
  /(^|[._-])secret/i,
  /credential/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /\.p12$/i,
  /\.pfx$/i,
];

// Reject glob/expansion characters so a single explicit path cannot fan out.
const GLOB_CHARS = /[*?[\]{}]/u;

export type IngestDecisionObject = {
  decision: string | null;
  artifact_type: string | null;
  lifecycle_state: string | null;
  retrieval_allowed: boolean | null;
  export_allowed: boolean | null;
  sensitivity: string | null;
  blocked_reason: string | null;
  summary_path: string | null;
  manifest_entry_created: boolean;
  safety_flags: Record<string, unknown>;
};

export type IngestFailure = {
  ok: false;
  status: number;
  error: string;
};

export type IngestValidated = {
  ok: true;
  filePath: string;
  mode: IngestMode;
};

export type IngestSuccess = {
  ok: true;
  mode: IngestMode;
  input_path: string;
  decision: IngestDecisionObject;
  exit_code: number;
};

/**
 * Validate one explicit-file ingestion request.
 * - mode defaults to "dry-run"; only the two literals are accepted
 * - execute requires confirm=true explicitly — prevents accidental execution
 * - path must be a single absolute string, no "..", no glob, no null byte
 * - secret-like basenames are rejected at the gateway boundary
 */
export function validateIngestRequest(
  rawPath: unknown,
  rawMode: unknown,
  rawConfirm?: unknown,
): IngestValidated | IngestFailure {
  let mode: IngestMode = "dry-run";
  if (rawMode !== undefined && rawMode !== null) {
    if (rawMode !== "dry-run" && rawMode !== "execute") {
      return { ok: false, status: 400, error: "invalid_mode: must be 'dry-run' or 'execute'" };
    }
    mode = rawMode;
  }

  if (mode === "execute" && rawConfirm !== true) {
    return {
      ok: false,
      status: 400,
      error: "execute_requires_confirm: mode=execute requires confirm=true",
    };
  }

  if (typeof rawPath !== "string") {
    return { ok: false, status: 400, error: "invalid_path: must be a single string (no arrays)" };
  }
  const filePath = rawPath.trim();
  if (!filePath) {
    return { ok: false, status: 400, error: "invalid_path: empty path" };
  }
  if (filePath.includes("\0")) {
    return { ok: false, status: 400, error: "invalid_path: null byte not allowed" };
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, status: 400, error: "invalid_path: absolute path required" };
  }
  if (filePath.split(/[\\/]/u).includes("..")) {
    return { ok: false, status: 400, error: "invalid_path: '..' segments not allowed" };
  }
  if (GLOB_CHARS.test(filePath)) {
    return { ok: false, status: 400, error: "invalid_path: glob characters not allowed" };
  }
  const base = path.basename(filePath);
  for (const pattern of DENY_BASENAME_PATTERNS) {
    if (pattern.test(base)) {
      return {
        ok: false,
        status: 403,
        error: `blocked_path: secret-like file rejected at gateway (${base})`,
      };
    }
  }
  return { ok: true, filePath, mode };
}

function summarize(text: string, max = 600): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…[truncated]` : trimmed;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toDecisionObject(raw: Record<string, unknown>): IngestDecisionObject {
  const decision = asString(raw.decision);
  return {
    decision,
    artifact_type: asString(raw.artifact_type),
    lifecycle_state: asString(raw.lifecycle_state),
    retrieval_allowed: asBool(raw.retrieval_allowed),
    export_allowed: asBool(raw.export_allowed),
    sensitivity: asString(raw.sensitivity),
    blocked_reason: decision === "blocked" ? asString(raw.decision_reason) : null,
    summary_path: asString(raw.summary_ref),
    manifest_entry_created: raw.safe_manifest_entry != null,
    safety_flags: {
      raw_ingest_allowed: raw.raw_ingest_allowed ?? false,
      source_refs_followed: raw.source_refs_followed ?? false,
      recursive_scan: raw.recursive_scan ?? false,
      embeddings: raw.embeddings ?? false,
      trusted_index_mutation: raw.trusted_index_mutation ?? false,
      canonical_index_mutation: raw.canonical_index_mutation ?? false,
    },
  };
}

async function writeProof(proof: Record<string, unknown>): Promise<void> {
  // Proof write is best-effort observability; never fail the request on it.
  try {
    await fs.mkdir(path.dirname(PROOF_PATH), { recursive: true });
    await fs.writeFile(PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  } catch {
    // ignore
  }
}

/**
 * Run the bounded single-file governed ingestion script for one explicit path.
 * Verifies the path is a real, non-symlink, non-directory file before exec,
 * then shells out to ingest-governed-file.sh and parses its JSON decision.
 */
export async function runGovernedIngestion(
  filePath: string,
  mode: IngestMode,
): Promise<IngestSuccess | IngestFailure> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    return { ok: false, status: 404, error: "path_not_found" };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, status: 403, error: "blocked_path: symlink not allowed" };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      status: 400,
      error: "invalid_path: directory not allowed; one explicit file only",
    };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 400, error: "invalid_path: not a regular file" };
  }

  const args = ["--file", filePath];
  if (mode === "execute") {
    args.push("--execute");
  }

  const timestamp = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const res = await execFileAsync(INGEST_SCRIPT, args, {
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

  const decision = raw ? toDecisionObject(raw) : null;
  const classification = !raw ? "BROKEN" : exitCode !== 0 ? "PARTIAL" : "WORKING";

  await writeProof({
    schema_version: "deepnoa.openclaw-gateway-ingestion-proof.v1",
    called_via: "openclaw-gateway:http:post:/nas/ingest-governed-file",
    gateway_callable: raw != null,
    input_path: filePath,
    mode,
    decision: decision?.decision ?? null,
    exit_code: exitCode,
    stdout_summary: summarize(stdout),
    stderr_summary: summarize(stderr),
    timestamp,
    classification,
    manifest_entry_created: decision?.manifest_entry_created ?? false,
    safety_flags: decision?.safety_flags ?? null,
  });

  if (!raw || !decision) {
    return {
      ok: false,
      status: 502,
      error: `ingestion_output_unparseable: exit=${exitCode} stderr=${summarize(stderr, 200)}`,
    };
  }

  return {
    ok: true,
    mode,
    input_path: filePath,
    decision,
    exit_code: exitCode,
  };
}
