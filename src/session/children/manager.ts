/** 子会话管理器：创建/派发/收件箱/结算/恢复表。 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Agent } from "../../agents/agent.js";
import type { PendingAskUi } from "../../ask.js";
import { childRestartState } from "../../tasks/reconcile.js";

import { createAgentResult } from "../../context/entry/factories.js";
import type { LogEntry } from "../../context/entry/types.js";
import { describeModel } from "../../models/presentation.js";
import { loadLog, type LoadLogResult } from "../../config/log-serialization.js";
import { validateAndRepairLog } from "../../config/log-repair.js";
import type { LogSessionMeta } from "../../config/session-meta.js";
import type { ProgressLevel } from "../../logging/progress.js";
import { ToolResult } from "../../providers/response.js";
import type { Session } from "../../session.js";
import { getAgentRoleLabel } from "../../swarm/types.js";
import {
  migrateMessageEnvelope,
  type ArchivedChildRecord,
  type ChildSessionMetaRecord,
  type ChildSessionMode,
  type ChildSessionOutcome,
  type ChildSessionSnapshot,
  type ChildSessionStatus,
  type ChildTaskHandoff,
  type MessageEnvelope,
} from "../tree-types.js";
import { SEND_TOOL } from "../../tools/comm.js";
import { RoleModelResolutionError, type PersistedRoleModelSelection } from "../role-model-resolver.js";
import { SUB_AGENT_OUTPUT_LIMIT, childPromptCacheKey, extractLatestAssistantText, formatTokenCount } from "./formatting.js";
import { type ChildSessionHandle, type ChildSessionManagerDeps, type PreparedChildRestore } from "./types.js";

export class ChildSessionManager {
  private _handles = new Map<string, ChildSessionHandle>();
  private _archived = new Map<string, ArchivedChildRecord>();
  /**
   * 恢复失败的子（prepareChildRestores 会跳过它们）。
   * 启动对账用：让父任务知道"这个子的记录/模板不可用，只能重派"。
   */
  private _restoreFailures = new Map<string, "log_unavailable" | "template_missing" | "model_unavailable">();
  private _counter = 0;

  constructor(private readonly deps: ChildSessionManagerDeps) {}

  get handles(): Map<string, ChildSessionHandle> {
    return this._handles;
  }

  get archived(): Map<string, ArchivedChildRecord> {
    return this._archived;
  }

  get counter(): number {
    return this._counter;
  }

  set counter(value: number) {
    this._counter = value;
  }

  /** 清空两张表（新会话重置；counter 单独重置）。 */
  clearTables(): void {
    this._handles = new Map();
    this._archived = new Map();
    // 子 id（worker-1、scout 等）跨会话重用——切换会话时缓存若存活会提供前一会话的日志。
    this._releasedLogCache = null;
  }

  // ==================================================================
  // 快照与状态报告
  // ==================================================================

  /** 获取所有子会话快照（按 lifecycle 优先级和活跃时间排序）。 */
  getSnapshots(): ChildSessionSnapshot[] {
    return [...this._handles.values()]
      .map((handle) => this._buildSnapshot(handle))
      .sort((a, b) => {
        const rank = (snapshot: ChildSessionSnapshot): number => {
          if (snapshot.lifecycle === "running") return 0;
          if (snapshot.lifecycle === "blocked") return 1;
          if (snapshot.lifecycle === "idle") return 2;
          if (snapshot.lifecycle === "archived") return 3;
          return 3;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
        return a.numericId - b.numericId;
      });
  }

  /** 获取子会话日志（live 或从磁盘加载）。 */
  getChildLog(childId: string): readonly LogEntry[] | null {
    const handle = this._handles.get(childId);
    if (!handle) return null;
    if (handle.session) return handle.session.log;
    return this._loadReleasedChildLog(handle);
  }

  /**
   * 已释放子会话日志的单槽缓存：至多一个已释放子会话日志驻留
   *（对应正在查看的 tab），数组标识稳定使 TUI 投影 memo 在轮询间保持有效。
   * 按 sessionDir 而非 child id 索引——sessionDir 在每个根会话中唯一。
   */
  private _releasedLogCache: { sessionDir: string; entries: LogEntry[] } | null = null;

  private _loadReleasedChildLog(handle: ChildSessionHandle): readonly LogEntry[] {
    if (this._releasedLogCache?.sessionDir === handle.sessionDir) {
      return this._releasedLogCache.entries;
    }
    try {
      const loaded = loadLog(handle.sessionDir);
      const repaired = validateAndRepairLog(loaded.entries);
      this._releasedLogCache = { sessionDir: handle.sessionDir, entries: repaired.entries };
      return repaired.entries;
    } catch {
      // 磁盘上子会话日志缺失/损坏——显示空 transcript 而非崩溃 tab。
      return [];
    }
  }

  /**
   * 已结束 one-shot 子会话无法再次运行：send 受模式守卫，
   * 复活仅限 persistent，其结果已在父日志中。
   * 其 Session 仅供 TUI 读取日志和 Agents 面板元数据——
   * 冻结最终快照，丢弃 Session（和内存日志），
   * 按需从磁盘提供日志。日志由 saveChildSession 在此前持久化。
   */
  private _freezeAndRelease(handle: ChildSessionHandle, persistedOk: boolean): void {
    if (!handle.session) return;
    if (handle.mode !== "oneshot" || handle.lifecycle !== "archived") return;
    // 释放后磁盘副本是唯一副本——若持久化失败不丢弃内存日志。
    if (!persistedOk) return;
    handle.frozenSnapshot = this._buildSnapshot(handle);
    handle.session = null;
    handle.turnPromise = null;
    handle.abortController = null;
  }

  private _isLive(handle: ChildSessionHandle): boolean {
    return handle.lifecycle === "running" || handle.lifecycle === "blocked";
  }

  /** 从 handle 构建快照（用于 TUI 子会话面板）。 */
  private _buildSnapshot(handle: ChildSessionHandle): ChildSessionSnapshot {
    const session = handle.session;
    if (!session) {
      // 已释放——frozenSnapshot 是真相来源。
      if (handle.frozenSnapshot) return handle.frozenSnapshot;
      return {
        id: handle.id,
        numericId: handle.numericId,
        logRevision: 0,
        template: handle.template,
        mode: handle.mode,
        lifecycle: handle.lifecycle,
        phase: "idle",
        status: handle.status,
        outcome: handle.lastOutcome,
        running: false,
        lifetimeToolCallCount: handle.lifetimeToolCallCount,
        lastTotalTokens: handle.lastTotalTokens,
        lastToolCallSummary: handle.lastToolCallSummary,
        recentEvents: [...handle.recentEvents],
        pendingInboxCount: 0,
        lastActivityAt: handle.lastActivityAt,
        inputTokens: 0,
        contextBudget: 0,
        modelConfigName: "",
        modelProvider: "",
        modelDisplayLabel: "",
        thinkingLevel: "off",
        pendingAskId: null,
        pendingAskKind: null,
        activeLogEntryId: null,
        turnElapsed: handle.elapsed,
        cacheReadTokens: 0,
        cacheSupported: false,
      };
    }
    const currentTurnRunning = session.currentTurnRunning;
    const pendingAsk: PendingAskUi | null = session.getPendingAsk();
    const hasPendingResume = session.hasPendingTurnToResume();
    const phase = pendingAsk || hasPendingResume
      ? "waiting"
      : currentTurnRunning
        ? session.sessionPhase
        : "idle";
    const modelConfig = session.primaryAgent?.modelConfig;
    const modelDescriptor = modelConfig
      ? describeModel({
          configName: modelConfig.name,
          providerId: modelConfig.provider,
          selectionKey: modelConfig.model,
          modelId: modelConfig.model,
        })
      : null;
    const sessionLastTurnEndStatus = session.lastTurnEndStatus;
    const outcome =
      handle.lastOutcome !== "none"
        ? handle.lastOutcome
        : sessionLastTurnEndStatus === "completed"
          ? "completed"
          : sessionLastTurnEndStatus === "interrupted"
            ? "interrupted"
            : sessionLastTurnEndStatus === "error"
              ? "error"
              : "none";
    return {
      id: handle.id,
      numericId: handle.numericId,
      logRevision: session.getLogRevision(),
      template: handle.template,
      mode: handle.mode,
      lifecycle: handle.lifecycle,
      phase,
      status: handle.status,
      outcome,
      taskSummary: this._childTaskSummary(handle),
      running: currentTurnRunning,
      lifetimeToolCallCount: session.lifetimeToolCallCount,
      lastTotalTokens: session.lastTotalTokens,
      lastToolCallSummary: session.lastToolCallSummary,
      recentEvents: [...session.recentSessionEvents],
      pendingInboxCount: session.pendingInboxCount,
      lastActivityAt: handle.lastActivityAt,
      inputTokens: session.lastInputTokens,
      contextBudget: session.contextBudget,
      modelConfigName: modelConfig?.name ?? "",
      modelProvider: modelConfig?.provider ?? "",
      modelDisplayLabel: modelDescriptor?.scopedLabel ?? modelConfig?.model ?? "",
      thinkingLevel: session.thinkingLevel === "none" ? "off" : session.thinkingLevel,
      pendingAskId: pendingAsk?.id ?? null,
      pendingAskKind: pendingAsk?.kind ?? null,
      activeLogEntryId: session.activeLogEntryId,
      turnElapsed: handle.startTime > 0 && currentTurnRunning
        ? (performance.now() - handle.startTime) / 1000
        : handle.elapsed,
      cacheReadTokens: session.lastCacheReadTokens,
      cacheSupported: session.cacheSupported,
    };
  }

  /** 生成详细状态报告字符串。 */
  buildDetailedStatusReport(): string {
    const snapshots = this.getSnapshots();
    if (snapshots.length === 0) return "No sub-sessions tracked.";
    const sections = snapshots.map((snapshot) => {
      const recent = snapshot.recentEvents.length > 0
        ? snapshot.recentEvents.map((event, index) => `  ${index + 1}. ${event}`).join("\n")
        : "  (none)";
      const latest = snapshot.lastToolCallSummary || snapshot.recentEvents[snapshot.recentEvents.length - 1] || "(none)";
      return [
        `- ${snapshot.id}`,
        `  mode: ${snapshot.mode}`,
        `  lifecycle: ${snapshot.lifecycle}`,
        `  phase: ${snapshot.phase}`,
        `  outcome: ${snapshot.outcome}`,
        `  tokens: ${formatTokenCount(snapshot.lastTotalTokens)}`,
        `  tool calls: ${snapshot.lifetimeToolCallCount}`,
        `  pending inbox: ${snapshot.pendingInboxCount}`,
        `  latest: ${latest}`,
        `  recent:`,
        recent,
      ].join("\n\n");
    });
    return sections.join("\n\n");
  }

  // ==================================================================
  // Ask 路由辅助（ask 领域本身留在 Session）
  // ==================================================================

  /** 查找持有待处理 ask 的子会话。 */
  findChildWithPendingAsk(askId: string): ChildSessionHandle | null {
    for (const handle of this._handles.values()) {
      const ask = handle.session?.getPendingAsk();
      if (ask?.id === askId) return handle;
    }
    return null;
  }

  /** 恢复子会话的待处理 turn。 */
  resumeChildPendingTurn(handle: ChildSessionHandle): void {
    if (handle.turnPromise) return;
    const session = handle.session;
    if (!session?.hasPendingTurnToResume()) return;

    handle.startTime = performance.now();
    handle.status = "working";
    handle.lifecycle = "running";
    handle.phase = "waiting";
    handle.lastActivityAt = Date.now();
    handle.suspended = false;
    handle.terminationCause = undefined;
    handle.lastOutcome = "none";
    const abortController = new AbortController();
    handle.abortController = abortController;
    handle.settlePromise = new Promise<void>((resolve) => {
      handle.settleResolve = resolve;
    });
    handle.turnPromise = session.resumePendingTurn({ signal: abortController.signal });
    void handle.turnPromise.then(
      () => this.finishChildTurn(handle, undefined),
      (error: unknown) => this.finishChildTurn(handle, error),
    );
  }

  // ==================================================================
  // 生命周期
  // ==================================================================

  /** 计算子会话目录路径。 */
  childSessionDir(childId: string): string {
    return join(this.deps.resolveSessionArtifacts(), "agents", childId, "session");
  }

  /** 实例化子会话（创建 Session + handle，但不启动 turn）。 */
  instantiateChild(
    taskId: string,
    templateLabel: string,
    mode: ChildSessionMode,
    agent: Agent,
    opts?: { numericId?: number; order?: number },
  ): ChildSessionHandle {
    const numericId = opts?.numericId ?? (this._counter + 1);
    this._counter = Math.max(this._counter, numericId);
    const sessionDir = this.childSessionDir(taskId);
    const artifactsDir = join(sessionDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const shellLogDir = this.deps.resolveChildShellLogDir(taskId);

    const fullSystemPrompt = this.deps.buildSubAgentSystemPrompt(
      agent.systemPrompt,
      mode === "persistent",
    );
    agent.systemPrompt = fullSystemPrompt;

    const handle: ChildSessionHandle = {
      id: taskId,
      numericId,
      template: templateLabel,
      mode,
      lifecycle: "idle",
      status: "idle",
      phase: "idle",
      session: null,
      sessionDir,
      artifactsDir,
      resultText: "",
      elapsed: 0,
      startTime: 0,
      turnPromise: null,
      abortController: null,
      recentEvents: [],
      lifetimeToolCallCount: 0,
      lastToolCallSummary: "",
      lastTotalTokens: 0,
      lastOutcome: "none",
      lastActivityAt: Date.now(),
      order: opts?.order ?? numericId,
      suspended: false,
      settlePromise: null,
      settleResolve: null,
    };

    const childSession = this.deps.createChildSession({
      primaryAgent: agent,
      artifactsDir,
      shellLogDir,
      // 根会话 key + child id：同一子任务续跑保持 affinity，同时与
      // 其他根会话/子会话隔离。恢复时若子日志已有持久化 key，会覆盖此值。
      promptCacheKey: childPromptCacheKey(this.deps.getPromptCacheKey(), taskId),
      onTurnOutput: (text: string) => this._handleChildTurnOutput(taskId, text),
      onSaveRequest: () => this.deps.saveChildSession(handle),
    });
    handle.session = childSession;
    return handle;
  }

  /** 创建并启动子会话（持久化 + fire SubagentStart hook）。 */
  createChild(
    taskId: string,
    templateLabel: string,
    mode: ChildSessionMode,
    agent: Agent,
  ): ChildSessionHandle {
    const handle = this.instantiateChild(taskId, templateLabel, mode, agent);
    this.deps.saveChildSession(handle);
    this.deps.fireHook("SubagentStart", {
      event: "SubagentStart",
      timestamp: Date.now(),
      agentId: taskId,
    });
    return handle;
  }

  private _handleChildTurnOutput(childId: string, text: string): void {
    const handle = this._handles.get(childId);
    if (!handle) return;
    handle.resultText = text;
    handle.lastActivityAt = Date.now();
  }

  /** 启动子会话 turn。 */
  private _startChildTurn(handle: ChildSessionHandle, input: string, options?: { skipUserInput?: boolean }): void {
    const session = handle.session;
    if (!session) return; // 已释放 one-shot——模式守卫不可达
    handle.startTime = performance.now();
    handle.status = "working";
    handle.lifecycle = "running";
    handle.phase = "thinking";
    handle.lastActivityAt = Date.now();
    handle.suspended = false;
    handle.terminationCause = undefined;
    handle.lastOutcome = "none";
    const abortController = new AbortController();
    handle.abortController = abortController;
    // 创建 settle promise 以便 close() 等待本 turn 结束
    handle.settlePromise = new Promise<void>((resolve) => {
      handle.settleResolve = resolve;
    });
    handle.turnPromise = session.turn(input, { signal: abortController.signal, skipUserInput: options?.skipUserInput });
    this.deps.requestSave();
    void handle.turnPromise.then(
      () => this.finishChildTurn(handle, undefined),
      (error: unknown) => this.finishChildTurn(handle, error),
    );
  }

  /**
   * 完成子会话 turn。
   *
   * 处理：中断完成、自然完成、错误。
   * 关键不变量：
   * - 僵尸回调守卫：suspended handle 直接返回
   * - released handle 直接返回
   * - oneshot → lifecycle=archived；persistent → lifecycle=idle
   * - 自然完成的 persistent 子会话若有排队消息则自动恢复
   */
  finishChildTurn(handle: ChildSessionHandle, error?: unknown): void {
    // 僵尸守卫：close/suspend 已处理此 handle，直接退出。
    if (handle.suspended) {
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    // released handle 无运行中 turn——若是僵尸回调则直接退出。
    const session = handle.session;
    if (!session) {
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    handle.elapsed = handle.startTime > 0 ? (performance.now() - handle.startTime) / 1000 : 0;

    const pendingAsk = !error ? session.getPendingAsk() : null;
    const hasPendingResume = !error ? session.hasPendingTurnToResume() : false;
    if (!error && (pendingAsk || hasPendingResume)) {
      handle.abortController = null;
      handle.turnPromise = null;
      handle.lifecycle = "blocked";
      handle.status = "idle";
      handle.phase = "waiting";
      handle.lastOutcome = "none";
      handle.lastActivityAt = Date.now();
      this.deps.saveChildSession(handle);
      this.deps.notifyLogListeners();
      this.deps.requestSave();
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    handle.abortController = null;
    handle.turnPromise = null;
    handle.lastActivityAt = Date.now();

    // 触发 SubagentStop hook
    this.deps.fireHook("SubagentStop", {
      event: "SubagentStop",
      timestamp: Date.now(),
      agentId: handle.id,
    });

    // 从 error / endStatus 确定 outcome
    const endStatus = error ? "error" : session.lastTurnEndStatus;
    if (error || endStatus === "error") {
      handle.lastOutcome = "error";
      handle.status = "error";
    } else if (endStatus === "interrupted") {
      handle.lastOutcome = "interrupted";
      handle.status = handle.mode === "oneshot" ? "interrupted" : "idle";
    } else {
      handle.lastOutcome = "completed";
      handle.status = handle.mode === "oneshot" ? "completed" : "idle";
    }

    const outcome: "completed" | "failed" | "interrupted" =
      handle.lastOutcome === "error"
        ? "failed"
        : handle.lastOutcome === "interrupted"
          ? "interrupted"
          : "completed";
    const cause = handle.terminationCause ?? "natural";
    const agentResult = this._buildAgentResultApiContent(handle, outcome, cause);
    this.deps.appendEntry(createAgentResult(
      this.deps.nextLogId("agent_result"),
      this.deps.getTurnCount(),
      handle.id,
      handle.numericId,
      handle.template,
      outcome,
      cause,
      Math.round((handle.elapsed ?? 0) * 1000),
      agentResult.content,
      this.deps.allocateContextId(),
      agentResult.fullOutputPath,
    ), false);

    // 用户发起 kill 随附传递：用户在场并引导，父会话不应自动唤醒。
    // 自然完成/失败保持唤醒 idle 父会话（安全网）。
    const userInitiatedKill = cause === "user_targeted_kill" || cause === "user_mass_interrupt";
    this.deps.deliverMessageToParent({
      type: "peer_message",
      sender: handle.id,
      content: agentResult.content,
      timestamp: Date.now(),
      wake: !userInitiatedKill,
    });
    handle.terminationCause = undefined;

    // 子拆分结果回传：在冻结/释放之前抓取（释放后 Session 就没了）。
    this._reportChildSettled(handle, cause);

    // 生命周期转换：oneshot → archived，persistent → idle
    let savedOk = false;
    if (handle.mode === "oneshot") {
      handle.lifecycle = "archived";
      savedOk = this.deps.saveChildSession(handle);
    } else {
      handle.lifecycle = "idle";
      this.deps.saveChildSession(handle);
    }
    this.deps.requestSave();

    if (handle.mode === "persistent") {
      // persistent：自然完成后自动恢复排队消息。
      if (cause === "natural") {
        if (this.deps.childHasInbox(session)) {
          const resolve = handle.settleResolve;
          handle.settleResolve = null;
          resolve?.();
          this._startChildTurn(handle, "", { skipUserInput: true });
          return;
        }
      }
    }

    const resolve = handle.settleResolve;
    handle.settleResolve = null;
    resolve?.();

    // one-shot 子会话在此终结——丢弃 Session（日志已在 saveChildSession 持久化）。
    this._freezeAndRelease(handle, savedOk);
  }

  /** 子会话自己的任务清单摘要（纯内存读取；已释放或无清单时返回 undefined）。 */
  private _childTaskSummary(handle: ChildSessionHandle): { total: number; open: number; done: number } | undefined {
    const getTaskState = handle.session && typeof handle.session.getTaskState === "function"
      ? handle.session.getTaskState.bind(handle.session)
      : undefined;
    const tasks = getTaskState?.();
    if (!tasks || tasks.length === 0) return undefined;
    const done = tasks.filter((task) => task.status === "completed").length;
    return { total: tasks.length, open: tasks.length - done, done };
  }

  /** 拍下子代理自己的未完成任务，供 Queen 判断是否需要重派。 */
  private _childOpenTasks(handle: ChildSessionHandle): ChildTaskHandoff[] {
    const getTaskState = handle.session && typeof handle.session.getTaskState === "function"
      ? handle.session.getTaskState.bind(handle.session)
      : undefined;
    return (getTaskState?.() ?? [])
      .filter((task) => task.status === "pending" || task.status === "in_progress")
      .map((task) => ({
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status === "pending" ? "pending" as const : "in_progress" as const,
        activeForm: task.activeForm,
        blocks: [...task.blocks],
        blockedBy: [...task.blockedBy],
      }));
  }

  private _reportChildSettled(
    handle: ChildSessionHandle,
    cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt",
  ): void {
    try {
      this.deps.reportChildSettled?.({
        childId: handle.id,
        outcome: handle.lastOutcome,
        cause,
        taskSummary: this._childTaskSummary(handle),
        openTasks: this._childOpenTasks(handle),
      });
    } catch (error) {
      console.warn(`Failed to report child settle for '${handle.id}':`, error);
    }
  }

  private _formatChildOpenTasks(tasks: readonly ChildTaskHandoff[]): string {
    if (tasks.length === 0) return "";
    const lines = ["## Unfinished child tasks", "Queen owns reassignment; these local task IDs belong only to this child session."];
    for (const task of tasks) {
      lines.push(`- [${task.status}] local #${task.id}: ${task.subject}`);
      lines.push(`  Description: ${task.description.replace(/\s+/g, " ").trim()}`);
      if (task.activeForm) lines.push(`  Active form: ${task.activeForm}`);
      if (task.blockedBy.length > 0) lines.push(`  Blocked by local tasks: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
      if (task.blocks.length > 0) lines.push(`  Blocks local tasks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
    }
    return lines.join("\n");
  }

  /** 构建 agent_result 内容（处理输出截断和溢出文件）。 */
  private _buildAgentResultApiContent(
    handle: ChildSessionHandle,
    outcome: "completed" | "failed" | "interrupted",
    cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt",
  ): { content: string; fullOutputPath?: string } {
    const causeNote = (cause === "user_mass_interrupt" || cause === "user_targeted_kill")
      ? " by the user"
      : "";
    const header = `[Agent "${handle.id}" ${outcome}${causeNote}]`;
    const text = (handle.resultText ?? "").trim();
    const unfinishedTasks = this._formatChildOpenTasks(this._childOpenTasks(handle));
    const taskSuffix = unfinishedTasks ? `\n\n${unfinishedTasks}` : "";

    if (!text) {
      return { content: `${header}\n(no output)${taskSuffix}` };
    }

    if (text.length > SUB_AGENT_OUTPUT_LIMIT) {
      const outputDir = join(this.deps.getArtifactsDir(), "agent-outputs");
      mkdirSync(outputDir, { recursive: true });
      const relativePath = `artifacts/agent-outputs/${handle.id}.md`;
      const outputPath = join(outputDir, `${handle.id}.md`);
      writeFileSync(outputPath, text);
      const truncated = text.slice(0, SUB_AGENT_OUTPUT_LIMIT);
      const truncatedAtLine = truncated.split("\n").length;
      return {
        content:
          `${header}\n` +
          `(Output truncated at ${SUB_AGENT_OUTPUT_LIMIT.toLocaleString()} chars ` +
          `(line ${truncatedAtLine}). Full output: ${relativePath}. ` +
          `Continue reading from line ${truncatedAtLine} with \`read_file(start_line=${truncatedAtLine})\`; ` +
          `do not reread the portion already received.)\n\n` +
          truncated + taskSuffix,
        fullOutputPath: relativePath,
      };
    }

    return { content: `${header}\n${text}${taskSuffix}` };
  }

  /** 将 handle 从 live 表移到 archived 表，释放 Session 实例。 */
  private _archiveHandle(handle: ChildSessionHandle): void {
    this._archived.set(handle.id, {
      id: handle.id,
      numericId: handle.numericId,
      template: handle.template,
      mode: handle.mode,
      outcome: handle.lastOutcome,
      status: handle.status,
      terminationCause: handle.terminationCause,
      order: handle.order,
      sessionDir: handle.sessionDir,
      artifactsDir: handle.artifactsDir,
    });
    this._handles.delete(handle.id);
  }

  /**
   * 断点续跑入口（启动对账后由主 agent 经 task_resume 调用）。
   *
   * 与 `send` 的区别：
   *  - 允许 **oneshot** 子会话续跑（`send` 对 oneshot 有硬守卫 `cannot receive messages`）
   *  - 续跑文本作为该轮的**直接输入**（与 spawn 语义一致），而不是 `[Incoming Messages]`，
   *    以免与 oneshot 提示词的 "You cannot receive follow-up messages" 冲突
   *
   * 前置条件：handle 存在且 Session 未被释放 —— 对账判定为"可续"的子会保留 Session。
   */
  resumeChildTurn(childId: string, prompt: string): { ok: boolean; reason?: string } {
    const handle = this._handles.get(childId);
    if (!handle) return { ok: false, reason: "child_not_found" };
    if (!handle.session) return { ok: false, reason: "child_released" };
    if (this._isLive(handle)) return { ok: false, reason: "already_running" };
    this._startChildTurn(handle, prompt);
    return { ok: true };
  }

  /** send tool 实现：向 persistent 子会话发送消息（可复活 archived persistent）。 */
  sendMessageToChild(childId: string, msg: MessageEnvelope): ToolResult {
    const handle = this._handles.get(childId);
    if (!handle) {
      return new ToolResult({ content: `Agent '${childId}' not found.` });
    }
    if (handle.mode !== "persistent") {
      return new ToolResult({ content: `Agent '${childId}' is one-shot and cannot receive messages.` });
    }
    // persistent 子会话在根会话生命周期内保留 Session——
    // 此处为 null 意味着释放不变量被打破；软失败。
    const session = handle.session;
    if (!session) {
      return new ToolResult({ content: `Agent '${childId}' is no longer active.` });
    }
    if (handle.lifecycle === "archived") {
      // persistent archived 子会话仍在 live 表中——原地复活。
      if (handle.mode === "persistent") {
        handle.lastActivityAt = Date.now();
        // 标准传递（从不是原始 inbox 推送）：填充子会话引流不变量所需的记账字段。
        this.deps.deliverToChild(session, { ...msg, wake: false });
        this._startChildTurn(handle, "", { skipUserInput: true });
        return new ToolResult({ content: `Agent '${childId}' revived and message sent.` });
      }
      return new ToolResult({ content: `Agent '${childId}' is a one-shot agent and cannot receive messages.` });
    }

    handle.lastActivityAt = Date.now();
    if (handle.lifecycle === "blocked") {
      return new ToolResult({
        content:
          `ERROR: Agent '${childId}' is waiting for user approval and cannot receive new messages. ` +
          "Resolve the pending approval first.",
      });
    }
    if (handle.lifecycle === "running") {
      this.deps.deliverToChild(session, msg);
      return new ToolResult({ content: `Message sent to '${childId}'.` });
    }

    // idle——排队消息并启动 turn。标准传递填充记账字段；wake:false 因显式启动 turn。
    this.deps.deliverToChild(session, { ...msg, wake: false });
    this._startChildTurn(handle, "", { skipUserInput: true });
    return new ToolResult({ content: `Message sent to '${childId}'.` });
  }

  /** 中断 blocked 子会话（abortController 可用时直接 abort，否则正规化）。 */
  private _interruptBlockedChild(handle: ChildSessionHandle, message: string): void {
    const session = handle.session;
    if (!session) return; // 已释放的子会话无待处理 turn
    this.deps.normalizeChildInterruptedTurn(session, message);
    session.requestTurnInterrupt();
    handle.lifecycle = handle.mode === "oneshot" ? "archived" : "idle";
    handle.status = handle.mode === "oneshot" ? "interrupted" : "idle";
    handle.phase = "idle";
    handle.lastOutcome = "interrupted";
    handle.lastActivityAt = Date.now();
    this._reportChildSettled(handle, handle.terminationCause ?? "user_targeted_kill");
    const savedOk = this.deps.saveChildSession(handle);
    // blocked one-shot 从不在 finishChildTurn 到达此处——此处释放使"archived one-shot 已释放"不变量无持续例外。
    this._freezeAndRelease(handle, savedOk);
  }

  /** 中断单个子会话。 */
  interruptChild(childId: string): { accepted: boolean; reason?: string } {
    const handle = this._handles.get(childId);
    if (!handle) return { accepted: false, reason: "not_found" };
    if (!this._isLive(handle)) return { accepted: false, reason: "not_live" };
    handle.terminationCause = "user_targeted_kill";
    if (handle.abortController) {
      handle.abortController.abort();
    } else {
      this._interruptBlockedChild(handle, "Sub-agent was interrupted while waiting for user approval.");
      this.deps.notifyLogListeners();
      this.deps.requestSave();
    }
    return { accepted: true };
  }

  hasActiveAgents(): boolean {
    return this._getWorkingHandles().length > 0;
  }

  private _getWorkingHandles(): ChildSessionHandle[] {
    return [...this._handles.values()].filter((handle) => {
      return handle.lifecycle === "running" && handle.turnPromise !== null;
    });
  }

  /** 级联杀死所有运行中的子会话。 */
  cascadeKillRunning(cause: "user_mass_interrupt" | "parent_kill"): number {
    let interrupted = 0;
    for (const handle of this._handles.values()) {
      if (!this._isLive(handle)) continue;
      handle.terminationCause = cause;
      if (handle.session) {
        this.deps.recordChildEvent(handle.session, cause === "user_mass_interrupt" ? "interrupted by user" : "interrupted by parent");
      }
      if (handle.abortController) {
        handle.abortController.abort();
      } else {
        this._interruptBlockedChild(handle, cause === "user_mass_interrupt"
          ? "Sub-agent was interrupted while waiting for user approval."
          : "Parent session was interrupted.");
      }
      interrupted += 1;
    }
    return interrupted;
  }

  /**
   * 为 close() 挂起所有子会话。
   * 持久化所有非 archived 子会话的日志和 inbox。
   */
  suspendAll(): void {
    const toArchive: string[] = [];
    for (const [name, handle] of this._handles) {
      handle.suspended = true;
      if (this._isLive(handle) && handle.session) {
        handle.abortController?.abort();
        this.deps.normalizeChildInterruptedTurn(
          handle.session,
          "Parent session was interrupted by the user.",
        );
        handle.terminationCause ??= "parent_kill";
        handle.lastOutcome = "interrupted";
        if (handle.mode === "oneshot") {
          handle.lifecycle = "archived";
          handle.status = "interrupted";
          toArchive.push(name);
        } else {
          handle.lifecycle = "idle";
          handle.status = "idle";
        }
        handle.lastActivityAt = Date.now();
        this._reportChildSettled(handle, handle.terminationCause ?? "parent_kill");
        const progress = this.deps.getProgress();
        if (progress) {
          progress.emit({
            step: this.deps.getTurnCount(),
            agent: name,
            action: "agent_suspended",
            message: `  [#${handle.numericId} ${name}] suspended (${handle.lifecycle})`,
            level: "normal" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {},
            extra: { sub_agent_id: handle.numericId },
          });
        }
      }
      this.deps.saveChildSession(handle);
    }
    for (const id of toArchive) {
      const handle = this._handles.get(id);
      if (handle) this._archiveHandle(handle);
    }
  }

  /**
   * 无条件归档所有子会话（用于 /new）。
   * 所有子会话——无论模式或当前生命周期——均变为 archived。
   */
  archiveAll(): void {
    for (const [, handle] of this._handles) {
      handle.suspended = true;
      if (this._isLive(handle) && handle.session) {
        handle.abortController?.abort();
        this.deps.normalizeChildInterruptedTurn(
          handle.session,
          "Session was reset by user.",
        );
        handle.lastOutcome = handle.lastOutcome === "none" ? "interrupted" : handle.lastOutcome;
      }
      handle.lifecycle = "archived";
      handle.status = "terminated";
      handle.terminationCause ??= "parent_kill";
      handle.lastActivityAt = Date.now();
      this._reportChildSettled(
        handle,
        handle.terminationCause ?? (handle.lastOutcome === "completed" ? "natural" : "parent_kill"),
      );
      this.deps.saveChildSession(handle);
    }
    for (const [, handle] of this._handles) {
      this._archived.set(handle.id, {
        id: handle.id,
        numericId: handle.numericId,
        template: handle.template,
        mode: handle.mode,
        outcome: handle.lastOutcome,
        status: handle.status,
        terminationCause: handle.terminationCause,
        order: handle.order,
        sessionDir: handle.sessionDir,
        artifactsDir: handle.artifactsDir,
      });
    }
    this._handles.clear();
  }

  // -- 启动对账（重启后子代理一律视为已终止） --------------------------

  /** 恢复失败的子：子代理 id → 原因。 */
  getRestoreFailures(): ReadonlyMap<string, "log_unavailable" | "template_missing" | "model_unavailable"> {
    return this._restoreFailures;
  }

  /**
   * 启动对账输入：每个已恢复子会话的可判定信号。
   *
   * 指标取自子会话自身：`lifetimeToolCallCount` 恢复时由日志重算，
   * `cumulativeInputTokens` 由 `token_update` 条目求和 —— 重启后依然可用，
   * 不需要为阈值额外持久化任何字段。
   */
  getResumeSignals(): Array<{
    childId: string;
    mode: ChildSessionMode;
    outcome: ChildSessionOutcome;
    cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt" | undefined;
    toolCalls: number;
    tokensIn: number;
    sessionAvailable: boolean;
  }> {
    type ResumeSignal = ReturnType<ChildSessionManager["getResumeSignals"]>[number];
    const signals: ResumeSignal[] = [];
    for (const handle of this._handles.values()) {
      signals.push({
        childId: handle.id,
        mode: handle.mode,
        outcome: handle.lastOutcome,
        cause: handle.terminationCause,
        toolCalls: handle.session?.lifetimeToolCallCount ?? handle.lifetimeToolCallCount,
        tokensIn: handle.session?.cumulativeInputTokens ?? 0,
        sessionAvailable: handle.session !== null,
      });
    }
    return signals;
  }

  /**
   * 启动对账归一：把"曾经活着"的子会话统一落成 fail。
   *
   * - 可续：`idle` + `status:error` + **保留 Session**（等主 agent 显式 task_resume）
   * - 不可续：`archived` + `status:error` + **释放 Session**（日志按需从磁盘读取）
   *
   * `outcome` 固定为 `interrupted`（"被重启打断"），绝不用 `error` —— 否则下次重启
   * 的判定会读到 `error` 而永久拒绝续跑（自锁）。
   */
  finalizeRestoredChild(childId: string, resumable: boolean): void {
    const handle = this._handles.get(childId);
    if (!handle) return;
    const state = childRestartState(resumable, handle.lastOutcome);
    handle.lifecycle = state.lifecycle;
    handle.status = state.status;
    handle.lastOutcome = state.outcome;
    handle.suspended = true;
    handle.terminationCause = undefined;

    if (handle.session && !state.keepSession) {
      // 先落盘再释放：释放后磁盘副本是唯一副本。
      const savedOk = this.deps.saveChildSession(handle);
      if (savedOk) handle.session.finalizeRewindJournal();
      handle.frozenSnapshot = this._buildSnapshot(handle);
      handle.session = null;
      handle.turnPromise = null;
      handle.abortController = null;
      handle.settlePromise = null;
      handle.settleResolve = null;
      if (!savedOk) {
        console.warn(`Failed to persist child session '${childId}' before release.`);
      }
      return;
    }
    const savedOk = this.deps.saveChildSession(handle);
    if (savedOk) handle.session?.finalizeRewindJournal();
  }

  /** 等待所有运行中的子会话 turn 结束（带超时）。 */
  async waitForAllTurnsSettled(): Promise<void> {
    const SETTLE_TIMEOUT_MS = 3000;
    const settlePromises = [...this._handles.values()]
      .filter((h) => h.settlePromise)
      .map((h) => h.settlePromise!);
    if (settlePromises.length === 0) return;
    await Promise.race([
      Promise.all(settlePromises),
      new Promise<void>((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
    ]);
  }

  // ==================================================================
  // spawn / kill_agent / send tool 实现
  // ==================================================================

  /** spawn tool 实现：批量实例化并启动子会话。 */
  spawnFromSpecs(tasksSpec: Array<Record<string, unknown>>): ToolResult {
    const spawned: string[] = [];
    const spawnedInfo: Array<{ numericId: number; taskId: string; template: string; task: string }> = [];
    const errors: string[] = [];

    for (const spec of tasksSpec) {
      const taskId = ((spec["id"] as string) ?? "").trim();
      const templateName = ((spec["template"] as string) ?? "").trim();
      const templatePath = ((spec["template_path"] as string) ?? "").trim();
      const taskDesc = ((spec["task"] as string) ?? "").trim();
      const modeRaw = ((spec["mode"] as string) ?? "").trim();

      if (!taskId || !taskDesc) {
        errors.push("Skipped entry: missing 'id' or 'task'.");
        continue;
      }
      if (!templateName && !templatePath) {
        errors.push(`'${taskId}': must specify either 'template' or 'template_path'.`);
        continue;
      }
      if (templateName && templatePath) {
        errors.push(`'${taskId}': cannot specify both 'template' and 'template_path'.`);
        continue;
      }
      if (this._handles.has(taskId)) {
        errors.push(`'${taskId}': already running.`);
        continue;
      }

      if (modeRaw !== "oneshot" && modeRaw !== "persistent") {
        errors.push(`'${taskId}': mode must be 'oneshot' or 'persistent'.`);
        continue;
      }
      const mode: ChildSessionMode = modeRaw;

      let agent: Agent;
      let tierThinkingLevel: string | undefined;
      let templateLabel: string;
      try {
        if (templateName) {
          ({ agent, thinkingLevel: tierThinkingLevel } = this.deps.createFromPredefined(templateName, taskId));
          templateLabel = templateName;
        } else {
          const resolvedPath = this.deps.resolveTemplatePath(templatePath);
          ({ agent, thinkingLevel: tierThinkingLevel } = this.deps.createFromPath(resolvedPath, taskId));
          templateLabel = templatePath;
        }
      } catch (e) {
        errors.push(`'${taskId}': ${e}`);
        continue;
      }

      const primaryAgent = this.deps.getPrimaryAgent();
      if (mode === "persistent" && !primaryAgent.tools.some((t) => t.name === "send")) {
        primaryAgent.tools.push(SEND_TOOL);
      }

      const handle = this.createChild(taskId, templateLabel, mode, agent);
      // tier/pin 优先；否则继承父会话的首选层级。
      if (handle.session) {
        handle.session.thinkingLevel = tierThinkingLevel ?? this.deps.getPreferredThinkingLevel();
      }
      this._handles.set(taskId, handle);
      spawned.push(taskId);
      spawnedInfo.push({ numericId: handle.numericId, taskId, template: templateLabel, task: taskDesc });

      const progress = this.deps.getProgress();
      if (progress) {
        progress.onAgentStart(
          this.deps.getTurnCount(),
          taskId,
          { sub_agent_id: handle.numericId, template: templateLabel },
        );
      }

      this._startChildTurn(handle, taskDesc);
    }

    const parts: string[] = [];
    if (spawned.length) {
      parts.push(
        `Spawned ${spawned.length} sub-session(s): ${spawned.join(", ")}. ` +
        "Results will be delivered as each child session completes a turn.",
      );
    }
    if (errors.length) {
      parts.push("Errors: " + errors.join(" | "));
    }

    // 构建 TUI 预览：列出每个子代理及截断任务
    let previewText: string | undefined;
    if (spawnedInfo.length) {
      const maxTaskLen = 60;
      const lines = spawnedInfo.map((info) => {
        const taskOneLine = info.task.replace(/\s+/g, " ");
        const taskTrunc = taskOneLine.length > maxTaskLen
          ? taskOneLine.slice(0, maxTaskLen - 1) + "…"
          : taskOneLine;
        return `  #${info.numericId} ${info.taskId} [${getAgentRoleLabel(info.template)}] — ${taskTrunc}`;
      });
      previewText = `Spawned ${spawnedInfo.length} sub-agent(s):\n${lines.join("\n")}`;
    }

    return new ToolResult({
      content: parts.join("\n") || "No agents spawned.",
      metadata: previewText ? { tui_preview: { text: previewText, dim: true } } : undefined,
    });
  }

  killAgent(id: string): { accepted: boolean; reason?: string } {
    const result = this._killAgent(id);
    if (result.accepted) {
      this.deps.notifyLogListeners();
      this.deps.requestSave();
    }
    return result;
  }

  /** kill_agent 工具批量终止多个子代理。 */
  killAgents(ids: string[]): ToolResult {
    const killed: string[] = [];
    const notFound: string[] = [];
    const alreadyArchived: string[] = [];

    for (const id of ids) {
      const result = this._killAgent(id);
      if (result.accepted) killed.push(id);
      else if (result.reason === "already_archived") alreadyArchived.push(id);
      else notFound.push(id);
    }

    if (killed.length > 0) {
      this.deps.notifyLogListeners();
      this.deps.requestSave();
    }

    const parts: string[] = [];
    if (killed.length) parts.push(`Killed: ${killed.join(", ")}.`);
    if (alreadyArchived.length) parts.push(`Already archived: ${alreadyArchived.join(", ")}.`);
    if (notFound.length) parts.push(`Not found: ${notFound.join(", ")}.`);
    return new ToolResult({ content: parts.join(" ") });
  }

  private _killAgent(id: string): { accepted: boolean; reason?: string } {
    const handle = this._handles.get(id);
    if (!handle) {
      return this._archived.has(id)
        ? { accepted: false, reason: "already_archived" }
        : { accepted: false, reason: "not_found" };
    }

    handle.abortController?.abort();
    handle.lifecycle = "archived";
    handle.status = "terminated";
    handle.lastOutcome = "interrupted";
    handle.lastActivityAt = Date.now();
    if (handle.session) {
      this.deps.recordChildEvent(handle.session, "terminated by parent");
    }
    // 已释放的 handle 以 frozen snapshot 作为展示数据源。
    if (handle.frozenSnapshot) {
      handle.frozenSnapshot = {
        ...handle.frozenSnapshot,
        lifecycle: handle.lifecycle,
        outcome: handle.lastOutcome,
        lastActivityAt: handle.lastActivityAt,
        running: false,
      };
    }
    this.deps.saveChildSession(handle);

    const progress = this.deps.getProgress();
    if (progress) {
      progress.emit({
        step: this.deps.getTurnCount(),
        agent: id,
        action: "agent_killed",
        message: `  [#${handle.numericId} ${id}] archived`,
        level: "normal" as ProgressLevel,
        timestamp: Date.now() / 1000,
        usage: {},
        extra: { sub_agent_id: handle.numericId },
      });
    }
    return { accepted: true };
  }

  /** send tool 实现：直接发送或复活 archived persistent 子会话。 */
  async sendOrRevive(to: string, content: string): Promise<ToolResult> {
    if (!this._handles.has(to)) {
      const archived = this._archived.get(to);
      if (archived) {
        if (archived.mode !== "persistent") {
          return new ToolResult({ content: `Agent '${to}' is a one-shot agent and cannot be revived.` });
        }
        try {
          await this._reviveArchivedChild(archived, content);
          return new ToolResult({ content: `Agent '${to}' revived from archive and message sent.` });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return new ToolResult({ content: `Failed to revive agent '${to}': ${reason}` });
        }
      }
    }

    return this.sendMessageToChild(to, { type: "user_input", sender: "queen", content, timestamp: Date.now() });
  }

  /** 复活 archived persistent 子会话：重建 Session、恢复日志、启动 turn。 */
  private async _reviveArchivedChild(record: ArchivedChildRecord, messageContent: string): Promise<void> {
    const loaded = loadLog(record.sessionDir);
    const repaired = validateAndRepairLog(loaded.entries);
    const persistedSelection = this._persistedChildModelSelection(loaded.meta);
    let agent: Agent;
    if (this.deps.getAgentTemplates()[record.template]) {
      ({ agent } = this.deps.createFromPredefined(record.template, record.id, persistedSelection));
    } else {
      ({ agent } = this.deps.createFromPath(this.deps.resolveTemplatePath(record.template), record.id, persistedSelection));
    }

    const handle = this.instantiateChild(
      record.id,
      record.template,
      record.mode,
      agent,
      { numericId: record.numericId, order: record.order },
    );

    // 从磁盘恢复日志
    const session = handle.session;
    if (!session) throw new Error(`freshly instantiated child '${record.id}' has no session`);
    session.restoreFromLog(loaded.meta, repaired.entries, loaded.idAllocator);
    session.recoverRewindIfNeeded();
    handle.lifecycle = "idle";
    handle.lastOutcome = record.outcome;
    handle.lastActivityAt = Date.now();
    handle.resultText = extractLatestAssistantText(session.log);

    // 从 archived 移到 active
    this._handles.set(record.id, handle);
    this._archived.delete(record.id);

    // 传递消息并启动 turn（标准传递——见 sendMessageToChild）
    this.deps.deliverToChild(session, {
      type: "user_input",
      sender: "queen",
      content: messageContent,
      timestamp: Date.now(),
      wake: false,
    });
    this._startChildTurn(handle, "", { skipUserInput: true });

    // 触发根会话保存（因子会话引用已变更）
    this.deps.requestSave();
  }

  // ==================================================================
  // 分阶段子会话恢复
  // ==================================================================

  /** 准备子会话恢复：加载日志、验证、修复。 */
  prepareChildRestores(
    childSessions: ChildSessionMetaRecord[],
    warnings: string[],
  ): PreparedChildRestore[] {
    this._restoreFailures.clear();
    if (childSessions.length === 0) return [];

    const prepared: PreparedChildRestore[] = [];
    const ordered = [...childSessions].sort((a, b) => (a.order ?? a.numericId) - (b.order ?? b.numericId));
    for (const record of ordered) {
      const sessionDir = this.childSessionDir(record.id);
      const artifactsDir = join(sessionDir, "artifacts");
      let loaded: LoadLogResult;

      try {
        loaded = loadLog(sessionDir);
        const repaired = validateAndRepairLog(loaded.entries);
        if (repaired.repaired) {
          for (const warning of repaired.warnings) {
            warnings.push(`[repair:${record.id}] ${warning}`);
          }
        }
        loaded = { ...loaded, entries: repaired.entries };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to load child session '${record.id}': ${reason}`);
        this._restoreFailures.set(record.id, "log_unavailable");
        continue;
      }

      let agent: Agent;
      try {
        const persistedSelection = this._persistedChildModelSelection(loaded.meta);
        if (this.deps.getAgentTemplates()[record.template]) {
          ({ agent } = this.deps.createFromPredefined(record.template, record.id, persistedSelection));
        } else {
          ({ agent } = this.deps.createFromPath(this.deps.resolveTemplatePath(record.template), record.id, persistedSelection));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to prepare child session '${record.id}': ${reason}`);
        this._restoreFailures.set(record.id, e instanceof RoleModelResolutionError ? "model_unavailable" : "template_missing");
        continue;
      }

      prepared.push({ record, agent, sessionDir, artifactsDir, loaded });
    }
    return prepared;
  }

  private _persistedChildModelSelection(meta: LogSessionMeta): PersistedRoleModelSelection {
    return {
      modelConfigName: meta.modelConfigName || undefined,
      modelProvider: meta.modelProvider,
      modelSelectionKey: meta.modelSelectionKey,
      modelId: meta.modelId,
      thinkingLevel: meta.thinkingLevel,
    };
  }

  /** 提交已准备的子会话恢复。 */
  commitPreparedChildren(children: PreparedChildRestore[]): string[] {
    if (children.length === 0) return [];

    const warnings: string[] = [];
    for (const prepared of children) {
      const { record, agent, loaded } = prepared;
      try {
        const handle = this.instantiateChild(
          record.id,
          record.template,
          record.mode,
          agent,
          { numericId: record.numericId, order: record.order },
        );
        const session = handle.session;
        if (!session) throw new Error("freshly instantiated child has no session");
        session.restoreFromLog(loaded.meta, loaded.entries, loaded.idAllocator);
        session.recoverRewindIfNeeded();
        handle.lifecycle = record.lifecycle;
        handle.terminationCause = record.terminationCause;
        const restoredEndStatus = session.lastTurnEndStatus;
        const outcomeFromLog: ChildSessionOutcome | undefined = restoredEndStatus === "error"
          ? "error"
          : restoredEndStatus === "interrupted"
            ? "interrupted"
            : restoredEndStatus === "completed"
              ? "completed"
              : undefined;
        const hadLiveTurn = record.lifecycle === "running" || record.lifecycle === "blocked";
        handle.lastOutcome = (hadLiveTurn ? outcomeFromLog : record.outcome ?? outcomeFromLog) ?? "none";
        handle.lastActivityAt = Date.now();
        handle.resultText = extractLatestAssistantText(session.log);
        const storedStatus = record.status && ["working", "idle", "error", "interrupted", "terminated", "completed"].includes(record.status)
          ? record.status as ChildSessionStatus
          : undefined;
        const settledStatus: ChildSessionStatus = handle.lastOutcome === "completed"
          ? "completed"
          : handle.lastOutcome === "error"
            ? "error"
            : handle.lastOutcome === "interrupted"
              ? "interrupted"
              : record.lifecycle === "archived"
                ? "terminated"
                : "idle";
        handle.status = record.lifecycle === "running" || record.lifecycle === "blocked"
          ? "error"
          : storedStatus && storedStatus !== "working"
            ? storedStatus
            : settledStatus;

        if (record.inbox && record.inbox.length > 0) {
          // 已结束 one-shot 的恢复 inbox 在下方 release 时丢弃：
          // 无任何传递能向其送达或耗尽（release 前已读但从未耗尽）。
          this.deps.setChildInbox(
            session,
            record.inbox.map((m) => migrateMessageEnvelope(m as unknown as Record<string, unknown>)),
          );
        }

        this._handles.set(record.id, handle);
        // 已结束 one-shot 子会话以 released 状态返回，与 live settle 同。
        const savedOk = this.deps.saveChildSession(handle);
        if (savedOk) session.finalizeRewindJournal();
        this._freezeAndRelease(handle, savedOk);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to restore child session '${record.id}': ${reason}`);
        this._restoreFailures.set(record.id, "log_unavailable");
      }
    }

    return warnings;
  }
}
