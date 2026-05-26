import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { runGovernedIngestion, validateIngestRequest } from "./nas-ingest-governed-file-shared.js";

// Ingestion requests are tiny ({path, mode}); keep the body cap small.
const DEFAULT_BODY_BYTES = 64 * 1024;

export async function handleNasIngestGovernedFileHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    maxBodyBytes?: number;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/nas/ingest-governed-file") {
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
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", allow: ["POST"] });
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as { path?: unknown; mode?: unknown; confirm?: unknown };

  const validated = validateIngestRequest(body.path, body.mode, body.confirm);
  if (!validated.ok) {
    sendJson(res, validated.status, { ok: false, error: validated.error });
    return true;
  }

  const result = await runGovernedIngestion(validated.filePath, validated.mode);
  if (!result.ok) {
    sendJson(res, result.status, { ok: false, error: result.error });
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    mode: result.mode,
    input_path: result.input_path,
    exit_code: result.exit_code,
    result: result.decision,
  });
  return true;
}
