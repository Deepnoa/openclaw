import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";

const INTERNAL_STATE_PATH = "/api/internal/state";
const INTERNAL_STATE_COMPAT_PATH = "/internal-state";
const RUNS_DIR = path.join(process.cwd(), "runs");
const RUNTIME_EVENTS_PATH = path.join(RUNS_DIR, "runtime-events.jsonl");
const QUEUED_RUNTIME_TASKS_PATH = path.join(RUNS_DIR, "queued-runtime-tasks.jsonl");
const ROLE_ORDER = ["ops", "dev", "research"] as const;

type RuntimeEventRecord = {
  timestamp?: string;
  component?: string;
  event_type?: string;
  task_id?: string | null;
  role?: string | null;
  status?: string | null;
  exit_code?: number | null;
  runtime_status?: string | null;
  route_reason?: string | null;
};

type QueueRecord = {
  task_id?: string;
  role?: string;
  task_type?: string;
  status?: string;
  reason?: string;
  created_at?: string;
  updated_at?: string;
  attempts?: number;
  max_attempts?: number;
  payload?: {
    goal?: string;
    context?: {
      category?: string;
      service?: string;
    };
    constraints?: string[];
  };
};

type RunStateRecord = {
  task_id?: string;
  role?: string;
  goal?: string;
  context?: {
    category?: string;
    service?: string;
  };
  status?: string;
  result?: string;
  done?: boolean;
  current_plan?: unknown;
  last_observation?: string;
};

type TaskSnapshot = {
  taskId: string;
  role: string;
  status: "queued" | "running" | "completed" | "failed";
  updatedAt: string;
  createdAt: string;
  routeReason?: string;
  attempts: number;
  maxAttempts: number;
  category: string;
  service: string;
  summary: string;
  hasResult: boolean;
};

type InternalStateResponse = {
  schema_version: string;
  surface: "internal";
  transport: "polling-ready / compatibility";
  office: {
    name: string;
    mode: string;
    public_host: string;
    gateway_host: string;
  };
  manager: {
    updated_at: string;
    gateway: {
      status: string;
      detail: string;
      updated_at: string;
    };
    routing: Record<string, string>;
    fallback_worker: {
      key: string;
      name: string;
      role: string;
      profile: string;
      allowed_tools: string[];
      status: string;
      updated_at: string;
    };
  };
  summary: {
    active_agents: number;
    active_tasks: number;
    blocked: number;
    awaiting_approval: number;
    done_today: number;
    alerts: number;
    status: string;
  };
  roles: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  failed: Array<Record<string, unknown>>;
  connectors: Array<Record<string, unknown>>;
  completed: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  intake: Array<Record<string, unknown>>;
  assets: Record<string, unknown>;
  policies: Record<string, unknown>;
};

const OFFICE_INFO = {
  name: "Deepnoa AI Office",
  mode: "internal-control-view",
  public_host: "deepnoa.com",
  gateway_host: "bot.deepnoa.com",
} as const;

const ROUTING_MAP: Record<string, string> = {
  document_request: "dev",
  inquiry: "ops",
  consultation: "ops",
  sales: "ops",
  other: "ops",
  github_webhook: "dev",
  cron_check: "ops",
  system_check: "ops",
  research_task: "research",
  public_summary: "research",
};

const ROLE_DEFINITIONS = {
  ops: {
    key: "ops",
    name: "Ops Agent",
    role: "Operations",
    profile: "Routes cron jobs, service health, intake triage, and infrastructure coordination.",
    allowed_tools: ["group:sessions", "exec", "process", "sense-worker"],
    idle_label: "Standing watch",
  },
  dev: {
    key: "dev",
    name: "Dev Agent",
    role: "Engineering",
    profile: "Routes coding, implementation, runtime work, and document reply generation.",
    allowed_tools: ["profile:coding", "sense-worker"],
    idle_label: "Standby",
  },
  research: {
    key: "research",
    name: "Research Agent",
    role: "Research",
    profile: "Routes public research, summaries, scanning, and briefing preparation.",
    allowed_tools: ["group:web", "group:sessions", "group:memory"],
    idle_label: "Ready to scan",
  },
} as const;

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeIso(value: string | undefined | null): string {
  const trimmed = normalizeOptionalString(value ?? undefined);
  return trimmed ?? new Date(0).toISOString();
}

