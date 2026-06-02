import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { runKnowledgeOrchestration, validateAssistRequest } from "./nas-knowledge-assist-shared.js";
import {
  appendConsumptionEvent,
  buildConsumptionEventFromAssist,
} from "./nas-knowledge-consumption.js";
import {
  appendRetrievalHistoryRecords,
  buildRetrievalHistoryRecordsFromAssist,
} from "./nas-knowledge-retrieval-history.js";

const DEFAULT_BODY_BYTES = 64 * 1024;

export async function handleNasKnowledgeAssistHttpRequest(
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
  if (url.pathname !== "/nas/knowledge-assist") {
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
  const body = (bodyUnknown ?? {}) as {
    action?: unknown;
    query?: unknown;
    path?: unknown;
    id?: unknown;
    roots?: unknown;
    limit?: unknown;
  };

  const validated = validateAssistRequest(
    body.action,
    body.query,
    body.path,
    body.id,
    body.roots,
    body.limit,
  );
  if (!validated.ok) {
    sendJson(res, validated.status, { ok: false, error: validated.error });
    return true;
  }

  const result = await runKnowledgeOrchestration(
    validated.action,
    validated.query,
    validated.filePath,
    validated.id,
    validated.roots,
    validated.limit,
  );

  if (!result.ok) {
    sendJson(res, result.status, { ok: false, error: result.error });
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    action: result.action,
    classification: result.classification,
    confirmation_required: result.confirmation_required,
    result: result.result,
  });

  // Append-only consumption tracking (Item 5). Fire-and-forget after the response
  // is sent so a logging failure can never affect the user flow. Records only
  // manifest ids + outcome — no query text, content, paths, or identity.
  const consumptionEvent = buildConsumptionEventFromAssist(
    result.action,
    result.result as Record<string, unknown> | null,
  );
  if (consumptionEvent) {
    appendConsumptionEvent(consumptionEvent);
  }

  // Phase C P4 — append-only per-(event, manifest) retrieval history. Same
  // fire-and-forget posture as consumption tracking; query is hard-null until
  // the P5 privacy decision lands. Default source is operator_ui because the
  // assist endpoint is the operator-driven entry point.
  appendRetrievalHistoryRecords(
    buildRetrievalHistoryRecordsFromAssist(
      result.action,
      result.result as Record<string, unknown> | null,
      { source: "operator_ui", actor: null },
    ),
  );
  return true;
}
