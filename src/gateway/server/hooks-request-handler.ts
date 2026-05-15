import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveHookExternalContentSource as resolveHookExternalContentSourceFromSession } from "../../security/external-content.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
} from "../auth-rate-limit.js";
import { applyHookMappings } from "../hooks-mapping.js";
import {
  buildFormspreeInquiryId,
  buildFormspreeIntakeSession,
  buildFormspreeOpsHookMessage,
  buildFormspreeVisibleSessionMessage,
  buildOfficeUiIntakePayload,
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  getHookSessionKeyPrefixError,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
  isHookAgentAllowed,
  isSessionKeyAllowedByPrefix,
  normalizeAgentPayload,
  normalizeHookDispatchSessionKey,
  normalizeHookHeaders,
  normalizeWakePayload,
  readHookBody,
  readJsonBody,
  resolveHookChannel,
  resolveHookDeliver,
  resolveHookIdempotencyKey,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
} from "../hooks.js";
import { resolveRequestClientIp } from "../net.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_OFFICE_UI_INTAKE_URL = "http://127.0.0.1:19000/gateway/intake";
const DEFAULT_OLLAMA_URL = "http://192.168.11.11:11434";
const OFFICE_UI_INTAKE_TIMEOUT_MS = 2500;
const OLLAMA_HEALTH_TIMEOUT_MS = 2500;
const DOCUMENT_REQUEST_QUEUE_PATH = `${process.cwd()}/runs/queued-runtime-tasks.jsonl`;
const RUNTIME_EVENTS_PATH = `${process.cwd()}/runs/runtime-events.jsonl`;
const DOCUMENT_REQUEST_MAX_ATTEMPTS = 5;
const DOCUMENT_REQUEST_RUNTIME_GOAL = "Generate a reply email for a document request";
const DOCUMENT_REQUEST_RUNTIME_CONSTRAINTS = [
  "Do not include sensitive data",
  "Generate polite business Japanese",
];

export type HookClientIpConfig = Readonly<{
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}>;

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
};

type HookReplayEntry = {
  ts: number;
  runId: string;
};

