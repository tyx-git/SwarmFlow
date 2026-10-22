/**
 * 任务清单的存储生命周期：tasks.json 为权威、按工件目录 key 惰性重定位。
 *
 * 只搬存哪里/是否持久化/何时通知这层；5 个 task_* 工具执行器仍留在 Session
 * （它们与日志、子会话恢复耦合）。
 */

import { basename } from "node:path";

import type { Agent } from "../agents/agent.js";
import type { SessionStore } from "../config/session-store.js";
import type { LogEntry } from "../context/entry/types.js";
import { ToolResult } from "../providers/response.js";
import type { ChildTaskHandoff } from "./tree-types.js";
import { decideChildResume, describeResumeReason, type ChildOutcome, type ResumeReason, type TerminationCause } from "../tasks/reconcile.js";
import type { SessionCapabilities } from "./capabilities.js";
import type { ChildSessionManager } from "./children/manager.js";
import { TaskStore, taskStorePath } from "../tasks/store.js";
import type { Task, TaskResumeHint, TaskUpdateFields } from "../tasks/types.js";
import { ensureTaskTools } from "../tools/runtime.js";
import { argOptionalString, argRequiredString } from "../tools/arg-validation.js";
import { readResumeHint } from "../tasks/resume.js";
import { buildContinuationPrompt } from "./prompts.js";
import { isAgentRoleId } from "../swarm/types.js";

/** 任务清单存储所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface TaskListHost {
  primaryAgent: Agent;
  _capabilities: SessionCapabilities;
  _store: SessionStore | undefined;
  _sessionArtifactsOverride: string;
  _taskStoreScope: "session" | "memory";
  _taskStoreRef: TaskStore | undefined;
  _taskStoreKey: string | undefined;
  _taskListeners: (() => void)[];
  _getArtifactsDirIfAvailable(): string | undefined;
  readonly _log: LogEntry[];
  readonly _childSessionManagerInstance: ChildSessionManager;
}

/** 当前会话的任务清单（按 id 升序）。 */
export function getTaskState(host: TaskListHost): readonly Task[] {
  return ensureTaskStore(host).list();
}

export function subscribeTaskState(host: TaskListHost, listener: () => void): () => void {
  host._taskListeners.push(listener);
  return () => {
    const idx = host._taskListeners.indexOf(listener);
    if (idx !== -1) host._taskListeners.splice(idx, 1);
  };
}

export function notifyTaskListeners(host: TaskListHost): void {
  for (const listener of host._taskListeners) listener();
}

/**
 * 任务清单存储，惰性创建。
 * 
 * - 主会话：`{SESSION_ARTIFACTS}/tasks.json`（每会话一份，与 childSessionDir 的
 *   所有权模型一致）
 * - 子会话：纯内存（子代理不写持久化文件，清单随子会话对象消亡）
 * - 工件目录在会话存储绑定后才可用，且 `/new`、会话恢复、`/fork` 会切换目录，
 *   因此按路径 key 重定位；key 变化时才重建（重建即从磁盘载入）。
 */
export function ensureTaskStore(host: TaskListHost): TaskStore {
  if (host._taskStoreScope === "memory") {
    if (!host._taskStoreRef) host._taskStoreRef = TaskStore.memory();
    return host._taskStoreRef;
  }
  const dir = host._sessionArtifactsOverride || host._getArtifactsDirIfAvailable();
  if (!dir) {
    // 会话存储尚未绑定：先退回内存态；绑定后按 key 重定位到文件。
    if (!host._taskStoreRef) host._taskStoreRef = TaskStore.memory();
    return host._taskStoreRef;
  }
  const path = taskStorePath(dir);
  if (!host._taskStoreRef || host._taskStoreKey !== path) {
    const sessionDir = typeof host._store?.sessionDir === "string" ? host._store.sessionDir : "";
    host._taskStoreRef = new TaskStore({
      filePath: path,
      sessionId: sessionDir ? basename(sessionDir) : "session",
    });
    host._taskStoreKey = path;
  }
  return host._taskStoreRef;
}

