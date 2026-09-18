/**
 * ChildSessionManager —— 拥有会话树（P2.4b）。
 *
 * 持有三张表（live handles、archived 记录、ID 计数器）
 * 以及完整的子生命周期：spawn/instantiate、turn start/finish、
 * send/revive、kill/suspend/archive、settle waiting、snapshots/status 报告、
 * 以及 staged child restore。
 *
 * 父会话服务（日志追加、消息传递、hooks、进度、子代理工厂）
 * 通过 deps 闭包回调回 Session。
 * 子 Session 构建通过 createChildSession 注入，
 * 使本模块运行时从不导入 Session 类（仅 import type——打破导入循环）。
 *
 * 访问子会话私有成员（inbox、delivery、事件记录、日志正规化）
 * 的闭包定义在 Session 内部——同类私有访问合法。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Agent } from "../agents/agent.js";
import type { PendingAskUi } from "../ask.js";
import type { HookEvent, HookPayload } from "../hooks/index.js";
import { createAgentResult, type LogEntry } from "../context/log-entry.js";
import { describeModel } from "../models/presentation.js";
import { loadLog, validateAndRepairLog, type LoadLogResult } from "../config/persistence.js";
import type { ProgressLevel, ProgressReporter } from "../lib/progress.js";
import { ToolResult } from "../providers/base.js";
import type { Session } from "../session.js";
import {
  migrateMessageEnvelope,
  type ArchivedChildRecord,
  type ChildSessionLifecycle,
  type ChildSessionMetaRecord,
  type ChildSessionMode,
  type ChildSessionOutcome,
  type ChildSessionPhase,
  type ChildSessionSnapshot,
  type MessageEnvelope,
} from "../session-tree-types.js";
import { SEND_TOOL } from "../tools/comm.js";

/** 子代理输出截断限制（12000 字符）。 */
const SUB_AGENT_OUTPUT_LIMIT = 12_000;

/** 人类可读的 Token 数量格式化。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** 从子会话日志提取最新的非丢弃助手文本（或 no_reply）。 */
export function extractLatestAssistantText(entries: readonly LogEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.discarded) continue;
    if (entry.type === "assistant_text" || entry.type === "no_reply") {
      return String(entry.content ?? entry.display ?? "");
    }
  }
  return "";
}

// ------------------------------------------------------------------
// ChildSessionHandle —— 追踪嵌套子会话状态的接口
// ------------------------------------------------------------------

export interface ChildSessionHandle {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  status: "working" | "idle" | "error" | "interrupted" | "terminated" | "completed";
  phase: ChildSessionPhase;
  /**
   * settled one-shot 子会话后为 null：其日志在磁盘（按需读回），
   * frozenSnapshot 服务于 Agents 面板。persistent 子会话保留 Session 以便复活。
   */
  session: Session | null;
  /** release 时捕获的最终快照（见 _freezeAndRelease）。 */
  frozenSnapshot?: ChildSessionSnapshot | null;
  sessionDir: string;
  artifactsDir: string;
  resultText: string;
  elapsed: number;
  startTime: number;
  turnPromise: Promise<string> | null;
  abortController: AbortController | null;
  recentEvents: string[];
  lifetimeToolCallCount: number;
  lastToolCallSummary: string;
  lastTotalTokens: number;
  lastOutcome: ChildSessionOutcome;
  lastActivityAt: number;
  order: number;
  /** suspendAll / archiveAll 设置，防止僵尸 finishChildTurn 回调。 */
  suspended: boolean;
  /** settlePromise：finishChildTurn 完成时 resolve。在 _startChildTurn 创建，finishChildTurn 中 resolve。 */
  settlePromise: Promise<void> | null;
  settleResolve: (() => void) | null;
  terminationCause?: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt";
}

export interface PreparedChildRestore {
  record: ChildSessionMetaRecord;
  agent: Agent;
  sessionDir: string;
  artifactsDir: string;
  loaded: LoadLogResult;
}

/** Session 暴露给子会话实例化的构造函数表面。 */
export interface ChildSessionSpawnOpts {
  primaryAgent: Agent;
  artifactsDir: string;
  promptCacheKey: string;
  onTurnOutput: (text: string) => void;
  onSaveRequest: () => void;
}