type HookReplayScope = {
  pathKey: string;
  token: string | undefined;
  idempotencyKey?: string;
  dispatchScope: Record<string, unknown>;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function resolveMappedHookExternalContentSource(params: {
  subPath: string;
  payload: Record<string, unknown>;
  sessionKey: string;
}) {
  const payloadSource =
    typeof params.payload.source === "string" ? params.payload.source.trim().toLowerCase() : "";
  if (params.subPath === "gmail" || payloadSource === "gmail") {
    return "gmail" as const;
  }
  return resolveHookExternalContentSourceFromSession(params.sessionKey) ?? "webhook";
}

function resolveOfficeUiIntakeUrl(): string {
  const configured = process.env.OFFICE_UI_INTAKE_URL?.trim();
  return configured || DEFAULT_OFFICE_UI_INTAKE_URL;
}

function resolveOllamaBaseUrl(): string {
  const configured =
    process.env.OLLAMA_URL?.trim() ||
    process.env.OLLAMA_BASE_URL?.trim() ||
    process.env.OLLAMA_HOST?.trim();
  return configured || DEFAULT_OLLAMA_URL;
}

function buildDocumentRequestRuntimeTaskId(inquiryId: string): string {
  return `docreq-${inquiryId}`;
}

function buildDocumentRequestRuntimePayload(
  session: ReturnType<typeof buildFormspreeIntakeSession>,
) {
  return {
    goal: DOCUMENT_REQUEST_RUNTIME_GOAL,
    context: {
      category: session.public_event.category,
      service: session.routing.service?.trim() || "other",
    },
    constraints: DOCUMENT_REQUEST_RUNTIME_CONSTRAINTS,
  };
}

async function appendJsonlRecord(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function appendRuntimeEvent(event: {
  component: string;
  event_type: string;
  task_id?: string;
  role?: string;
  status?: string;
  exit_code?: number | null;
  runtime_status?: string | null;
  route_reason?: string | null;
}): Promise<void> {
  await appendJsonlRecord(RUNTIME_EVENTS_PATH, {
    timestamp: new Date().toISOString(),
    component: event.component,
    event_type: event.event_type,
    task_id: event.task_id ?? null,
    role: event.role ?? null,
    status: event.status ?? null,
    exit_code: event.exit_code ?? null,
    runtime_status: event.runtime_status ?? null,
    route_reason: event.route_reason ?? null,
  });
}

function buildDocumentRequestRuntimeQueueEntry(params: {
  taskId: string;
  session: ReturnType<typeof buildFormspreeIntakeSession>;
  reason: string;
  attempts?: number;
}) {
  const now = new Date().toISOString();
  return {
    task_id: params.taskId,
    role: "dev",
    task_type: "document_request_reply_draft",
    status: "queued",
    reason: params.reason,
    created_at: now,
    updated_at: now,
    attempts: Math.max(params.attempts ?? 0, 0),
    max_attempts: DOCUMENT_REQUEST_MAX_ATTEMPTS,
    payload: buildDocumentRequestRuntimePayload(params.session),
  };
}

async function enqueueDocumentRequestRuntimeTask(params: {
  taskId: string;
  session: ReturnType<typeof buildFormspreeIntakeSession>;
  reason: string;
  logHooks: SubsystemLogger;
  attempts?: number;
  extraEventType?: string;
}): Promise<void> {
  const entry = buildDocumentRequestRuntimeQueueEntry(params);
  await appendJsonlRecord(DOCUMENT_REQUEST_QUEUE_PATH, entry);
  await appendRuntimeEvent({
    component: "runtime",
    event_type: "runtime.queued",
    task_id: params.taskId,
    role: "dev",
    status: "queued",
    exit_code: null,
    runtime_status: "queued",
    route_reason: params.reason,
  });
  if (params.extraEventType) {
    await appendRuntimeEvent({
      component: "runtime",
      event_type: params.extraEventType,
      task_id: params.taskId,
      role: "dev",
      status: "queued",
      exit_code: null,
      runtime_status: "queued",
      route_reason: params.reason,
    });
  }
  params.logHooks.info?.(
    `[document-request-runtime] queued task_id=${params.taskId} reason=${params.reason} attempts=${entry.attempts}`,
  );
}

async function checkOllamaHealth(): Promise<{ online: boolean; reason: string; url: string }> {
  const url = `${resolveOllamaBaseUrl().replace(/\/+$/, "")}/api/tags`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (response.ok) {
      return { online: true, reason: `http_${response.status}`, url };
    }
    return { online: false, reason: `http_${response.status}`, url };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : error instanceof Error
          ? error.message
          : String(error);
    return { online: false, reason, url };
  } finally {
    clearTimeout(timeout);
  }
}

async function syncOfficeUiIntake(
  session: ReturnType<typeof buildFormspreeIntakeSession>,
  logHooks: SubsystemLogger,
  runtimeTaskId?: string,
  inquiryId?: string,
): Promise<void> {
  const url = resolveOfficeUiIntakeUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OFFICE_UI_INTAKE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOfficeUiIntakePayload(session, runtimeTaskId, inquiryId)),
      signal: controller.signal,
    });
    if (!response.ok) {
      logHooks.warn(
        `formspree hook Office UI intake sync failed status=${response.status} url=${url}`,
      );
      return;
    }
    logHooks.info?.(`formspree hook Office UI intake synced status=${response.status} url=${url}`);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : error instanceof Error
          ? error.message
          : String(error);
    logHooks.warn(`formspree hook Office UI intake sync failed error=${message} url=${url}`);
  } finally {
    clearTimeout(timeout);
  }
}