export function ensureTaskToolsForSession(host: TaskListHost): void {
  ensureTaskTools(host.primaryAgent.tools, host._capabilities);
}

/**
 * 任务清单的持久化状态 —— 供 UI 决定是否标注"不持久化"。
 * 
 * - `"file"`：任务落 `{SESSION_ARTIFACTS}/tasks.json`（正常会话）
 * - `"pending"`：会话目录尚未惰性创建 —— **正常会话的过渡态**，UI 不应提示任何东西
 * - `"memory"`：本次会话没有任务持久化（子会话，或根本没有会话存储）
 * 
 * 注意边界：只有 `"memory"` 才代表"确实不落盘"，`"pending"` 会在首个回合前
 * 由 `_ensureSessionStorageReady()` 创建目录后自然变成 `"file"`。
 */
export function getTaskPersistence(host: TaskListHost): "file" | "pending" | "memory" {
  if (host._taskStoreScope === "memory") return "memory";
  if (host._sessionArtifactsOverride) return "file";
  if (!host._store) return "memory";
  if (!host._store.sessionDir) return "pending";
  return "file";
}

/** 从父日志的 agent_result 条目索引每个子代理的最终结局与终止原因。 */
export function indexChildOutcomesFromLog(
  host: TaskListHost,
): Map<string, { outcome: ChildOutcome; cause?: TerminationCause }> {
  const indexed = new Map<string, { outcome: ChildOutcome; cause?: TerminationCause }>();
  for (const entry of host._log) {
    if (entry.type !== "agent_result" || entry.discarded) continue;
    const meta = entry.meta as Record<string, unknown>;
    const agentId = typeof meta["agentId"] === "string" ? meta["agentId"] : undefined;
    if (!agentId) continue;
    const rawOutcome = meta["outcome"];
    const outcome: ChildOutcome =
      rawOutcome === "completed" ? "completed" : rawOutcome === "failed" ? "error" : rawOutcome === "interrupted" ? "interrupted" : "none";
    const rawCause = meta["cause"];
    const cause: TerminationCause | undefined =
      rawCause === "natural" || rawCause === "parent_kill" || rawCause === "user_targeted_kill" || rawCause === "user_mass_interrupt"
        ? rawCause
        : undefined;
    indexed.set(agentId, { outcome, cause });
  }
  return indexed;
}

export function resumeRefusalText(reason: string): string {
  switch (reason) {
    case "attempts_exhausted":
      return "resume attempts exhausted — re-dispatch with spawn (new agent id) or ask the user";
    case "superseded":
      return "a newer run has taken over this task";
    case "already_completed":
      return "the task is already completed";
    case "no_resume_hint":
      return "no interrupted run recorded";
    case "not_found":
      return "task not found";
    default:
      return describeResumeReason(reason as ResumeReason);
  }
}

export function resumeChildSession(
  host: TaskListHost,
  childId: string,
  prompt: string,
): { ok: boolean; reason?: string } {
  return host._childSessionManagerInstance.resumeChildTurn(childId, prompt);
}

/** `metadata` 参数解析：必须是普通对象；`null` 值保留（语义为删除该键）。 */
export function argTaskMetadata(raw: unknown): Record<string, unknown> | undefined | ToolResult {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return new ToolResult({ content: "Error: 'metadata' must be an object." });
  }
  return { ...(raw as Record<string, unknown>) };
}

// ==================================================================
// task_* 工具执行器
// ==================================================================

