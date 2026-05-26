import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../../src/plugins/types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = "/mnt/nas";
const DEFAULT_MAX_READ_BYTES = 200_000;
const DEFAULT_MAX_LIST_ENTRIES = 200;
const DEFAULT_MAX_SEARCH_RESULTS = 50;

type NasPluginConfig = {
  root?: string;
  maxReadBytes?: number;
  maxListEntries?: number;
  maxSearchResults?: number;
};

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

function getConfig(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as NasPluginConfig;
  return {
    root: (pluginConfig.root?.trim() || process.env.OPENCLAW_NAS_ROOT || DEFAULT_ROOT).trim(),
    maxReadBytes:
      typeof pluginConfig.maxReadBytes === "number" && pluginConfig.maxReadBytes > 1_024
        ? Math.trunc(pluginConfig.maxReadBytes)
        : DEFAULT_MAX_READ_BYTES,
    maxListEntries:
      typeof pluginConfig.maxListEntries === "number" && pluginConfig.maxListEntries > 0
        ? Math.trunc(pluginConfig.maxListEntries)
        : DEFAULT_MAX_LIST_ENTRIES,
    maxSearchResults:
      typeof pluginConfig.maxSearchResults === "number" && pluginConfig.maxSearchResults > 0
        ? Math.trunc(pluginConfig.maxSearchResults)
        : DEFAULT_MAX_SEARCH_RESULTS,
  };
}

function normalizeRelPath(rawPath: unknown): string {
  if (typeof rawPath !== "string") {
    return ".";
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "/") {
    return ".";
  }
  if (trimmed === DEFAULT_ROOT) {
    return ".";
  }
  if (trimmed.startsWith(DEFAULT_ROOT + "/")) {
    return trimmed.slice(DEFAULT_ROOT.length + 1);
  }
  return trimmed.replace(/^\/+/, "");
}

function looksLikeFilenameQuery(rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) {
    return false;
  }
  return /[\\/]/.test(q) || /\.[A-Za-z0-9]{2,8}$/.test(q) || /[_-]/.test(q);
}

