import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { runFileDiscovery, validateDiscoverRequest } from "./nas-discover-files-shared.js";

const DEFAULT_BODY_BYTES = 32 * 1024;

export async function handleNasDiscoverFilesHttpRequest(
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
  if (url.pathname !== "/nas/discover-files") {
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
  const body = (bodyUnknown ?? {}) as { query?: unknown; roots?: unknown; limit?: unknown };

  const validated = validateDiscoverRequest(body.query, body.roots, body.limit);
  if (!validated.ok) {
    sendJson(res, validated.status, { ok: false, error: validated.error });
    return true;
  }

  const result = await runFileDiscovery(validated.query, validated.roots, validated.limit);
  if (!result.ok) {
    sendJson(res, result.status, { ok: false, error: result.error });
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    classification: result.classification,
    candidates_returned: result.candidates_returned,
    result: result.result,
  });
  return true;
}