export function execTaskCreate(host: TaskListHost, args: Record<string, unknown>): ToolResult {
  const subject = argRequiredString("task_create", args, "subject", { nonEmpty: true });
  if (subject instanceof ToolResult) return subject;
  const description = argRequiredString("task_create", args, "description", { nonEmpty: true });
  if (description instanceof ToolResult) return description;
  const activeForm = argOptionalString("task_create", args, "active_form");
  if (activeForm instanceof ToolResult) return activeForm;
  const role = argOptionalString("task_create", args, "role");
  if (role instanceof ToolResult) return role;
  if (role && !isAgentRoleId(role.trim())) {
    return new ToolResult({ content: "Error: 'role' must be queen, scout, worker, reviewer, guard, or merger." });
  }
  const metadata = argTaskMetadata(args["metadata"]);
  if (metadata instanceof ToolResult) return metadata;

  const { task, saveError } = ensureTaskStore(host).create(
    subject.trim(),
    description.trim(),
    activeForm,
    metadata,
    role?.trim(),
  );
  notifyTaskListeners(host);
  return new ToolResult({
    content: `Task #${task.id} created: ${task.subject}${saveError ? `\nwarning: ${saveError}` : ""}`,
  });
}

export function execTaskList(host: TaskListHost): ToolResult {
  const store = ensureTaskStore(host);
  const tasks = store.list();
  if (tasks.length === 0) {
    return new ToolResult({ content: store.lastSaveError ? `No tasks loaded. ${store.lastSaveError}` : "No tasks found" });
  }

  // 面向模型的可读顺序：未完成在前，同状态按 id。
  const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
  const sorted = [...tasks].sort(
    (a, b) => (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0) || Number(a.id) - Number(b.id),
  );

  const lines = sorted.map((task) => {
    let line = `#${task.id} [${task.status}] ${task.subject}`;
    if (task.role) line += ` [${task.role}]`;
    const owner = task.owner ?? (typeof task.metadata["agentId"] === "string" ? (task.metadata["agentId"] as string) : undefined);
    if (owner) line += ` (${owner})`;

    if (task.status !== "completed") {
      const openBlockers = task.blockedBy.filter((id) => {
        const blocker = store.get(id);
        return blocker !== undefined && blocker.status !== "completed";
      });
      if (openBlockers.length > 0) {
        line += ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`;
      }
    }

    if (task.status === "pending") {
      const hint = readResumeHint(task);
      if (hint) {
        line += hint.resumable
          ? ` [interrupted — resumable via task_resume (${hint.toolCalls} tool calls, ${hint.tokensIn} input tokens)]`
          : ` [interrupted — re-dispatch with a new agent id: ${describeResumeReason(hint.reason as ResumeReason)}]`;
      }
    }
    const childOpenTasks = task.metadata["childOpenTasks"];
    if (Array.isArray(childOpenTasks) && childOpenTasks.length > 0) {
      line += ` [${childOpenTasks.length} unfinished child-local tasks returned; inspect task_get; Queen decides re-dispatch]`;
    }
    return line;
  });

  if (store.lastSaveError) lines.push(`warning: ${store.lastSaveError}`);
  return new ToolResult({ content: lines.join("\n") });
}

export function execTaskGet(host: TaskListHost, args: Record<string, unknown>): ToolResult {
  const taskId = argRequiredString("task_get", args, "task_id", { nonEmpty: true });
  if (taskId instanceof ToolResult) return taskId;

  const store = ensureTaskStore(host);
  const task = store.get(taskId.trim());
  if (!task) return new ToolResult({ content: `Task #${taskId} not found` });

  const lines: string[] = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
  if (task.role) lines.push(`Role: ${task.role}`);
  const owner = task.owner ?? (typeof task.metadata["agentId"] === "string" ? (task.metadata["agentId"] as string) : undefined);
  if (owner) lines.push(`Owner: ${owner}`);
  if (task.activeForm) lines.push(`Active form: ${task.activeForm}`);
  lines.push(`Description: ${task.description.replace(/\\n/g, "\n")}`);

  const openBlockers = task.blockedBy.filter((id) => {
    const blocker = store.get(id);
    return blocker !== undefined && blocker.status !== "completed";
  });
  if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map((id) => `#${id}`).join(", ")}`);
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);

  const hint = readResumeHint(task);
  if (hint) {
    lines.push(
      `Interrupted run: child ${hint.childId}, ${hint.toolCalls} tool calls, ${hint.tokensIn} input tokens — ` +
        (hint.resumable ? "resumable via task_resume" : `do not resume (${describeResumeReason(hint.reason as ResumeReason)})`),
    );
  }

  const childOpenTasks = task.metadata["childOpenTasks"];
  if (Array.isArray(childOpenTasks) && childOpenTasks.length > 0) {
    lines.push(`Unfinished child-local tasks returned (${childOpenTasks.length}); Queen must decide whether to re-dispatch:`);
    for (const value of childOpenTasks) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const localId = typeof item["id"] === "string" ? item["id"] : "?";
      const subject = typeof item["subject"] === "string" ? item["subject"] : "(no subject)";
      const status = typeof item["status"] === "string" ? item["status"] : "unknown";
      const description = typeof item["description"] === "string" ? item["description"] : "";
      lines.push(`- [${status}] child-local #${localId}: ${subject}${description ? ` — ${description}` : ""}`);
    }
  }

  const displayMetadata = { ...task.metadata };
  delete displayMetadata["childOpenTasks"];
  const metaKeys = Object.keys(displayMetadata);
  if (metaKeys.length > 0) lines.push(`Metadata: ${JSON.stringify(displayMetadata)}`);
  if (store.lastSaveError) lines.push(`warning: ${store.lastSaveError}`);
  return new ToolResult({ content: lines.join("\n") });
}

export function execTaskUpdate(host: TaskListHost, args: Record<string, unknown>): ToolResult {
  const taskId = argRequiredString("task_update", args, "task_id", { nonEmpty: true });
  if (taskId instanceof ToolResult) return taskId;
  const id = taskId.trim();

  const fields: TaskUpdateFields = {};

  const status = args["status"];
  if (status !== undefined) {
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "deleted") {
      return new ToolResult({
        content: "Error: 'status' must be one of pending, in_progress, completed, deleted.",
      });
    }
    fields.status = status;
  }

  const textFields: Array<[string, "subject" | "description" | "activeForm" | "owner" | "role"]> = [
    ["subject", "subject"],
    ["description", "description"],
    ["active_form", "activeForm"],
    ["owner", "owner"],
    ["role", "role"],
  ];
  for (const [key, field] of textFields) {
    const value = argOptionalString("task_update", args, key);
    if (value instanceof ToolResult) return value;
    if (value !== undefined) fields[field] = value;
  }
  if (fields.role && !isAgentRoleId(fields.role.trim())) {
    return new ToolResult({ content: "Error: 'role' must be queen, scout, worker, reviewer, guard, or merger." });
  }
  if (fields.role) fields.role = fields.role.trim();

  const metadata = argTaskMetadata(args["metadata"]);
  if (metadata instanceof ToolResult) return metadata;
  if (metadata) fields.metadata = metadata;

  const edges: Array<[string, "addBlocks" | "addBlockedBy"]> = [
    ["add_blocks", "addBlocks"],
    ["add_blocked_by", "addBlockedBy"],
  ];
  for (const [key, field] of edges) {
    const raw = args[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.length === 0)) {
      return new ToolResult({ content: `Error: '${key}' must be an array of task ids.` });
    }
    fields[field] = [...(raw as string[])];
  }

  const result = ensureTaskStore(host).update(id, fields);
  if (!result.task && !result.changedFields.includes("deleted")) {
    return new ToolResult({ content: `Task #${id} not found` });
  }
  notifyTaskListeners(host);

  let message = `Updated task #${id} ${result.changedFields.join(", ")}`;
  if (result.warnings.length > 0) message += ` (warning: ${result.warnings.join("; ")})`;
  if (result.saveError) message += `\nwarning: ${result.saveError}`;
  return new ToolResult({ content: message });
}

