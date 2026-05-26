import fs from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const NAS_ROOT = "/mnt/nas";
const RAG_SAFE_MANIFEST_REL_PATH = "registry/indexes/rag-safe-index-cards.jsonl";

function resolveInsideRoot(root: string, relPath: string): string {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, relPath);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escapes NAS root: ${relPath}`);
  }
  return abs;
}

async function readManifestHealth() {
  const manifestPath = resolveInsideRoot(NAS_ROOT, RAG_SAFE_MANIFEST_REL_PATH);
  const result = {
    manifest_path: manifestPath,
    manifest_read_ok: false,
    entry_count: 0,
    jsonl_valid: false,
    invalid_line_count: 0,
    first_invalid_line: null as number | null,
    raw_ingest_allowed_violations: 0,
    source_refs_followed: false,
    raw_files_read: false,
    recursive_scan: false,
    embeddings: false,
    trusted_canonical_mutation: false,
  };

  const text = await fs.readFile(manifestPath, "utf8");
  result.manifest_read_ok = true;
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    result.entry_count += 1;
    try {
      const item = JSON.parse(line) as { raw_ingest_allowed?: unknown };
      if (item.raw_ingest_allowed !== false) {
        result.raw_ingest_allowed_violations += 1;
      }
    } catch {
      result.invalid_line_count += 1;
      result.first_invalid_line ??= index + 1;
    }
  }
  result.jsonl_valid = result.invalid_line_count === 0;
  return result;
}

export const nasManifestHealthHandlers: GatewayRequestHandlers = {
  "nas.manifestHealth": async ({ respond }) => {
    try {
      respond(true, await readManifestHealth(), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          err instanceof Error ? err.message : "failed to read NAS manifest health",
        ),
      );
    }
  },
};