function isToday(isoValue: string): boolean {
  const value = new Date(isoValue);
  const now = new Date();
  return (
    Number.isFinite(value.getTime()) &&
    value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate()
  );
}

function summarizeTask(params: {
  category: string;
  service: string;
  status: TaskSnapshot["status"];
}): string {
  const category = params.category || "other";
  const service = params.service || "other";
  if (params.status === "failed") {
    return `Runtime failed for ${category} (${service})`;
  }
  if (params.status === "queued") {
    return `Queued ${category} request (${service})`;
  }
  if (params.status === "running") {
    return `Processing ${category} request (${service})`;
  }
  return `Completed ${category} request (${service})`;
}

function buildTaskFromQueue(entry: QueueRecord): TaskSnapshot | null {
  const taskId = normalizeOptionalString(entry.task_id);
  if (!taskId) {
    return null;
  }
  const role = normalizeOptionalString(entry.role) ?? "dev";
  const category = normalizeOptionalString(entry.payload?.context?.category) ?? "other";
  const service = normalizeOptionalString(entry.payload?.context?.service) ?? "other";
  const status =
    entry.status === "completed" || entry.status === "failed" || entry.status === "running"
      ? entry.status
      : "queued";
  const updatedAt = normalizeIso(entry.updated_at ?? entry.created_at);
  return {
    taskId,
    role,
    status,
    updatedAt,
    createdAt: normalizeIso(entry.created_at ?? entry.updated_at),
    routeReason: normalizeOptionalString(entry.reason) ?? undefined,
    attempts: Math.max(0, entry.attempts ?? 0),
    maxAttempts: Math.max(1, entry.max_attempts ?? 5),
    category,
    service,
    summary: summarizeTask({ category, service, status }),
    hasResult: status === "completed",
  };
}

function applyRuntimeEvent(
  task: TaskSnapshot | undefined,
  event: RuntimeEventRecord,
): TaskSnapshot | null {
  const taskId = normalizeOptionalString(event.task_id ?? undefined);
  if (!taskId) {
    return null;
  }
  const role = normalizeOptionalString(event.role ?? undefined) ?? task?.role ?? "dev";
  let status: TaskSnapshot["status"] = task?.status ?? "running";
  switch (event.event_type) {
    case "runtime.queued":
    case "runtime.requeued":
      status = "queued";
      break;
    case "runtime.spawned":
    case "runtime.started":
    case "runtime.retry_started":
      status = "running";
      break;
    case "runtime.completed":
    case "runtime.retry_completed":
      status = "completed";
      break;
    case "runtime.failed":
    case "runtime.exit":
      status =
        event.status === "completed"
          ? "completed"
          : event.status === "queued"
            ? "queued"
            : "failed";
      break;
    default:
      status = task?.status ?? "running";
      break;
  }
  const category = task?.category ?? (taskId.startsWith("docreq-") ? "document_request" : "other");
  const service = task?.service ?? "other";
  return {
    taskId,
    role,
    status,
    updatedAt: normalizeIso(event.timestamp),
    createdAt: task?.createdAt ?? normalizeIso(event.timestamp),
    routeReason: normalizeOptionalString(event.route_reason ?? undefined) ?? task?.routeReason,
    attempts: task?.attempts ?? 0,
    maxAttempts: task?.maxAttempts ?? 5,
    category,
    service,
    summary: summarizeTask({ category, service, status }),
    hasResult: task?.hasResult ?? status === "completed",
  };
}