export interface ChildSessionManagerDeps {
  // 父日志 & 记账
  appendEntry(entry: LogEntry, notify?: boolean): void;
  nextLogId(type: LogEntry["type"]): string;
  allocateContextId(): string;
  getTurnCount(): number;
  notifyLogListeners(): void;
  requestSave(): void;
  /** 标准传递到父 inbox（root._deliverMessage）。 */
  deliverMessageToParent(msg: MessageEnvelope): void;
  // 子会话私有访问（闭包在 Session 内部——同类私有访问）
  deliverToChild(child: Session, msg: MessageEnvelope): void;
  childHasInbox(child: Session): boolean;
  setChildInbox(child: Session, msgs: MessageEnvelope[]): void;
  recordChildEvent(child: Session, event: string): void;
  normalizeChildInterruptedTurn(child: Session, message: string): void;
  /** 持久化子会话日志+meta。路由经 Session._saveChildSession。返回保存是否成功——决定释放逻辑。 */
  saveChildSession(handle: ChildSessionHandle): boolean;
  // 父环境
  getProgress(): ProgressReporter | undefined;
  fireHook(event: HookEvent, payload: HookPayload): void;
  resolveSessionArtifacts(): string;
  getArtifactsDir(): string;
  getPreferredThinkingLevel(): string;
  getPrimaryAgent(): Agent;
  getAgentTemplates(): Record<string, Agent>;
  // 子代理工厂
  createFromPredefined(templateName: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string };
  createFromPath(templateDir: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string };
  resolveTemplatePath(relPath: string): string;
  buildSubAgentSystemPrompt(basePrompt: string, persistent: boolean): string;
  /** 构造子 Session（打破 Session-Manager 导入循环）。 */
  createChildSession(opts: ChildSessionSpawnOpts): Session;
}