function shouldLaunchDocumentRequestRuntime(
  session: ReturnType<typeof buildFormspreeIntakeSession>,
): boolean {
  if (process.env.VITEST || process.env.OPENCLAW_DISABLE_INTAKE_RUNTIME === "1") {
    return false;
  }
  return session.public_event.category === "document_request";
}

async function launchDocumentRequestRuntime(
  session: ReturnType<typeof buildFormspreeIntakeSession>,
  inquiryId: string,
  logHooks: SubsystemLogger,
): Promise<string> {
  const taskId = buildDocumentRequestRuntimeTaskId(inquiryId);
  const health = await checkOllamaHealth();
  if (!health.online) {
    await appendRuntimeEvent({
      component: "runtime",
      event_type: "runtime.offline",
      task_id: taskId,
      role: "dev",
      status: "offline",
      exit_code: null,
      runtime_status: "offline",
      route_reason: `sense_offline:${health.reason}`,
    });
    logHooks.warn(
      `[document-request-runtime] task_id=${taskId} offline url=${health.url} reason=${health.reason}`,
    );
    await enqueueDocumentRequestRuntimeTask({
      taskId,
      session,
      reason: "sense_offline",
      logHooks,
    });
    return taskId;
  }

  const scriptPath = `${process.cwd()}/scripts/runtime/sense-runtime-manager-task.sh`;
  const runtimePayload = buildDocumentRequestRuntimePayload(session);
  const params = {
    role: "dev",
    task_id: taskId,
    context: runtimePayload.context,
    constraints: runtimePayload.constraints,
  };
  const child = spawn(
    scriptPath,
    [
      "--task",
      "reply_draft_document_request",
      "--input",
      runtimePayload.goal,
      "--params-json",
      JSON.stringify(params),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let terminalHandled = false;
  const enqueueLostTask = (reason: string, exitCode: number | null, signal?: string | null) => {
    if (terminalHandled) return;
    terminalHandled = true;
    void (async () => {
      await appendRuntimeEvent({
        component: "runtime",
        event_type: "runtime.exit",
        task_id: taskId,
        role: "dev",
        status: "failed",
        exit_code: exitCode,
        runtime_status: "failed",
        route_reason: signal ? `${reason}:signal:${signal}` : reason,
      });
      await appendRuntimeEvent({
        component: "runtime",
        event_type: "runtime.failed",
        task_id: taskId,
        role: "dev",
        status: "failed",
        exit_code: exitCode,
        runtime_status: "failed",
        route_reason: signal ? `${reason}:signal:${signal}` : reason,
      });
      await enqueueDocumentRequestRuntimeTask({
        taskId,
        session,
        reason,
        logHooks,
        attempts: 1,
        extraEventType: "runtime.requeued",
      });
    })().catch((error) => {
      logHooks.warn(
        `[document-request-runtime] task_id=${taskId} requeue failed error=${String(error)}`,
      );
    });
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.on("spawn", () => {
    void (async () => {
      await appendRuntimeEvent({
        component: "runtime",
        event_type: "runtime.spawned",
        task_id: taskId,
        role: "dev",
        status: "running",
        exit_code: null,
        runtime_status: "running",
        route_reason: null,
      });
      await appendRuntimeEvent({
        component: "runtime",
        event_type: "runtime.started",
        task_id: taskId,
        role: "dev",
        status: "running",
        exit_code: null,
        runtime_status: "running",
        route_reason: null,
      });
    })().catch((error) => {
      logHooks.warn(
        `[document-request-runtime] task_id=${taskId} spawn event failed error=${String(error)}`,
      );
    });
  });
  child.stdout.on("data", (chunk) => {
    const lines = String(chunk)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      logHooks.info?.(`[document-request-runtime] task_id=${taskId} stdout=${line}`);
    }
  });
  child.stderr.on("data", (chunk) => {
    const lines = String(chunk)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      logHooks.info?.(`[document-request-runtime] task_id=${taskId} ${line}`);
    }
  });
  child.on("error", (error) => {
    logHooks.warn(
      `[document-request-runtime] task_id=${taskId} launch failed error=${error.message}`,
    );
    enqueueLostTask("runtime_launch_error", null, null);
  });
  child.on("exit", (code, signal) => {
    logHooks.info?.(
      `[document-request-runtime] task_id=${taskId} exit_code=${code ?? -1} signal=${signal ?? "-"}`,
    );
    if ((code ?? 0) !== 0) {
      enqueueLostTask("runtime_exit_nonzero", code ?? null, signal);
      return;
    }
    if (terminalHandled) {
      return;
    }
    terminalHandled = true;
    void appendRuntimeEvent({
      component: "runtime",
      event_type: "runtime.exit",
      task_id: taskId,
      role: "dev",
      status: "completed",
      exit_code: code ?? 0,
      runtime_status: "completed",
      route_reason: signal ? `signal:${signal}` : null,
    }).catch((error) => {
      logHooks.warn(
        `[document-request-runtime] task_id=${taskId} exit event failed error=${String(error)}`,
      );
    });
  });
  logHooks.info?.(
    `[document-request-runtime] launched task_id=${taskId} category=${session.public_event.category}`,
  );
  return taskId;
}

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
    getClientIpConfig?: () => HookClientIpConfig;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook, getClientIpConfig } = opts;
  const hookReplayCache = new Map<string, HookReplayEntry>();
  const hookAuthLimiter = createAuthRateLimiter({
    maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
    windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    exemptLoopback: false,
    // Handler lifetimes are tied to gateway runtime/tests; skip background timer fanout.
    pruneIntervalMs: 0,
  });

  const resolveHookClientKey = (req: IncomingMessage): string => {
    const clientIpConfig = getClientIpConfig?.();
    const clientIp =
      resolveRequestClientIp(
        req,
        clientIpConfig?.trustedProxies,
        clientIpConfig?.allowRealIpFallback === true,
      ) ?? req.socket?.remoteAddress;
    return normalizeRateLimitClientIp(clientIp);
  };

  const pruneHookReplayCache = (now: number) => {
    const cutoff = now - DEDUPE_TTL_MS;
    for (const [key, entry] of hookReplayCache) {
      if (entry.ts < cutoff) {
        hookReplayCache.delete(key);
      }
    }
    while (hookReplayCache.size > DEDUPE_MAX) {
      const oldestKey = hookReplayCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      hookReplayCache.delete(oldestKey);
    }
  };

  const buildHookReplayCacheKey = (params: HookReplayScope): string | undefined => {
    const idem = params.idempotencyKey?.trim();
    if (!idem) {
      return undefined;
    }
    const tokenFingerprint = createHash("sha256")
      .update(params.token ?? "", "utf8")
      .digest("hex");
    const idempotencyFingerprint = createHash("sha256").update(idem, "utf8").digest("hex");
    const scopeFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          pathKey: params.pathKey,
          dispatchScope: params.dispatchScope,
        }),
        "utf8",
      )
      .digest("hex");
    return `${tokenFingerprint}:${scopeFingerprint}:${idempotencyFingerprint}`;
  };

  const resolveCachedHookRunId = (key: string | undefined, now: number): string | undefined => {
    if (!key) {
      return undefined;
    }
    pruneHookReplayCache(now);
    const cached = hookReplayCache.get(key);
    if (!cached) {
      return undefined;
    }
    hookReplayCache.delete(key);
    hookReplayCache.set(key, cached);
    return cached.runId;
  };

  const rememberHookRunId = (key: string | undefined, runId: string, now: number) => {
    if (!key) {
      return;
    }
    hookReplayCache.delete(key);
    hookReplayCache.set(key, { ts: now, runId });
    pruneHookReplayCache(now);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    // Only pathname/search are used here; keep the base host fixed so bind-host
    // representation (e.g. IPv6 wildcards) cannot break request parsing.
    const url = new URL(req.url ?? "/", "http://localhost");
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const isFormspreeHook = subPath === "formspree";
    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!isFormspreeHook && !safeEqualSecret(token, hooksConfig.token)) {
      const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      if (!throttle.allowed) {
        const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1000) : 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);

    const body = await (isFormspreeHook
      ? readHookBody(req, hooksConfig.maxBodyBytes)
      : readJsonBody(req, hooksConfig.maxBodyBytes));
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      if (isFormspreeHook) {
        logHooks.warn(`formspree hook rejected payload: ${body.error}`);
        sendJson(res, 200, { ok: true, source: "formspree", accepted: false, error: body.error });
        return true;
      }
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);
    const idempotencyKey = resolveHookIdempotencyKey({
      payload: payload as Record<string, unknown>,
      headers,
    });
    const now = Date.now();

    if (isFormspreeHook) {
      const intakeSession = buildFormspreeIntakeSession(payload as Record<string, unknown>);
      const event = intakeSession.public_event;
      const inquiryId = buildFormspreeInquiryId(intakeSession);
      logHooks.info?.(
        `formspree hook received category=${event.category} sender=${event.has_sender ? "yes" : "no"} subject=${event.has_subject ? "yes" : "no"} service=${intakeSession.routing.service ? "yes" : "no"}`,
      );
      let visibleRunId: string | undefined;
      let runId: string | undefined;
      let runtimeTaskId: string | undefined;
      try {
        const visibleSessionKey = resolveHookSessionKey({
          hooksConfig,
          source: "mapping-static",
          sessionKey: `hook:formspree:${inquiryId}`,
        });
        if (visibleSessionKey.ok) {
          const mainAgentId = resolveHookTargetAgentId(hooksConfig, "main");
          if (isHookAgentAllowed(hooksConfig, mainAgentId)) {
            const visibleSessionTitle = [
              "[HP]",
              intakeSession.routing.service?.trim() || event.category,
              `#${inquiryId}`,
            ]
              .filter(Boolean)
              .join(" ");
            visibleRunId = dispatchAgentHook({
              message: buildFormspreeVisibleSessionMessage(intakeSession),
              name: visibleSessionTitle,
              agentId: mainAgentId,
              wakeMode: "now",
              sessionKey: normalizeHookDispatchSessionKey({
                sessionKey: visibleSessionKey.value,
                targetAgentId: mainAgentId,
              }),
              sourcePath: `${basePath}/formspree`,
              deliver: true,
              channel: "last",
              externalContentSource: "webhook",
            });
          }
        }
        const opsSessionKey = resolveHookSessionKey({
          hooksConfig,
          source: "mapping-static",
          sessionKey: `hook:ops:formspree:${inquiryId}`,
        });
        const targetAgentId = resolveHookTargetAgentId(hooksConfig, "ops");
        if (opsSessionKey.ok && isHookAgentAllowed(hooksConfig, targetAgentId)) {
          const opsSessionTitle = [
            "[HP Inquiry]",
            intakeSession.routing.service?.trim() || event.category,
            `#${inquiryId}`,
          ]
            .filter(Boolean)
            .join(" ");
          runId = dispatchAgentHook({
            message: buildFormspreeOpsHookMessage(intakeSession),
            name: opsSessionTitle,
            agentId: targetAgentId,
            wakeMode: "now",
            sessionKey: normalizeHookDispatchSessionKey({
              sessionKey: opsSessionKey.value,
              targetAgentId,
            }),
            sourcePath: `${basePath}/formspree`,
            deliver: true,
            channel: "last",
            externalContentSource: "webhook",
          });
        }
      } catch (err) {
        logHooks.warn(`formspree hook dispatch failed: ${String(err)}`);
      }
      if (shouldLaunchDocumentRequestRuntime(intakeSession)) {
        runtimeTaskId = await launchDocumentRequestRuntime(intakeSession, inquiryId, logHooks);
      }
      await syncOfficeUiIntake(intakeSession, logHooks, runtimeTaskId, inquiryId);
      sendJson(res, 200, {
        ok: true,
        source: "formspree",
        event,
        intakeSession,
        runId,
        visibleRunId,
        runtimeTaskId,
        visibleSessionKey: `hook:formspree:${inquiryId}`,
      });
      return true;
    }

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        source: "request",
        sessionKey: normalized.value.sessionKey,
      });
      if (!sessionKey.ok) {
        sendJson(res, 400, { ok: false, error: sessionKey.error });
        return true;
      }
      const targetAgentId = resolveHookTargetAgentId(hooksConfig, normalized.value.agentId);
      const replayKey = buildHookReplayCacheKey({
        pathKey: "agent",
        token,
        idempotencyKey,
        dispatchScope: {
          agentId: targetAgentId ?? null,
          sessionKey:
            normalized.value.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
          message: normalized.value.message,
          name: normalized.value.name,
          wakeMode: normalized.value.wakeMode,
          deliver: normalized.value.deliver,
          channel: normalized.value.channel,
          to: normalized.value.to ?? null,
          model: normalized.value.model ?? null,
          thinking: normalized.value.thinking ?? null,
          timeoutSeconds: normalized.value.timeoutSeconds ?? null,
        },
      });
      const cachedRunId = resolveCachedHookRunId(replayKey, now);
      if (cachedRunId) {
        sendJson(res, 200, { ok: true, runId: cachedRunId });
        return true;
      }
      const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
        sessionKey: sessionKey.value,
        targetAgentId,
      });
      const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
      if (
        allowedPrefixes &&
        !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)
      ) {
        sendJson(res, 400, { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) });
        return true;
      }
      const runId = dispatchAgentHook({
        ...normalized.value,
        idempotencyKey,
        sessionKey: normalizedDispatchSessionKey,
        sourcePath: `${basePath}/agent`,
        agentId: targetAgentId,
        externalContentSource: "webhook",
      });
      rememberHookRunId(replayKey, runId, now);
      sendJson(res, 200, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source:
              mapped.action.sessionKeySource === "static" ? "mapping-static" : "mapping-templated",
            sessionKey: mapped.action.sessionKey,
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const targetAgentId = resolveHookTargetAgentId(hooksConfig, mapped.action.agentId);
          const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
            sessionKey: sessionKey.value,
            targetAgentId,
          });
          const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
          if (
            allowedPrefixes &&
            !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)
          ) {
            sendJson(res, 400, { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) });
            return true;
          }
          const replayKey = buildHookReplayCacheKey({
            pathKey: subPath || "mapping",
            token,
            idempotencyKey,
            dispatchScope: {
              agentId: targetAgentId ?? null,
              sessionKey:
                mapped.action.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
              message: mapped.action.message,
              name: mapped.action.name ?? "Hook",
              wakeMode: mapped.action.wakeMode,
              deliver: resolveHookDeliver(mapped.action.deliver),
              channel,
              to: mapped.action.to ?? null,
              model: mapped.action.model ?? null,
              thinking: mapped.action.thinking ?? null,
              timeoutSeconds: mapped.action.timeoutSeconds ?? null,
            },
          });
          const cachedRunId = resolveCachedHookRunId(replayKey, now);
          if (cachedRunId) {
            sendJson(res, 200, { ok: true, runId: cachedRunId });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            idempotencyKey,
            agentId: targetAgentId,
            wakeMode: mapped.action.wakeMode,
            sessionKey: normalizedDispatchSessionKey,
            sourcePath: `${basePath}/${subPath}`,
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
            externalContentSource: resolveMappedHookExternalContentSource({
              subPath,
              payload: payload as Record<string, unknown>,
              sessionKey: sessionKey.value,
            }),
          });
          rememberHookRunId(replayKey, runId, now);
          sendJson(res, 200, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}