async function loadRecentRunStates(): Promise<Map<string, RunStateRecord>> {
  const records = new Map<string, RunStateRecord>();
  let dirEntries: string[] = [];
  try {
    dirEntries = await readdir(RUNS_DIR);
  } catch {
    return records;
  }
  const candidates = dirEntries.filter(
    (name) => name.startsWith("docreq-") || name.startsWith("intake-"),
  );
  await Promise.all(
    candidates.map(async (name) => {
      const state = await readJsonFile<RunStateRecord>(path.join(RUNS_DIR, name, "state.json"));
      const taskId = normalizeOptionalString(state?.task_id) ?? name;
      if (state) {
        records.set(taskId, state);
      }
    }),
  );
  return records;
}

function enrichFromRunState(
  task: TaskSnapshot,
  state: RunStateRecord | null | undefined,
): TaskSnapshot {
  if (!state) {
    return task;
  }
  const category = normalizeOptionalString(state.context?.category) ?? task.category;
  const service = normalizeOptionalString(state.context?.service) ?? task.service;
  let status = task.status;
  if (state.done === true) {
    status = "completed";
  } else if (task.status !== "completed" && task.status !== "failed") {
    if (state.status === "failed") {
      status = "failed";
    } else if (state.status === "queued") {
      status = "queued";
    } else if (state.status === "running") {
      status = "running";
    }
  }
  return {
    ...task,
    category,
    service,
    status,
    summary: summarizeTask({ category, service, status }),
    hasResult: Boolean(task.hasResult || state.done || (state.result && state.result.trim())),
  };
}

function mapTaskStatusToAgentState(statuses: TaskSnapshot["status"][]): string {
  if (statuses.some((status) => status === "failed")) {
    return "error";
  }
  if (statuses.some((status) => status === "running")) {
    return "executing";
  }
  if (statuses.some((status) => status === "queued")) {
    return "syncing";
  }
  return "idle";
}

function buildRuntimeEventsFeed(
  tasks: TaskSnapshot[],
  rawEvents: RuntimeEventRecord[],
): Record<string, unknown>[] {
  const feed: Record<string, unknown>[] = [];
  for (const task of tasks) {
    feed.push({
      event_id: `evt-intake-${task.taskId}`,
      event_type: "channel.message.received",
      timestamp: task.createdAt,
      workspace_id: "deepnoa-office",
      source: "public",
      agent_id: task.role,
      task_id: task.taskId,
      severity: "info",
      display_summary: `Formspree inquiry detected (${task.category} / ${task.service})`,
      state: "syncing",
      provenance: "actual",
      provenance_label: "actual",
      approval_status: "",
      approval_id: "",
      raw_payload: {
        runtimeTaskId: task.taskId,
        category: task.category,
        service: task.service,
      },
    });
  }
  for (const event of rawEvents) {
    const taskId = normalizeOptionalString(event.task_id ?? undefined);
    if (!taskId) {
      continue;
    }
    const role = normalizeOptionalString(event.role ?? undefined) ?? "dev";
    const timestamp = normalizeIso(event.timestamp);
    const common = {
      workspace_id: "deepnoa-office",
      source: "runtime",
      agent_id: role,
      task_id: taskId,
      provenance: "actual",
      provenance_label: "actual",
      approval_status: "",
      approval_id: "",
      raw_payload: event,
    };
    if (event.event_type === "runtime.stuck_warning") {
      feed.push({
        event_id: `evt-${taskId}-stuck-${timestamp}`,
        event_type: "runtime.alert",
        timestamp,
        severity: "warning",
        display_summary: `Runtime stuck warning for ${taskId}`,
        state: "error",
        ...common,
      });
      continue;
    }
    if (
      event.event_type === "runtime.completed" ||
      event.event_type === "runtime.retry_completed"
    ) {
      feed.push({
        event_id: `evt-${taskId}-completed-${timestamp}`,
        event_type: "task.completed",
        timestamp,
        severity: "info",
        display_summary: `Task completed: ${taskId}`,
        state: "idle",
        ...common,
      });
      continue;
    }
    if (event.event_type === "runtime.failed") {
      feed.push({
        event_id: `evt-${taskId}-failed-${timestamp}`,
        event_type: "task.failed",
        timestamp,
        severity: "error",
        display_summary: `Task failed: ${taskId}`,
        state: "error",
        ...common,
      });
      continue;
    }
    if (
      event.event_type === "runtime.started" ||
      event.event_type === "runtime.spawned" ||
      event.event_type === "runtime.retry_started"
    ) {
      feed.push({
        event_id: `evt-${taskId}-started-${timestamp}`,
        event_type: "task.started",
        timestamp,
        severity: "info",
        display_summary: `Task started: ${taskId}`,
        state: "executing",
        ...common,
      });
      continue;
    }
    if (event.event_type === "runtime.queued" || event.event_type === "runtime.requeued") {
      feed.push({
        event_id: `evt-${taskId}-queued-${timestamp}`,
        event_type: "task.blocked",
        timestamp,
        severity: "warning",
        display_summary: `Task requeued: ${taskId}`,
        state: "blocked",
        ...common,
      });
    }
  }
  feed.sort((left, right) =>
    String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")),
  );
  return feed.slice(0, 100);
}