export function execTaskResume(host: TaskListHost, args: Record<string, unknown>): ToolResult {
  const taskId = argRequiredString("task_resume", args, "task_id", { nonEmpty: true });
  if (taskId instanceof ToolResult) return taskId;
  const id = taskId.trim();

  const store = ensureTaskStore(host);
  const task = store.get(id);
  if (!task) return new ToolResult({ content: `Task #${id} not found` });

  const hint = readResumeHint(task);
  if (!hint) {
    return new ToolResult({
      content: `Task #${id} has no interrupted run to resume. Use task_update to change its status, or spawn a new agent for it.`,
    });
  }

  const begun = store.beginResume(id);
  if (!begun.ok || !begun.task) {
    return new ToolResult({
      content: `Cannot resume task #${id}: ${resumeRefusalText(begun.reason ?? "not_resumable")}`,
    });
  }

  const note = argOptionalString("task_resume", args, "note");
  if (note instanceof ToolResult) return note;

  const prompt = buildContinuationPrompt(begun.task, hint, note);
  const resumed = resumeChildSession(host, hint.childId, prompt);
  if (!resumed.ok) {
    // 回滚状态；尝试次数保留（防止调用方反复重试同一个不可用子代理）。
    store.update(id, { status: "pending" });
    notifyTaskListeners(host);
    return new ToolResult({
      content: `Failed to resume task #${id}: ${resumed.reason ?? "unknown"} (child ${hint.childId}). Re-dispatch it with spawn instead.`,
    });
  }

  notifyTaskListeners(host);
  return new ToolResult({
    content:
      `Task #${id} resumed on child ${hint.childId} (attempt ${Number(begun.task.metadata["resumeAttempts"] ?? 1)}). ` +
      `It continues from its previous context; use check_status or await_event to follow up.`,
  });
}