function resolveInsideRoot(root: string, relPath: string): string {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, relPath);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escapes NAS root: ${relPath}`);
  }
  return abs;
}

function toRelPath(root: string, absPath: string): string {
  const rel = path.relative(path.resolve(root), absPath);
  return rel || ".";
}

async function assertExists(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`path not found: ${targetPath}`);
  }
}

async function listDirectory(params: { root: string; relPath: string; limit: number }): Promise<{
  root: string;
  path: string;
  total: number;
  shown: number;
  entries: Array<{ name: string; path: string; type: "file" | "dir" | "other" }>;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const dirents = await fs.readdir(absPath, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  const sliced = dirents.slice(0, params.limit);
  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    total: dirents.length,
    shown: sliced.length,
    entries: sliced.map((d) => ({
      name: d.name,
      path: toRelPath(params.root, path.join(absPath, d.name)),
      type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
    })),
  };
}

async function runSearch(params: {
  root: string;
  relPath: string;
  query: string;
  maxResults: number;
}): Promise<{
  root: string;
  path: string;
  query: string;
  count: number;
  truncated: boolean;
  matches: Array<{ file: string; line: number; text: string }>;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const max = Math.max(1, Math.min(500, params.maxResults));

  const args = [
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--hidden",
    "--max-count",
    String(max),
    params.query,
    absPath,
  ];

  let stdout = "";
  try {
    const res = await execFileAsync("rg", args, { maxBuffer: 5 * 1024 * 1024 });
    stdout = res.stdout ?? "";
  } catch (error) {
    const err = error as { stdout?: string; code?: number | string };
    if (err.code === 1) {
      stdout = err.stdout ?? "";
    } else {
      throw new Error("ripgrep (rg) is required for nas_search", { cause: error });
    }
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const matches = lines.slice(0, max).map((line) => {
    const first = line.indexOf(":");
    const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
    if (first < 0 || second < 0) {
      return { file: line, line: 0, text: "" };
    }
    const absFile = line.slice(0, first);
    const lineNum = Number.parseInt(line.slice(first + 1, second), 10);
    const text = line.slice(second + 1);
    return {
      file: toRelPath(params.root, absFile),
      line: Number.isFinite(lineNum) ? lineNum : 0,
      text,
    };
  });

  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    query: params.query,
    count: matches.length,
    truncated: lines.length > max,
    matches,
  };
}

async function runFilenameSearch(params: {
  root: string;
  relPath: string;
  query: string;
  maxResults: number;
}): Promise<{
  root: string;
  path: string;
  query: string;
  count: number;
  truncated: boolean;
  matches: Array<{ file: string }>;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const max = Math.max(1, Math.min(500, params.maxResults));
  const needle = params.query.trim().toLocaleLowerCase();
  if (!needle) {
    return {
      root: path.resolve(params.root),
      path: toRelPath(params.root, absPath),
      query: params.query,
      count: 0,
      truncated: false,
      matches: [],
    };
  }

  let stdout = "";
  try {
    const res = await execFileAsync("rg", ["--files", "--hidden", absPath], {
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = res.stdout ?? "";
  } catch (error) {
    const err = error as { stdout?: string; code?: number | string };
    if (err.code === 1) {
      stdout = err.stdout ?? "";
    } else {
      throw new Error("ripgrep (rg) is required for nas_search", { cause: error });
    }
  }

  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((absFile) => {
      const relFile = toRelPath(params.root, absFile);
      const baseName = path.basename(relFile);
      return (
        relFile.toLocaleLowerCase().includes(needle) ||
        baseName.toLocaleLowerCase().includes(needle)
      );
    });

  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    query: params.query,
    count: Math.min(files.length, max),
    truncated: files.length > max,
    matches: files.slice(0, max).map((absFile) => ({
      file: toRelPath(params.root, absFile),
    })),
  };
}

async function readFileWithinRoot(params: {
  root: string;
  relPath: string;
  maxReadBytes: number;
}): Promise<{
  root: string;
  path: string;
  bytes: number;
  truncated: boolean;
  content: string;
}> {
  const absPath = resolveInsideRoot(params.root, params.relPath);
  await assertExists(absPath);
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error("nas_read target must be a file");
  }

  const maxBytes = Math.max(1_024, Math.min(2_000_000, params.maxReadBytes));
  const full = await fs.readFile(absPath, "utf8");
  const truncated = Buffer.byteLength(full, "utf8") > maxBytes;
  const content = truncated ? full.slice(0, maxBytes) : full;

  return {
    root: path.resolve(params.root),
    path: toRelPath(params.root, absPath),
    bytes: Buffer.byteLength(content, "utf8"),
    truncated,
    content,
  };
}

async function summarizeFile(params: {
  root: string;
  relPath: string;
  maxReadBytes: number;
}): Promise<{
  root: string;
  path: string;
  lines: number;
  bytes: number;
  summary: string;
  previewHead: string[];
  previewTail: string[];
}> {
  const readRes = await readFileWithinRoot(params);
  const lines = readRes.content.split(/\r?\n/);
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  const head = nonEmpty.slice(0, 8);
  const tail = nonEmpty.slice(-8);

  const summaryParts: string[] = [];
  summaryParts.push(`Total lines: ${lines.length}`);
  summaryParts.push(`Read bytes: ${readRes.bytes}${readRes.truncated ? " (truncated)" : ""}`);
  if (head.length > 0) {
    summaryParts.push(`Starts with: ${head.slice(0, 2).join(" / ")}`);
  }
  if (tail.length > 0) {
    summaryParts.push(`Ends with: ${tail.slice(-2).join(" / ")}`);
  }

  return {
    root: readRes.root,
    path: readRes.path,
    lines: lines.length,
    bytes: readRes.bytes,
    summary: summaryParts.join(". "),
    previewHead: head,
    previewTail: tail,
  };
}

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

// ─── Governed single-file ingestion (agent skill) ────────────────────────────
// The tool calls ONLY the operator wrapper, never the gateway or ingestion
// script directly. Architecture stays:
//   agent/tool -> gateway-ingest-governed-file.sh -> gateway -> intake -> decision
const INGEST_WRAPPER =
  process.env.DEEPNOA_INGEST_WRAPPER ??
  "/home/deepnoa/deepnoa-registry/scripts/gateway-ingest-governed-file.sh";
const RETRIEVE_WRAPPER =
  process.env.DEEPNOA_RETRIEVE_WRAPPER ??
  "/home/deepnoa/deepnoa-registry/scripts/gateway-retrieve-governed.sh";
const DISCOVER_WRAPPER =
  process.env.DEEPNOA_DISCOVER_WRAPPER ??
  "/home/deepnoa/deepnoa-registry/scripts/gateway-discover-files.sh";
const ORCHESTRATE_WRAPPER =
  process.env.DEEPNOA_ORCHESTRATE_WRAPPER ??
  "/home/deepnoa/deepnoa-registry/scripts/gateway-knowledge-assist.sh";
const INGEST_REGISTRY = process.env.DEEPNOA_REGISTRY ?? "/home/deepnoa/deepnoa-registry";
const INGEST_SKILL_PROOF_PATH = path.join(
  INGEST_REGISTRY,
  "observability/governed-file-ingestion/openclaw-agent-skill-proof.json",
);
const INGEST_MEMORY_STATE = path.join(
  INGEST_REGISTRY,
  "observability/memory-coordination/memory-state.json",
);
const INGEST_LOOP_STATE = path.join(INGEST_REGISTRY, "observability/runtime-loop/loop-state.json");

const ingestModeValues = ["dry-run", "execute"] as const;

type IngestSkillResult = {
  classification: "ALLOWED" | "REVIEW_REQUIRED" | "BLOCKED" | "ERROR";
  decision: string | null;
  governance_status: string | null;
  mode: "dry-run" | "execute";
  input_path: string;
  retrieval_allowed: boolean | null;
  export_allowed: boolean | null;
  sensitivity: string | null;
  blocked_reason: string | null;
  summary_path: string | null;
  manifest_entry_created: boolean | null;
  runtime_pressure: string;
  runtime_pressure_note: string;
  tool_callable: boolean;
  wrapper_callable: boolean;
  gateway_callable: boolean;
  confirmation_required?: boolean;
  message?: string;
  wrapper_exit_code?: number;
};

async function readRuntimePressure(): Promise<string> {
  for (const [file, keys] of [
    [INGEST_MEMORY_STATE, ["pressure", "level"]],
    [INGEST_LOOP_STATE, ["domains", "memory_coordination", "pressure"]],
  ] as const) {
    try {
      const data = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
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

function pressureNote(runtimePressure: string, exportAllowed: boolean | null): string {
  if (exportAllowed !== true) {
    return "Not export-eligible; nothing would be published regardless of runtime pressure.";
  }
  if (runtimePressure.toLowerCase() === "critical") {
    return "export_allowed=true is a RAG-safe candidate only. Runtime pressure is CRITICAL: NAS snapshot export remains gated and would require human escalation.";
  }
  return "export_allowed=true is a RAG-safe candidate only. NAS snapshot export is a separate governance-gated step (runtime pressure aware).";
}

async function writeSkillProof(result: IngestSkillResult): Promise<void> {
  try {
    await fs.mkdir(path.dirname(INGEST_SKILL_PROOF_PATH), { recursive: true });
    const proof = {
      schema_version: "deepnoa.openclaw-agent-skill-proof.v1",
      called_via:
        "openclaw-agent-tool:nas_ingest_file -> operator-wrapper -> openclaw-gateway -> governed-ingestion",
      tool_callable: result.tool_callable,
      wrapper_callable: result.wrapper_callable,
      gateway_callable: result.gateway_callable,
      input_path: result.input_path,
      mode: result.mode,
      decision: result.decision,
      runtime_pressure: result.runtime_pressure,
      timestamp: new Date().toISOString(),
      classification: result.classification === "ERROR" ? "BROKEN" : "WORKING",
    };
    await fs.writeFile(INGEST_SKILL_PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  } catch {
    // proof is best-effort observability
  }
}

async function runGovernedIngestionSkill(rawParams: {
  path?: unknown;
  mode?: unknown;
  confirm?: unknown;
}): Promise<IngestSkillResult> {
  const filePath = typeof rawParams.path === "string" ? rawParams.path.trim() : "";
  const mode: "dry-run" | "execute" = rawParams.mode === "execute" ? "execute" : "dry-run";
  const confirm = rawParams.confirm === true;
  const runtimePressure = await readRuntimePressure();

  const base = (extra: Partial<IngestSkillResult>): IngestSkillResult => ({
    classification: "ERROR",
    decision: null,
    governance_status: null,
    mode,
    input_path: filePath,
    retrieval_allowed: null,
    export_allowed: null,
    sensitivity: null,
    blocked_reason: null,
    summary_path: null,
    manifest_entry_created: null,
    runtime_pressure: runtimePressure,
    runtime_pressure_note: pressureNote(runtimePressure, null),
    tool_callable: true,
    wrapper_callable: false,
    gateway_callable: false,
    ...extra,
  });

  if (!filePath) {
    return base({ message: "path required (absolute file path)" });
  }

  // Confirmation boundary: never auto-execute. execute needs explicit confirm:true.
  if (mode === "execute" && !confirm) {
    const result = base({
      classification: "REVIEW_REQUIRED",
      confirmation_required: true,
      message:
        "Execute requires explicit confirmation. Re-invoke nas_ingest_file with mode='execute' AND confirm=true after reviewing the dry-run decision.",
    });
    await writeSkillProof(result);
    return result;
  }

  const jsonOut = path.join(
    "/tmp",
    `nas-ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  const args = [
    "--file",
    filePath,
    mode === "execute" ? "--execute" : "--dry-run",
    "--json-out",
    jsonOut,
  ];

  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync(INGEST_WRAPPER, args, {
      timeout: 40_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
  }

  // Wrapper exit codes: 0 allowed, 10 review, 20 blocked, 2/3 validation/secret.
  // For validation/secret rejections the wrapper writes no JSON; surface as BLOCKED.
  let gatewayJson: Record<string, unknown> | null = null;
  try {
    gatewayJson = JSON.parse(await fs.readFile(jsonOut, "utf8")) as Record<string, unknown>;
  } catch {
    gatewayJson = null;
  } finally {
    await fs.rm(jsonOut, { force: true }).catch(() => {});
  }

  if (!gatewayJson) {
    // No structured response: validation/secret block (exit 2/3) or transport error.
    const blockedByGuard = exitCode === 2 || exitCode === 3;
    const result = base({
      classification: blockedByGuard ? "BLOCKED" : "ERROR",
      decision: blockedByGuard ? "blocked" : null,
      governance_status: blockedByGuard ? "BLOCKED" : "ERROR",
      wrapper_callable: true,
      gateway_callable: false,
      wrapper_exit_code: exitCode,
      blocked_reason: (stderr || stdout).trim().split("\n").pop() || "wrapper_rejected",
      message: blockedByGuard
        ? "Rejected at wrapper/gateway boundary before ingestion."
        : `wrapper error (exit ${exitCode})`,
    });
    await writeSkillProof(result);
    return result;
  }

  // Gateway-level rejection (ok:false) vs governed decision (ok:true)
  if (gatewayJson.ok !== true) {
    const result = base({
      classification: "BLOCKED",
      decision: "blocked",
      governance_status: "BLOCKED",
      wrapper_callable: true,
      gateway_callable: true,
      wrapper_exit_code: exitCode,
      blocked_reason:
        typeof gatewayJson.error === "string" ? gatewayJson.error : "gateway_rejected",
      message: "Rejected at gateway boundary.",
    });
    await writeSkillProof(result);
    return result;
  }

  const res = (gatewayJson.result ?? {}) as Record<string, unknown>;
  const decision = typeof res.decision === "string" ? res.decision : null;
  const classification: IngestSkillResult["classification"] =
    decision === "allowed"
      ? "ALLOWED"
      : decision === "review_required"
        ? "REVIEW_REQUIRED"
        : decision === "blocked"
          ? "BLOCKED"
          : "ERROR";
  const exportAllowed = typeof res.export_allowed === "boolean" ? res.export_allowed : null;

  const result: IngestSkillResult = {
    classification,
    decision,
    governance_status: classification,
    mode,
    input_path: filePath,
    retrieval_allowed: typeof res.retrieval_allowed === "boolean" ? res.retrieval_allowed : null,
    export_allowed: exportAllowed,
    sensitivity: typeof res.sensitivity === "string" ? res.sensitivity : null,
    blocked_reason: typeof res.blocked_reason === "string" ? res.blocked_reason : null,
    summary_path: typeof res.summary_path === "string" ? res.summary_path : null,
    manifest_entry_created:
      typeof res.manifest_entry_created === "boolean" ? res.manifest_entry_created : null,
    runtime_pressure: runtimePressure,
    runtime_pressure_note: pressureNote(runtimePressure, exportAllowed),
    tool_callable: true,
    wrapper_callable: true,
    gateway_callable: true,
    wrapper_exit_code: exitCode,
  };
  await writeSkillProof(result);
  return result;
}