async function buildInternalState(): Promise<InternalStateResponse> {
  const queueEntries = await readJsonlFile<QueueRecord>(QUEUED_RUNTIME_TASKS_PATH);
  const runtimeEvents = await readJsonlFile<RuntimeEventRecord>(RUNTIME_EVENTS_PATH);
  const runStates = await loadRecentRunStates();

  const tasksById = new Map<string, TaskSnapshot>();
  for (const entry of queueEntries) {
    const task = buildTaskFromQueue(entry);
    if (task) {
      tasksById.set(task.taskId, task);
    }
  }
  const sortedRuntimeEvents = [...runtimeEvents].sort((left, right) =>
    normalizeIso(left.timestamp).localeCompare(normalizeIso(right.timestamp)),
  );
  for (const event of sortedRuntimeEvents) {
    const task = applyRuntimeEvent(
      tasksById.get(normalizeOptionalString(event.task_id ?? undefined) ?? ""),
      event,
    );
    if (task) {
      tasksById.set(task.taskId, task);
    }
  }
  for (const [taskId, task] of tasksById.entries()) {
    tasksById.set(taskId, enrichFromRunState(task, runStates.get(taskId)));
  }

  const tasks = [...tasksById.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const nowIso = new Date().toISOString();
  const activeTasks = tasks.filter((task) => task.status === "running" || task.status === "queued");
  const failedTasks = tasks.filter((task) => task.status === "failed");
  const completedTasks = tasks.filter((task) => task.status === "completed");
  const blockedTasks = tasks.filter((task) => task.status === "queued");
  const alertCount =
    failedTasks.length +
    runtimeEvents.filter((event) => event.event_type === "runtime.stuck_warning").length;

  const roles = ROLE_ORDER.map((roleKey) => {
    const definition = ROLE_DEFINITIONS[roleKey];
    const roleTasks = tasks.filter((task) => task.role === roleKey);
    const state = mapTaskStatusToAgentState(roleTasks.map((task) => task.status));
    const latestTask = roleTasks[0];
    return {
      key: definition.key,
      name: definition.name,
      role: definition.role,
      profile: definition.profile,
      state,
      public_status_label:
        state === "executing"
          ? "Working"
          : state === "syncing"
            ? "Routing"
            : state === "error"
              ? "Attention"
              : definition.idle_label,
      detail: latestTask?.summary ?? "Ready for work.",
      updated_at: latestTask?.updatedAt ?? nowIso,
      allowed_tools: [...definition.allowed_tools],
      last_event_type:
        sortedRuntimeEvents.find(
          (event) => normalizeOptionalString(event.role ?? undefined) === roleKey,
        )?.event_type ?? null,
      last_source: roleTasks.length > 0 ? "runtime" : null,
    };
  });

  const agents = roles.map((role) => ({
    key: role.key,
    agentId: role.key,
    name: role.name,
    isMain: role.key === "dev",
    state: role.state,
    detail: role.detail,
    display_summary: role.detail,
    status_label: role.public_status_label,
    area: role.state === "idle" ? "breakroom" : "writing",
    source: "runtime-events",
    authStatus: "approved",
    updated_at: role.updated_at,
    lastPushAt: role.updated_at,
  }));

  const intake = tasks.slice(0, 6).map((task) => ({
    id: task.taskId,
    role: task.role,
    summary: `Formspree inquiry detected (${task.category} / ${task.service})`,
    updated_at: task.updatedAt,
    runtimeTaskId: task.taskId,
  }));

  const events = buildRuntimeEventsFeed(tasks, sortedRuntimeEvents);
  const activity = events
    .filter((event) => typeof event.event_type === "string")
    .slice(0, 8)
    .map((event) => ({
      role: event.agent_id,
      agent: roles.find((role) => role.key === event.agent_id)?.name ?? event.agent_id ?? "Agent",
      event_type: event.event_type,
      source: event.source,
      state: event.state,
      summary: event.display_summary,
      updated_at: event.timestamp,
      route_reason:
        typeof event.raw_payload === "object" && event.raw_payload
          ? ((event.raw_payload as { route_reason?: string }).route_reason ?? null)
          : null,
      provenance: event.provenance,
      provenance_label: event.provenance_label,
    }));

  const degradedConnectors = [
    {
      name: "OpenClaw runtime",
      status: failedTasks.length > 0 ? "degraded" : "connected",
      last_sync: tasks[0]?.updatedAt ?? nowIso,
      pending_actions: blockedTasks.length,
      auth_status_summary: "runtime-events.jsonl",
    },
    {
      name: "Runtime queue",
      status: blockedTasks.length > 0 ? "degraded" : "connected",
      last_sync: blockedTasks[0]?.updatedAt ?? tasks[0]?.updatedAt ?? nowIso,
      pending_actions: blockedTasks.length,
      auth_status_summary: "queued-runtime-tasks.jsonl",
    },
    {
      name: "Sense worker",
      status: "connected",
      last_sync: tasks[0]?.updatedAt ?? nowIso,
      pending_actions: 0,
      auth_status_summary: "SENSE_WORKER_URL runtime path",
    },
  ];

  const doneToday = completedTasks.filter((task) => isToday(task.updatedAt)).length;
  const summary = {
    active_agents: roles.filter((role) => role.state !== "idle").length,
    active_tasks: activeTasks.length,
    blocked: blockedTasks.length,
    awaiting_approval: 0,
    done_today: doneToday,
    alerts: alertCount,
    status: alertCount > 0 ? "attention" : blockedTasks.length > 0 ? "watch" : "normal",
  };

  const latestTask = tasks[0];
  const managerUpdatedAt = latestTask?.updatedAt ?? nowIso;
  const gatewayStatus =
    failedTasks.length > 0 ? "Attention" : activeTasks.length > 0 ? "Routing" : "Standby";
  const gatewayDetail =
    latestTask?.summary ??
    (activeTasks.length > 0
      ? "Reception AI is routing runtime work."
      : "Reception AI ready to route work.");

  return {
    schema_version: "2026-03-17",
    surface: "internal",
    transport: "polling-ready / compatibility",
    office: { ...OFFICE_INFO },
    manager: {
      updated_at: managerUpdatedAt,
      gateway: {
        status: gatewayStatus,
        detail: gatewayDetail,
        updated_at: managerUpdatedAt,
      },
      routing: { ...ROUTING_MAP },
      fallback_worker: {
        key: "main",
        name: "Universal Worker",
        role: "Fallback",
        profile: "Fallback worker that keeps the existing universal OpenClaw flow available.",
        allowed_tools: ["existing-openclaw-flow"],
        status: "available",
        updated_at: managerUpdatedAt,
      },
    },
    summary,
    roles,
    agents,
    activity,
    blocked: blockedTasks.map((task) => ({
      task_id: task.taskId,
      agent_id: task.role,
      state: "blocked",
      summary: task.summary,
      severity: "warning",
      timestamp: task.updatedAt,
      event_type: "task.blocked",
      provenance: "actual",
      provenance_label: "actual",
      approval_status: "",
      approval_provenance: "",
      approval_signal_kind: "",
      approval_id: "",
    })),
    approvals: [],
    failed: failedTasks.map((task) => ({
      task_id: task.taskId,
      agent_id: task.role,
      state: "failed",
      summary: task.summary,
      severity: "error",
      timestamp: task.updatedAt,
      event_type: "task.failed",
      provenance: "actual",
      provenance_label: "actual",
      approval_status: "",
      approval_provenance: "",
      approval_signal_kind: "",
      approval_id: "",
    })),
    connectors: degradedConnectors,
    completed: completedTasks.slice(0, 8).map((task) => ({
      task_id: task.taskId,
      agent_id: task.role,
      state: "completed",
      summary: task.summary,
      severity: "info",
      timestamp: task.updatedAt,
      event_type: "task.completed",
      provenance: "actual",
      provenance_label: "actual",
      approval_status: "",
      approval_provenance: "",
      approval_signal_kind: "",
      approval_id: "",
    })),
    alerts: runtimeEvents
      .filter((event) => event.event_type === "runtime.stuck_warning")
      .slice(0, 8)
      .map((event) => ({
        alert_id: `alert-${event.task_id}-${event.timestamp}`,
        agent_id: event.role ?? "dev",
        state: "error",
        severity: "warning",
        summary: `Runtime stuck warning: ${event.task_id ?? "unknown task"}`,
        timestamp: normalizeIso(event.timestamp),
        event_type: "runtime.alert",
        provenance: "actual",
        provenance_label: "actual",
      })),
    events,
    intake,
    assets: {
      auth_required: true,
      auth_status: {
        authed: false,
        drawer_default_pass: false,
      },
      gemini: {
        script_ready: false,
        python_ready: false,
        model: "n/a",
        api_key_configured: false,
      },
      background: {
        active_file_present: false,
        reference_present: false,
        history_count: 0,
        favorites_count: 0,
      },
      layout: {
        positions_count: 0,
        defaults_count: 0,
        template_zip_present: false,
      },
      legacy_surfaces: {
        desktop_pet_present: false,
        electron_shell_present: false,
      },
    },
    policies: {
      public_state_source: "runtime-events compatibility aggregation",
      public_view_policy: "read-only public-safe",
      internal_view_policy: "internal-only operational snapshot",
      event_policy: "runtime.* mapped into task/runtime alert lifecycle",
      approval_lifecycle_rules: "approval flow not emitted by this adapter",
      connector_health_rules: "runtime queue and event freshness derived locally",
      source_catalog: "runs/runtime-events.jsonl + queued-runtime-tasks.jsonl + runs/*/state.json",
    },
  };
}

export async function handleInternalStateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return false;
  }
  if (url.pathname !== INTERNAL_STATE_PATH && url.pathname !== INTERNAL_STATE_COMPAT_PATH) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }

  const isLocal = isLocalDirectRequest(
    req,
    opts.trustedProxies ?? [],
    opts.allowRealIpFallback === true,
  );
  if (!isLocal) {
    const authResult = await authorizeScopedGatewayHttpRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      operatorMethod: "agent",
      resolveOperatorScopes: resolveTrustedHttpOperatorScopes,
    });
    if (!authResult) {
      return true;
    }
  }

  const payload = await buildInternalState();
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end();
    return true;
  }
  sendJson(res, 200, payload);
  return true;
}
