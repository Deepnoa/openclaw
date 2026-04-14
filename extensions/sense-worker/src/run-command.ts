import type { PluginCommandContext } from "../../../src/plugins/types.js";
import { formatRunId, writeRunRecord } from "./run-store.js";
import type { RunKind, RunRecord } from "./run-types.js";

const MAX_RUN_TEXT_LENGTH = 500;

const RUN_HELP_TEXT = [
  "OpenClaw run commands",
  "Current MVP stores queued runs only.",
  "- /openclaw run help",
  "- /openclaw run health",
  "- /openclaw run digest",
  "- /openclaw run <free-text>",
].join("\n");

type RunCommandParseResult =
  | {
      kind: "help";
      text: string;
    }
  | {
      kind: "error";
      text: string;
    }
  | {
      kind: "queue";
      rawText: string;
      runKind: RunKind;
      normalizedTask: string;
      params: Record<string, unknown>;
    };

function deriveChannelId(ctx: PluginCommandContext): string | null {
  const candidate =
    (typeof ctx.to === "string" && ctx.to.trim()) ||
    (typeof ctx.from === "string" && ctx.from.trim()) ||
    "";
  return candidate || null;
}

function classifyRunCommand(args: string | undefined): RunCommandParseResult {
  const trimmed = args?.trim() ?? "";
  if (!trimmed || trimmed.toLowerCase() === "help") {
    return { kind: "help", text: RUN_HELP_TEXT };
  }
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return { kind: "error", text: "入力が無効です: 改行は使えません" };
  }
  if (trimmed.length > MAX_RUN_TEXT_LENGTH) {
    return { kind: "error", text: `入力が無効です: 最大 ${MAX_RUN_TEXT_LENGTH} 文字です` };
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "health") {
    return {
      kind: "queue",
      rawText: trimmed,
      runKind: "health",
      normalizedTask: "health",
      params: {},
    };
  }
  if (normalized === "digest") {
    return {
      kind: "queue",
      rawText: trimmed,
      runKind: "digest",
      normalizedTask: "digest",
      params: {},
    };
  }
  if (normalized.startsWith("job ") || normalized === "job") {
    return { kind: "error", text: "まだ未実装です: /openclaw run job <run_id>" };
  }
  if (normalized.startsWith("list") || normalized.startsWith("retry ")) {
    return { kind: "error", text: "まだ未実装です: list/retry は次のPRで追加します" };
  }

  return {
    kind: "queue",
    rawText: trimmed,
    runKind: "free",
    normalizedTask: trimmed,
    params: {},
  };
}

export function buildQueuedRunRecord(params: {
  args: string | undefined;
  ctx: Pick<PluginCommandContext, "senderId" | "from" | "to">;
  now?: Date;
  runId?: string;
}): RunCommandParseResult | { kind: "queue"; record: RunRecord } {
  const parsed = classifyRunCommand(params.args);
  if (parsed.kind !== "queue") {
    return parsed;
  }

  const now = params.now ?? new Date();
  const queuedAt = now.toISOString();
  const runId = params.runId ?? formatRunId(now);
  const requestedBy =
    (typeof params.ctx.senderId === "string" && params.ctx.senderId.trim()) || "unknown";
  const requestedByName =
    typeof params.ctx.from === "string" && params.ctx.from.trim() ? params.ctx.from.trim() : null;

  return {
    kind: "queue",
    record: {
      run_id: runId,
      requested_by: requestedBy,
      requested_by_name: requestedByName,
      channel_id: deriveChannelId(params.ctx),
      channel_name: null,
      raw_text: parsed.rawText,
      kind: parsed.runKind,
      normalized_task: parsed.normalizedTask,
      params: parsed.params,
      status: "queued",
      sense_job_id: null,
      queued_at: queuedAt,
      started_at: null,
      done_at: null,
      result: null,
      error: null,
      retry_of: null,
      retry_count: 0,
      slack_ts: null,
    },
  };
}

export async function handleRunCommand(
  ctx: PluginCommandContext,
  deps: {
    now?: () => Date;
    writeRecord?: typeof writeRunRecord;
  } = {},
): Promise<{ text: string }> {
  const built = buildQueuedRunRecord({
    args: ctx.args,
    ctx,
    now: deps.now?.(),
  });

  if (built.kind === "help" || built.kind === "error") {
    return { text: built.text };
  }

  const writeRecord = deps.writeRecord ?? writeRunRecord;
  await writeRecord(built.record);

  return {
    text: [
      "受付しました",
      `run_id: \`${built.record.run_id}\``,
      `タスク: \`${built.record.kind}\``,
      `状態: \`${built.record.status}\``,
    ].join("\n"),
  };
}

export const __testing = {
  classifyRunCommand,
  RUN_HELP_TEXT,
  deriveChannelId,
};