// ==================================================================
// 子会话 settle 回写与启动对账
// ==================================================================

/**
 * 子会话 settle：把"子拆分结果"回写进对应任务的 metadata。
 *
 * 由父会话写（子不写盘），让子的拆分结果在父侧可审计、重派时有上下文。
 * 任务是按 `metadata.agentId` 关联的；子代理可能只是被 spawn 派生而未登记为任务，
 * 此时静默跳过。
 */
export function onChildSettled(host: TaskListHost, info: {
  childId: string;
  outcome: ChildOutcome;
  cause: TerminationCause;
  taskSummary?: { total: number; open: number; done: number };
  openTasks: ChildTaskHandoff[];
}): void {
  const store = ensureTaskStore(host);
  const task = store.list().find((candidate) => candidate.metadata["agentId"] === info.childId);
  if (!task) return;

  const metadata: Record<string, unknown> = {
    lastOutcome: info.outcome,
    lastSettledAt: Date.now(),
  };
  if (info.taskSummary) metadata["taskSummary"] = info.taskSummary;
  metadata["childOpenTasks"] = info.openTasks.length > 0 ? info.openTasks : null;
  if (info.outcome === "completed") {
    // 已完成：清掉续跑建议，避免下次重启又提示续跑一个已经跑完的任务。
    metadata["resumeHint"] = null;
  }

  const result = store.update(task.id, { metadata });
  if (result.saveError) console.warn(result.saveError);
  notifyTaskListeners(host);
}

/**
 * 重启对账：子代理一律视为已终止，只判定"是否值得断点续跑"。
 *
 * 顺序要求：必须在子日志加载完成（`commitPreparedChildren`）之后调用 ——
 * 阈值指标（toolCalls / tokensIn）由恢复出的子会话从日志重算。
 *
 * 天然幂等：对账后不再有 `in_progress` 任务，重复调用是空操作。
 */