// ─── Governed manifest retrieval (agent skill) ───────────────────────────────
// The tool calls ONLY the operator wrapper, never the gateway or script directly.
// Architecture: agent/tool -> gateway-retrieve-governed.sh -> gateway -> retrieve.py

const RETRIEVE_SKILL_PROOF_PATH = path.join(
  INGEST_REGISTRY,
  "observability/governed-retrieval/openclaw-agent-skill-proof.json",
);

type RetrieveSkillResult = {
  classification: "RETRIEVED" | "ALL_BLOCKED" | "NO_MATCH" | "NOT_FOUND" | "NO_MANIFEST" | "ERROR";
  retrieval_allowed: boolean;
  retrieved_count: number;
  blocked_count: number;
  query_id: string | null;
  query_text: string | null;
  runtime_pressure: string;
  runtime_pressure_note: string;
  tool_callable: boolean;
  wrapper_callable: boolean;
  gateway_callable: boolean;
  result?: Record<string, unknown>;
  error?: string;
};

async function writeRetrieveSkillProof(result: RetrieveSkillResult): Promise<void> {
  try {
    await fs.mkdir(path.dirname(RETRIEVE_SKILL_PROOF_PATH), { recursive: true });
    const proof = {
      schema_version: "deepnoa.governed-retrieval-agent-skill-proof.v1",
      called_via:
        "openclaw-agent-tool:nas_retrieve_governed -> operator-wrapper -> openclaw-gateway -> governed-retrieval",
      tool_callable: result.tool_callable,
      wrapper_callable: result.wrapper_callable,
      gateway_callable: result.gateway_callable,
      query_id: result.query_id,
      query_text: result.query_text,
      classification: result.classification,
      retrieval_allowed: result.retrieval_allowed,
      retrieved_count: result.retrieved_count,
      blocked_count: result.blocked_count,
      runtime_pressure: result.runtime_pressure,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(RETRIEVE_SKILL_PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

async function runGovernedRetrievalSkill(rawParams: {
  id?: unknown;
  query?: unknown;
  limit?: unknown;
}): Promise<RetrieveSkillResult> {
  const queryId = typeof rawParams.id === "string" ? rawParams.id.trim() : null;
  const queryText = typeof rawParams.query === "string" ? rawParams.query.trim() : null;
  const limit =
    typeof rawParams.limit === "number" && Number.isFinite(rawParams.limit)
      ? Math.max(1, Math.min(10, Math.trunc(rawParams.limit)))
      : 5;

  const runtimePressure = await readRuntimePressure();

  const base = (extra: Partial<RetrieveSkillResult>): RetrieveSkillResult => ({
    classification: "ERROR",
    retrieval_allowed: false,
    retrieved_count: 0,
    blocked_count: 0,
    query_id: queryId,
    query_text: queryText,
    runtime_pressure: runtimePressure,
    runtime_pressure_note: pressureNote(runtimePressure, null),
    tool_callable: true,
    wrapper_callable: false,
    gateway_callable: false,
    ...extra,
  });

  if (!queryId && !queryText) {
    return base({ error: "one of 'id' or 'query' is required" });
  }

  const args: string[] = [];
  if (queryId) {
    args.push("--id", queryId);
  } else if (queryText) {
    args.push("--query", queryText);
  }
  args.push("--limit", String(limit));

  const jsonOut = path.join(
    "/tmp",
    `nas-retrieve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  args.push("--json-out", jsonOut);

  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync(RETRIEVE_WRAPPER, args, {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
  }

  // Try json-out first, fall back to stdout
  let gatewayJson: Record<string, unknown> | null = null;
  try {
    gatewayJson = JSON.parse(await fs.readFile(jsonOut, "utf8")) as Record<string, unknown>;
  } catch {
    try {
      gatewayJson = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      gatewayJson = null;
    }
  } finally {
    await fs.rm(jsonOut, { force: true }).catch(() => {});
  }

  if (!gatewayJson) {
    const result = base({
      wrapper_callable: true,
      gateway_callable: false,
      error: `wrapper error (exit ${exitCode}): ${(stderr || stdout).trim().split("\n").pop() || "unknown"}`,
    });
    await writeRetrieveSkillProof(result);
    return result;
  }

  if (gatewayJson.ok !== true) {
    const result = base({
      wrapper_callable: true,
      gateway_callable: true,
      error: typeof gatewayJson.error === "string" ? gatewayJson.error : "gateway_rejected",
    });
    await writeRetrieveSkillProof(result);
    return result;
  }

  const inner = (gatewayJson.result ?? {}) as Record<string, unknown>;
  const classification = (inner.classification as RetrieveSkillResult["classification"]) ?? "ERROR";
  const retrievalAllowed = inner.retrieval_allowed === true;
  const retrievedCount = Array.isArray(inner.retrieved_entries)
    ? (inner.retrieved_entries as unknown[]).length
    : 0;
  const blockedCount = Array.isArray(inner.blocked_entries)
    ? (inner.blocked_entries as unknown[]).length
    : 0;

  const result: RetrieveSkillResult = {
    classification,
    retrieval_allowed: retrievalAllowed,
    retrieved_count: retrievedCount,
    blocked_count: blockedCount,
    query_id: queryId,
    query_text: queryText,
    runtime_pressure: runtimePressure,
    runtime_pressure_note: pressureNote(runtimePressure, null),
    tool_callable: true,
    wrapper_callable: true,
    gateway_callable: true,
    result: inner,
  };
  await writeRetrieveSkillProof(result);
  return result;
}

// ─── Bounded file discovery (agent skill) ────────────────────────────────────
// Metadata only. No content read. No auto-ingest.
// Architecture: agent/tool -> gateway-discover-files.sh -> gateway -> discover.py

const DISCOVER_SKILL_PROOF_PATH = path.join(
  INGEST_REGISTRY,
  "observability/file-discovery/openclaw-agent-skill-proof.json",
);

const ALLOWED_ROOT_ALIASES_HINT = "registry, openclaw_docs, nas_registry, nas_knowledge";

type DiscoverSkillResult = {
  classification: "CANDIDATES_FOUND" | "NO_MATCH" | "ERROR";
  candidates_returned: number;
  query: string;
  roots: string[] | null;
  tool_callable: boolean;
  wrapper_callable: boolean;
  gateway_callable: boolean;
  result?: Record<string, unknown>;
  error?: string;
};

async function writeDiscoverSkillProof(result: DiscoverSkillResult): Promise<void> {
  try {
    await fs.mkdir(path.dirname(DISCOVER_SKILL_PROOF_PATH), { recursive: true });
    const proof = {
      schema_version: "deepnoa.file-discovery-agent-skill-proof.v1",
      called_via:
        "openclaw-agent-tool:nas_discover_files -> operator-wrapper -> openclaw-gateway -> file-discovery",
      tool_callable: result.tool_callable,
      wrapper_callable: result.wrapper_callable,
      gateway_callable: result.gateway_callable,
      query: result.query,
      roots: result.roots,
      classification: result.classification,
      candidates_returned: result.candidates_returned,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(DISCOVER_SKILL_PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

async function runFileDiscoverySkill(rawParams: {
  query?: unknown;
  roots?: unknown;
  limit?: unknown;
}): Promise<DiscoverSkillResult> {
  const query = typeof rawParams.query === "string" ? rawParams.query.trim() : "";
  const rawRoots = rawParams.roots;
  const roots: string[] | null = Array.isArray(rawRoots)
    ? (rawRoots as unknown[]).filter((r): r is string => typeof r === "string").map((r) => r.trim())
    : null;
  const limit =
    typeof rawParams.limit === "number" && Number.isFinite(rawParams.limit)
      ? Math.max(1, Math.min(20, Math.trunc(rawParams.limit)))
      : 10;

  const base = (extra: Partial<DiscoverSkillResult>): DiscoverSkillResult => ({
    classification: "ERROR",
    candidates_returned: 0,
    query,
    roots,
    tool_callable: true,
    wrapper_callable: false,
    gateway_callable: false,
    ...extra,
  });

  if (!query) {
    return base({ error: "'query' is required" });
  }

  const args: string[] = ["--query", query, "--limit", String(limit)];
  if (roots && roots.length > 0) {
    args.push("--roots", roots.join(","));
  }

  const jsonOut = path.join(
    "/tmp",
    `nas-discover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  args.push("--json-out", jsonOut);

  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync(DISCOVER_WRAPPER, args, {
      timeout: 35_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
  }

  let gatewayJson: Record<string, unknown> | null = null;
  try {
    gatewayJson = JSON.parse(await fs.readFile(jsonOut, "utf8")) as Record<string, unknown>;
  } catch {
    try {
      gatewayJson = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      gatewayJson = null;
    }
  } finally {
    await fs.rm(jsonOut, { force: true }).catch(() => {});
  }

  if (!gatewayJson) {
    const result = base({
      wrapper_callable: true,
      gateway_callable: false,
      error: `wrapper error (exit ${exitCode}): ${(stderr || stdout).trim().split("\n").pop() || "unknown"}`,
    });
    await writeDiscoverSkillProof(result);
    return result;
  }

  if (gatewayJson.ok !== true) {
    const result = base({
      wrapper_callable: true,
      gateway_callable: true,
      error: typeof gatewayJson.error === "string" ? gatewayJson.error : "gateway_rejected",
    });
    await writeDiscoverSkillProof(result);
    return result;
  }

  const inner = (gatewayJson.result ?? {}) as Record<string, unknown>;
  const classification = (inner.classification as DiscoverSkillResult["classification"]) ?? "ERROR";
  const candidatesReturned =
    typeof inner.candidates_returned === "number" ? inner.candidates_returned : 0;

  const result: DiscoverSkillResult = {
    classification,
    candidates_returned: candidatesReturned,
    query,
    roots,
    tool_callable: true,
    wrapper_callable: true,
    gateway_callable: true,
    result: inner,
  };
  await writeDiscoverSkillProof(result);
  return result;
}

// ─── Knowledge Orchestration (agent skill) ───────────────────────────────────
// Safe orchestration layer over governed primitives.
// Routes NL intent to discover / retrieve / ingest_dry_run / propose.
// NEVER auto-executes ingest. Confirm boundary always enforced.

const ORCHESTRATE_SKILL_PROOF_PATH = path.join(
  INGEST_REGISTRY,
  "observability/knowledge-orchestration/openclaw-agent-skill-proof.json",
);

const VALID_ORCHESTRATE_ACTIONS = ["discover", "retrieve", "ingest_dry_run", "propose"] as const;
type OrchestrateAction = (typeof VALID_ORCHESTRATE_ACTIONS)[number];

type OrchestrationSkillResult = {
  classification: string;
  action: OrchestrateAction;
  confirmation_required: boolean;
  candidates_returned: number;
  retrieved_count: number;
  runtime_pressure: string;
  runtime_pressure_note: string;
  tool_callable: boolean;
  wrapper_callable: boolean;
  gateway_callable: boolean;
  result?: Record<string, unknown>;
  error?: string;
};

async function writeOrchestrationSkillProof(result: OrchestrationSkillResult): Promise<void> {
  try {
    await fs.mkdir(path.dirname(ORCHESTRATE_SKILL_PROOF_PATH), { recursive: true });
    const proof = {
      schema_version: "deepnoa.knowledge-orchestration-agent-skill-proof.v1",
      called_via:
        "openclaw-agent-tool:nas_knowledge_assist -> operator-wrapper -> openclaw-gateway -> orchestrate.py",
      tool_callable: result.tool_callable,
      wrapper_callable: result.wrapper_callable,
      gateway_callable: result.gateway_callable,
      action: result.action,
      classification: result.classification,
      confirmation_required: result.confirmation_required,
      candidates_returned: result.candidates_returned,
      retrieved_count: result.retrieved_count,
      runtime_pressure: result.runtime_pressure,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(ORCHESTRATE_SKILL_PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

async function runKnowledgeOrchestrationSkill(rawParams: {
  action?: unknown;
  query?: unknown;
  path?: unknown;
  id?: unknown;
  roots?: unknown;
  limit?: unknown;
}): Promise<OrchestrationSkillResult> {
  const rawAction = typeof rawParams.action === "string" ? rawParams.action.trim() : "";
  const action = VALID_ORCHESTRATE_ACTIONS.includes(rawAction as OrchestrateAction)
    ? (rawAction as OrchestrateAction)
    : "propose";

  const query = typeof rawParams.query === "string" ? rawParams.query.trim() : null;
  const filePath = typeof rawParams.path === "string" ? rawParams.path.trim() : null;
  const id = typeof rawParams.id === "string" ? rawParams.id.trim() : null;
  const rawRoots = rawParams.roots;
  const roots: string[] | null = Array.isArray(rawRoots)
    ? (rawRoots as unknown[]).filter((r): r is string => typeof r === "string").map((r) => r.trim())
    : null;
  const limit =
    typeof rawParams.limit === "number" && Number.isFinite(rawParams.limit)
      ? Math.max(1, Math.min(20, Math.trunc(rawParams.limit)))
      : 5;

  const runtimePressure = await readRuntimePressure();

  const base = (extra: Partial<OrchestrationSkillResult>): OrchestrationSkillResult => ({
    classification: "ERROR",
    action,
    confirmation_required: false,
    candidates_returned: 0,
    retrieved_count: 0,
    runtime_pressure: runtimePressure,
    runtime_pressure_note: pressureNote(runtimePressure, null),
    tool_callable: true,
    wrapper_callable: false,
    gateway_callable: false,
    ...extra,
  });

  const args: string[] = ["--action", action, "--limit", String(limit)];
  if (query) args.push("--query", query);
  if (filePath) args.push("--path", filePath);
  if (id) args.push("--id", id);
  if (roots && roots.length > 0) args.push("--roots", roots.join(","));

  const jsonOut = path.join(
    "/tmp",
    `nas-orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  args.push("--json-out", jsonOut);

  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync(ORCHESTRATE_WRAPPER, args, {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
  }

  let gatewayJson: Record<string, unknown> | null = null;
  try {
    gatewayJson = JSON.parse(await fs.readFile(jsonOut, "utf8")) as Record<string, unknown>;
  } catch {
    try {
      gatewayJson = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      gatewayJson = null;
    }
  } finally {
    await fs.rm(jsonOut, { force: true }).catch(() => {});
  }

  if (!gatewayJson) {
    const result = base({
      wrapper_callable: true,
      gateway_callable: false,
      error: `wrapper error (exit ${exitCode}): ${(stderr || stdout).trim().split("\n").pop() || "unknown"}`,
    });
    await writeOrchestrationSkillProof(result);
    return result;
  }

  if (gatewayJson.ok !== true) {
    const result = base({
      wrapper_callable: true,
      gateway_callable: true,
      error: typeof gatewayJson.error === "string" ? gatewayJson.error : "gateway_rejected",
    });
    await writeOrchestrationSkillProof(result);
    return result;
  }

  const inner = (gatewayJson.result ?? {}) as Record<string, unknown>;
  const orch = (inner.orchestration ?? {}) as Record<string, unknown>;
  const classification =
    typeof gatewayJson.classification === "string"
      ? gatewayJson.classification
      : typeof inner.classification === "string"
        ? inner.classification
        : "UNKNOWN";
  const confirmationRequired =
    gatewayJson.confirmation_required === true || orch.confirmation_required === true;
  const candidatesReturned =
    typeof inner.candidates_returned === "number"
      ? inner.candidates_returned
      : Array.isArray(inner.candidates)
        ? (inner.candidates as unknown[]).length
        : 0;
  const retrievedCount = Array.isArray(inner.retrieved_entries)
    ? (inner.retrieved_entries as unknown[]).length
    : 0;

  const result: OrchestrationSkillResult = {
    classification,
    action,
    confirmation_required: confirmationRequired,
    candidates_returned: candidatesReturned,
    retrieved_count: retrievedCount,
    runtime_pressure: runtimePressure,
    runtime_pressure_note: pressureNote(runtimePressure, null),
    tool_callable: true,
    wrapper_callable: true,
    gateway_callable: true,
    result: inner,
  };
  await writeOrchestrationSkillProof(result);
  return result;
}

export function createNasTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const listParams = Type.Object(
    {
      path: Type.Optional(Type.String({ description: "Directory path under NAS root." })),
      limit: Type.Optional(
        Type.Number({
          description: "Max entries to return.",
          minimum: 1,
          maximum: 1000,
        }),
      ),
    },
    { additionalProperties: false },
  );

  const searchMode = ["content", "filename"] as const;
  const searchParams = Type.Object(
    {
      query: Type.String({ description: "Search text." }),
      path: Type.Optional(Type.String({ description: "Search base path under NAS root." })),
      maxResults: Type.Optional(
        Type.Number({ description: "Max matches.", minimum: 1, maximum: 500 }),
      ),
      mode: Type.Optional(
        stringEnum(searchMode, "Search mode (content uses ripgrep output text lines)."),
      ),
    },
    { additionalProperties: false },
  );

  const readParams = Type.Object(
    {
      file: Type.String({ description: "File path under NAS root." }),
      maxBytes: Type.Optional(
        Type.Number({ description: "Max bytes to read.", minimum: 1024, maximum: 2000000 }),
      ),
    },
    { additionalProperties: false },
  );

  const summaryParams = Type.Object(
    {
      file: Type.String({ description: "File path under NAS root." }),
      maxBytes: Type.Optional(
        Type.Number({ description: "Max bytes to read.", minimum: 1024, maximum: 2000000 }),
      ),
    },
    { additionalProperties: false },
  );

  const ingestParams = Type.Object(
    {
      path: Type.String({
        description: "Absolute path to ONE explicit file to govern-ingest.",
      }),
      mode: Type.Optional(
        stringEnum(
          ingestModeValues,
          "Ingestion mode. 'dry-run' (default) evaluates only; 'execute' persists and requires confirm=true.",
        ),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description:
            "Must be true to run mode='execute'. Ignored for dry-run. No auto-execute after dry-run.",
        }),
      ),
    },
    { additionalProperties: false },
  );

  return [
    {
      name: "nas_list",
      label: "NAS List",
      description: "List files/directories from NAS mount (default /mnt/nas).",
      parameters: listParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as { path?: unknown; limit?: unknown };
        const relPath = normalizeRelPath(params.path);
        const requestedLimit =
          typeof params.limit === "number" && Number.isFinite(params.limit)
            ? Math.trunc(params.limit)
            : cfg.maxListEntries;
        const limit = Math.max(1, Math.min(1000, requestedLimit));
        const result = await listDirectory({
          root: cfg.root,
          relPath,
          limit,
        });
        return jsonResult(result);
      },
    },
    {
      name: "nas_search",
      label: "NAS Search",
      description: "Search text within NAS files using ripgrep under NAS root.",
      parameters: searchParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as {
          query?: unknown;
          path?: unknown;
          maxResults?: unknown;
          mode?: unknown;
        };
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          throw new Error("query required");
        }
        const relPath = normalizeRelPath(params.path);
        const requestedMax =
          typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
            ? Math.trunc(params.maxResults)
            : cfg.maxSearchResults;
        const maxResults = Math.max(1, Math.min(500, requestedMax));

        if (params.mode === "filename" || (params.mode == null && looksLikeFilenameQuery(query))) {
          const listing = await runFilenameSearch({
            root: cfg.root,
            relPath,
            query,
            maxResults,
          });
          return jsonResult(listing);
        }

        const result = await runSearch({
          root: cfg.root,
          relPath,
          query,
          maxResults,
        });
        return jsonResult(result);
      },
    },
    {
      name: "nas_read",
      label: "NAS Read",
      description: "Read a text file from NAS root.",
      parameters: readParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as { file?: unknown; maxBytes?: unknown };
        const file = typeof params.file === "string" ? params.file.trim() : "";
        if (!file) {
          throw new Error("file required");
        }
        const maxBytes =
          typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
            ? Math.trunc(params.maxBytes)
            : cfg.maxReadBytes;
        const result = await readFileWithinRoot({
          root: cfg.root,
          relPath: normalizeRelPath(file),
          maxReadBytes: maxBytes,
        });
        return jsonResult(result);
      },
    },
    {
      name: "nas_summary",
      label: "NAS Summary",
      description: "Build a quick structural summary for a text file in NAS root.",
      parameters: summaryParams,
      execute: async (_id, rawParams) => {
        const cfg = getConfig(api);
        const params = rawParams as { file?: unknown; maxBytes?: unknown };
        const file = typeof params.file === "string" ? params.file.trim() : "";
        if (!file) {
          throw new Error("file required");
        }
        const maxBytes =
          typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
            ? Math.trunc(params.maxBytes)
            : cfg.maxReadBytes;
        const result = await summarizeFile({
          root: cfg.root,
          relPath: normalizeRelPath(file),
          maxReadBytes: maxBytes,
        });
        return jsonResult(result);
      },
    },
    {
      name: "nas_ingest_file",
      label: "NAS Governed Ingest",
      description:
        "Governed single-file NAS knowledge ingestion. Runs dry-run by default; " +
        "execute requires confirm=true. Calls the operator wrapper only " +
        "(agent -> wrapper -> gateway -> governed ingestion). Bounded: one explicit " +
        "file, no recursion, no embeddings, no raw retrieval, no canonical mutation, " +
        "no auto snapshot export.",
      parameters: ingestParams,
      execute: async (_id, rawParams) => {
        const params = rawParams as { path?: unknown; mode?: unknown; confirm?: unknown };
        const result = await runGovernedIngestionSkill(params);
        return jsonResult(result);
      },
    },
    {
      name: "nas_retrieve_governed",
      label: "NAS Governed Retrieval",
      description:
        "Governed NAS knowledge substrate retrieval. Returns only manifest summaries for " +
        "retrieval_allowed entries. Never exposes raw evidence, source_refs, or blocked " +
        "artifacts. Includes explainability (why allowed, governance state, export gate). " +
        "Bounded: manifest-driven only, no NAS traversal, no embeddings, no index mutation. " +
        "Use 'id' for exact manifest entry lookup or 'query' for title/type text match.",
      parameters: Type.Object(
        {
          id: Type.Optional(
            Type.String({
              description:
                "Exact manifest entry id (e.g. gfi_d193a2f87e6ec13b). Use this or 'query', not both.",
            }),
          ),
          query: Type.Optional(
            Type.String({
              description:
                "Text to match against manifest entry titles and artifact types. Use this or 'id', not both.",
            }),
          ),
          limit: Type.Optional(
            Type.Number({
              description: "Max entries to return (default 5, hard cap 10).",
              minimum: 1,
              maximum: 10,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, rawParams) => {
        const params = rawParams as { id?: unknown; query?: unknown; limit?: unknown };
        const result = await runGovernedRetrievalSkill(params);
        return jsonResult(result);
      },
    },
    {
      name: "nas_discover_files",
      label: "NAS File Discovery",
      description:
        "Bounded file discovery across approved roots. Returns metadata ONLY — " +
        "no raw file content is read. Operator must select a candidate explicitly, " +
        "then call nas_ingest_file (dry-run first) to govern-ingest, or " +
        "nas_retrieve_governed if the file is already in the manifest. " +
        `Allowed root aliases: ${ALLOWED_ROOT_ALIASES_HINT}. ` +
        "Do NOT use for secret files, full NAS traversal, or auto-ingestion.",
      parameters: Type.Object(
        {
          query: Type.String({
            description:
              "Text to match against filenames and path components (e.g. 'openclaw runtime report').",
          }),
          roots: Type.Optional(
            Type.Array(Type.String(), {
              description: `Root aliases to search. Allowed: ${ALLOWED_ROOT_ALIASES_HINT}. Omit to search all allowed roots.`,
            }),
          ),
          limit: Type.Optional(
            Type.Number({
              description: "Max candidates to return (default 10, hard cap 20).",
              minimum: 1,
              maximum: 20,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, rawParams) => {
        const params = rawParams as { query?: unknown; roots?: unknown; limit?: unknown };
        const result = await runFileDiscoverySkill(params);
        return jsonResult(result);
      },
    },
    {
      name: "nas_knowledge_assist",
      label: "NAS Knowledge Assist",
      description:
        "Unified governed orchestration over NAS knowledge substrate. " +
        "Routes intent to nas_discover_files, nas_retrieve_governed, or nas_ingest_file(dry-run). " +
        "Actions: 'discover' (find candidates), 'retrieve' (read manifest summaries), " +
        "'ingest_dry_run' (evaluate one file; confirmation required before execute), " +
        "'propose' (discover + retrieval-first recommendation). " +
        "NEVER auto-executes ingestion. NEVER bypasses governed tools. " +
        "NEVER reads raw content. Execute always requires explicit confirm=true re-call to nas_ingest_file.",
      parameters: Type.Object(
        {
          action: stringEnum(
            VALID_ORCHESTRATE_ACTIONS,
            "Orchestration action: discover (find files), retrieve (read manifest), ingest_dry_run (evaluate file), propose (discover + recommend).",
          ),
          query: Type.Optional(
            Type.String({
              description:
                "Natural-language query for discover / retrieve / propose actions " +
                "(e.g. 'OpenClaw runtime report', 'recovery anti-patterns').",
            }),
          ),
          path: Type.Optional(
            Type.String({
              description:
                "Absolute path to a single file for ingest_dry_run. Required for ingest_dry_run action.",
            }),
          ),
          id: Type.Optional(
            Type.String({
              description:
                "Exact manifest entry id (e.g. gfi_d193a2f87e6ec13b) for retrieve action exact lookup.",
            }),
          ),
          roots: Type.Optional(
            Type.Array(Type.String(), {
              description: `Root aliases to constrain discover (allowed: ${ALLOWED_ROOT_ALIASES_HINT}). Omit for all allowed roots.`,
            }),
          ),
          limit: Type.Optional(
            Type.Number({
              description: "Max candidates/entries to return (default 5, hard cap 20).",
              minimum: 1,
              maximum: 20,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, rawParams) => {
        const params = rawParams as {
          action?: unknown;
          query?: unknown;
          path?: unknown;
          id?: unknown;
          roots?: unknown;
          limit?: unknown;
        };
        const result = await runKnowledgeOrchestrationSkill(params);
        return jsonResult(result);
      },
    },
  ];
}