export class ChildSessionManager {
  private _handles = new Map<string, ChildSessionHandle>();
  private _archived = new Map<string, ArchivedChildRecord>();
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
    // 子 id（worker-1、explorer 等）跨会话重用——/new 或 /resume 时缓存若存活会提供前一会话的日志。
    this._releasedLogCache = null;
  }

  // ==================================================================
  // Snapshots & status 报告
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
        pendingAskId: null,
        pendingAskKind: null,
        activeLogEntryId: null,
        turnElapsed: handle.elapsed,
        cacheReadTokens: 0,
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
      outcome,
      running: currentTurnRunning,
      lifetimeToolCallCount: session.lifetimeToolCallCount,
      lastTotalTokens: session.lastTotalTokens,
      lastToolCallSummary: session.lastToolCallSummary,
      recentEvents: [...session.recentSessionEvents],
      pendingInboxCount: session.pendingInboxCount,
      lastActivityAt: handle.lastActivityAt,
      inputTokens: session.lastTotalTokens,
      contextBudget: session.contextBudget,
      modelConfigName: modelConfig?.name ?? "",
      modelProvider: modelConfig?.provider ?? "",
      modelDisplayLabel: modelDescriptor?.scopedLabel ?? modelConfig?.model ?? "",
      pendingAskId: pendingAsk?.id ?? null,
      pendingAskKind: pendingAsk?.kind ?? null,
      activeLogEntryId: session.activeLogEntryId,
      turnElapsed: handle.startTime > 0 && currentTurnRunning
        ? (performance.now() - handle.startTime) / 1000
        : handle.elapsed,
      cacheReadTokens: session.lastCacheReadTokens,
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
      promptCacheKey: taskId,
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
    const abortController = new AbortController();
    handle.abortController = abortController;
    // 创建 settle promise 以便 close() 等待本 turn 结束
    handle.settlePromise = new Promise<void>((resolve) => {
      handle.settleResolve = resolve;
    });
    handle.turnPromise = session.turn(input, { signal: abortController.signal, skipUserInput: options?.skipUserInput });
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

    // Fire SubagentStop hook
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

    // 生命周期转换：oneshot → archived，persistent → idle
    let savedOk = false;
    if (handle.mode === "oneshot") {
      handle.lifecycle = "archived";
      savedOk = this.deps.saveChildSession(handle);
    } else {
      handle.lifecycle = "idle";
      this.deps.saveChildSession(handle);
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

    if (!text) {
      return { content: `${header}\n(no output)` };
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
          truncated,
        fullOutputPath: relativePath,
      };
    }

    return { content: `${header}\n${text}` };
  }

  /** 将 handle 从 live 表移到 archived 表，释放 Session 实例。 */
  private _archiveHandle(handle: ChildSessionHandle): void {
    this._archived.set(handle.id, {
      id: handle.id,
      numericId: handle.numericId,
      template: handle.template,
      mode: handle.mode,
      outcome: handle.lastOutcome,
      order: handle.order,
      sessionDir: handle.sessionDir,
      artifactsDir: handle.artifactsDir,
    });
    this._handles.delete(handle.id);
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
      handle.lastActivityAt = Date.now();
      this.deps.saveChildSession(handle);
    }
    for (const [, handle] of this._handles) {
      this._archived.set(handle.id, {
        id: handle.id,
        numericId: handle.numericId,
        template: handle.template,
        mode: handle.mode,
        outcome: handle.lastOutcome,
        order: handle.order,
        sessionDir: handle.sessionDir,
        artifactsDir: handle.artifactsDir,
      });
    }
    this._handles.clear();
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
      const modelLevel = typeof spec["model_level"] === "string" ? spec["model_level"].trim() : undefined;

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
          ({ agent, thinkingLevel: tierThinkingLevel } = this.deps.createFromPredefined(templateName, taskId, modelLevel));
          templateLabel = templateName;
        } else {
          const resolvedPath = this.deps.resolveTemplatePath(templatePath);
          ({ agent, thinkingLevel: tierThinkingLevel } = this.deps.createFromPath(resolvedPath, taskId, modelLevel));
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
        return `  #${info.numericId} ${info.taskId} [${info.template}] — ${taskTrunc}`;
      });
      previewText = `Spawned ${spawnedInfo.length} sub-agent(s):\n${lines.join("\n")}`;
    }

    return new ToolResult({
      content: parts.join("\n") || "No agents spawned.",
      metadata: previewText ? { tui_preview: { text: previewText, dim: true } } : undefined,
    });
  }

  /** kill_agent tool 实现。 */
  killAgents(ids: string[]): ToolResult {
    const killed: string[] = [];
    const notFound: string[] = [];
    const alreadyArchived: string[] = [];

    for (const name of ids) {
      const handle = this._handles.get(name);
      if (!handle) {
        if (this._archived.has(name)) {
          alreadyArchived.push(name);
        } else {
          notFound.push(name);
        }
        continue;
      }

      handle.abortController?.abort();
      handle.lifecycle = "archived";
      handle.status = "terminated";
      handle.lastOutcome = "interrupted";
      handle.lastActivityAt = Date.now();
      if (handle.session) {
        this.deps.recordChildEvent(handle.session, "terminated by parent");
      }
      // released handle 面板状态来自 frozen snapshot——在快照中镜像 kill 状态，否则会持续显示已结束状态。
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
      killed.push(name);

      const progress = this.deps.getProgress();
      if (progress) {
        progress.emit({
          step: this.deps.getTurnCount(),
          agent: name,
          action: "agent_killed",
          message: `  [#${handle.numericId} ${name}] archived`,
          level: "normal" as ProgressLevel,
          timestamp: Date.now() / 1000,
          usage: {},
          extra: { sub_agent_id: handle.numericId },
        });
      }
    }

    const parts: string[] = [];
    if (killed.length) parts.push(`Killed: ${killed.join(", ")}.`);
    if (alreadyArchived.length) parts.push(`Already archived: ${alreadyArchived.join(", ")}.`);
    if (notFound.length) parts.push(`Not found: ${notFound.join(", ")}.`);
    return new ToolResult({ content: parts.join(" ") });
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

    return this.sendMessageToChild(to, { type: "user_input", sender: "main", content, timestamp: Date.now() });
  }

  /** 复活 archived persistent 子会话：重建 Session、恢复日志、启动 turn。 */
  private async _reviveArchivedChild(record: ArchivedChildRecord, messageContent: string): Promise<void> {
    let agent: Agent;
    if (this.deps.getAgentTemplates()[record.template]) {
      ({ agent } = this.deps.createFromPredefined(record.template, record.id));
    } else {
      ({ agent } = this.deps.createFromPath(this.deps.resolveTemplatePath(record.template), record.id));
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
    const loaded = loadLog(record.sessionDir);
    const repaired = validateAndRepairLog(loaded.entries);
    session.restoreFromLog(loaded.meta, repaired.entries, loaded.idAllocator);
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
      sender: "main",
      content: messageContent,
      timestamp: Date.now(),
      wake: false,
    });
    this._startChildTurn(handle, "", { skipUserInput: true });

    // 触发根会话保存（因子会话引用已变更）
    this.deps.requestSave();
  }

  // ==================================================================
  // Staged child restore
  // ==================================================================

  /** 准备子会话恢复：加载日志、验证、修复。 */
  prepareChildRestores(
    childSessions: ChildSessionMetaRecord[],
    warnings: string[],
  ): PreparedChildRestore[] {
    if (childSessions.length === 0) return [];

    const prepared: PreparedChildRestore[] = [];
    const ordered = [...childSessions].sort((a, b) => (a.order ?? a.numericId) - (b.order ?? b.numericId));
    for (const record of ordered) {
      let agent: Agent;
      try {
        if (this.deps.getAgentTemplates()[record.template]) {
          ({ agent } = this.deps.createFromPredefined(record.template, record.id));
        } else {
          ({ agent } = this.deps.createFromPath(this.deps.resolveTemplatePath(record.template), record.id));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to prepare child session '${record.id}': ${reason}`);
        continue;
      }

      const sessionDir = this.childSessionDir(record.id);
      const artifactsDir = join(sessionDir, "artifacts");

      try {
        const loaded = loadLog(sessionDir);
        const repaired = validateAndRepairLog(loaded.entries);
        if (repaired.repaired) {
          for (const warning of repaired.warnings) {
            warnings.push(`[repair:${record.id}] ${warning}`);
          }
        }
        prepared.push({
          record,
          agent,
          sessionDir,
          artifactsDir,
          loaded: {
            ...loaded,
            entries: repaired.entries,
          },
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to load child session '${record.id}': ${reason}`);
      }
    }
    return prepared;
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
        handle.lifecycle = record.lifecycle;
        handle.lastOutcome = record.outcome ?? "none";
        handle.lastActivityAt = Date.now();
        handle.resultText = extractLatestAssistantText(session.log);
        handle.status =
          record.lifecycle === "archived"
            ? "terminated"
            : "idle";

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
        this._freezeAndRelease(handle, true);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to restore child session '${record.id}': ${reason}`);
      }
    }

    return warnings;
  }
}