export function reconcileTaskListAfterRestore(host: TaskListHost, opts: { fork?: boolean } = {}): { warnings: string[]; notice?: string } {
  const warnings: string[] = [];
  const store = ensureTaskStore(host);
  const manager = host._childSessionManagerInstance;

  // 分叉里从来没有活着的执行体：消毒任务清单（清 agentId/result/续跑痕迹，in_progress → pending），
  // 并把所有恢复出的子会话落成不可续（否则它们会带着持久化的 running/blocked/idle 变成幻影）。
  if (opts.fork) {
    const sanitized = store.sanitizeForFork();
    if (sanitized.saveError) warnings.push(sanitized.saveError);
    if (sanitized.changed.length > 0) {
      notifyTaskListeners(host);
      warnings.push(
        `分叉对账：${sanitized.changed.length} 个继承任务已解除执行体关联并回到 pending（分叉中没有活着的执行体）`,
      );
    }
    for (const signal of manager.getResumeSignals()) {
      manager.finalizeRestoredChild(signal.childId, false);
    }
    const forkNotice =
      sanitized.changed.length > 0
        ? [
            "<task-reconciliation>",
            "This session was forked. The inherited task list was sanitized: executors, recorded results and resume hints from the parent run were removed, and in-progress tasks were returned to `pending`.",
            "Nothing can be resumed in a fork — re-dispatch any work you still need with `spawn` using a new agent id. Do not mention this message to the user unless they ask.",
            "</task-reconciliation>",
          ].join("\n")
        : undefined;
    return { warnings, notice: forkNotice };
  }

  const signals = new Map(manager.getResumeSignals().map((signal) => [signal.childId, signal] as const));
  const finalized = new Set<string>();
  const tasks = store.list();
  const failures = manager.getRestoreFailures();
  const loggedOutcomes = indexChildOutcomesFromLog(host);

  const hints: Record<string, TaskResumeHint> = {};
  const lines: string[] = [];

  for (const task of tasks) {
    if (task.status !== "in_progress") continue;
    const agentId = typeof task.metadata["agentId"] === "string" ? (task.metadata["agentId"] as string) : undefined;
    if (!agentId) continue;

    const signal = signals.get(agentId);
    const failure = failures.get(agentId);
    const fromLog = loggedOutcomes.get(agentId);
    const decision = failure === "model_unavailable"
      ? { resumable: false, reason: "model_unavailable" as const }
      : opts.fork
      ? // 分叉：执行体一律作废，不提供续跑
        { resumable: false, reason: "superseded" as const }
      : decideChildResume({
        childId: agentId,
        // 恢复失败的子根本不在 signals 里：日志/模板不可用 → 只能重派
        logAvailable: signal !== undefined,
        templateAvailable: signal !== undefined || failure !== "template_missing",
        sessionAvailable: signal?.sessionAvailable ?? false,
        outcome: fromLog?.outcome ?? signal?.outcome ?? "none",
        cause: fromLog?.cause ?? signal?.cause,
        taskAgentId: agentId,
        mode: signal?.mode,
        toolCalls: signal?.toolCalls ?? 0,
        tokensIn: signal?.tokensIn ?? 0,
      });

    hints[agentId] = {
      childId: agentId,
      toolCalls: signal?.toolCalls ?? 0,
      tokensIn: signal?.tokensIn ?? 0,
      resumable: decision.resumable,
      reason: decision.reason,
    };
    if (signal) {
      manager.finalizeRestoredChild(agentId, decision.resumable);
      finalized.add(agentId);
    }

    lines.push(
      `#${task.id} ${task.subject} — ${
        decision.resumable ? "resumable: call task_resume to continue this run" : describeResumeReason(decision.reason)
      }`,
    );
  }

  // 未被任何任务引用的子也必须归一：重启后没有任何执行体是活的，
  // 否则它们会带着持久化的 running/blocked/idle 留在面板上（幻影状态）。
  for (const childId of signals.keys()) {
    if (!finalized.has(childId)) manager.finalizeRestoredChild(childId, false);
  }

  const { changed, saveError } = store.markInterrupted(hints);
  if (saveError) warnings.push(saveError);
  if (changed.length === 0) return { warnings };
  notifyTaskListeners(host);

  warnings.push(`重启对账：${changed.length} 个进行中的任务已降级为 pending（子代理已全部终止）`);
  for (const line of lines) warnings.push(`  ${line}`);

  const notice = [
    "<task-reconciliation>",
    "This session was restarted, so every sub-agent from the previous run is terminated. The tasks below were in progress and have been returned to `pending`:",
    ...lines.map((line) => `- ${line}`),
    "For each task, either call `task_resume` to continue the interrupted run from its own context, or re-dispatch it with `spawn` using a NEW agent id (re-dispatching clears the stale resume hint). Do not mention this message to the user unless they ask about the restart.",
    "</task-reconciliation>",
  ].join("\n");

  return { warnings, notice };
}
