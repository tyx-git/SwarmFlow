/**
 * 多轮对话会话与上下文管理。
 *
 * 提供 Session 类——核心运行时编排器。
 * 管理主 Agent 的对话、
 * 自动压缩和子代理生命周期。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getLogger, initLogger } from "./logging/logger.js";

import { assembleSystemPrompt } from "./prompts/templates.js";

import { Agent } from "./agents/agent.js";
import type { ToolLoopResult, ToolPreflightContext, ToolPreflightDecision, ResolveToolCallVisibilityCallback } from "./agents/tool-loop/types.js";
import type { ToolExecutor } from "./tools/executor-types.js";
import type { SessionLike } from "./session/contract.js";
import { allocateContextId, stripContextTags } from "./context/context-tags.js";

import type { Config } from "./config/loader.js";
import type { ModelConfig } from "./config/types.js";
import type { MCPClientManager, McpServerStatus } from "./clients/mcp/manager.js";
import { type ProgressReporter } from "./logging/progress.js";
import { ToolResult } from "./providers/response.js";
import type { FileMutation } from "./tools/mutations.js";
import type { RewindPlan, RewindApplyResult } from "./ui/contracts.js";
import { RewindEngine } from "./session/rewind/engine.js";
import type { RewindTargetTurn } from "./session/rewind/types.js";
import { ChildSessionManager } from "./session/children/manager.js";
import type { ChildSessionHandle, PreparedChildRestore } from "./session/children/types.js";
import {
  completeMissingToolResultsInLog,
  normalizeInterruptedTurnInLog,
  type LogSurgery,
  type RestoredSessionState,
} from "./session/log-surgery.js";
import { SessionLog, type TurnListing } from "./session/log.js";
import { ContextManager } from "./session/context-manager.js";
import { SubAgentFactory } from "./session/subagent-factory.js";
import {
  type SubagentSettings,
} from "./session/subagent-settings.js";
import { resolveRoleModel as resolveRoleModelConfig, type PersistedRoleModelSelection } from "./session/role-model-resolver.js";

import { type SkillMeta } from "./skills/loader.js";
import { toolBuiltinWebSearchPassthrough } from "./tools/web-search/tool.js";

import { TaskStore } from "./tasks/store.js";
import { formatTaskSnapshot } from "./tasks/snapshot.js";

import type { Task } from "./tasks/types.js";
import {
  type ChildOutcome,
  type TerminationCause,
} from "./tasks/reconcile.js";
import {
  buildToolExecutors,
  ensureCommTools,
  ToolGate,
} from "./tools/runtime.js";
import { BackgroundShellManager } from "./session/background-shell/manager.js";
import type { BackgroundShellDetail, BackgroundShellSnapshot } from "./session/background-shell/types.js";
import { PermissionAdvisor, PermissionRuleStore, initBashParser, type PermissionMode } from "./permissions/index.js";
import { HookRuntime } from "./hooks/index.js";
import type { HookManifest } from "./hooks/types.js";
import {
  assembleFullSystemPrompt,
} from "./prompts/assembler.js";
import { getSwarmflowHomeDir } from "./config/home-dir.js";
import { shell } from "./platform/index.js";

import { buildShellNotes } from "./tools/shell-notes.js";
import {
  argOptionalString,
  argOptionalPath,
  argRequiredString,
  argRequiredStringArray,
} from "./tools/arg-validation.js";
import {
  ASK_DISCUSS_FURTHER_GUIDANCE,
  isAskPendingError,
  type AgentQuestionItem,
  type AgentQuestionDecision,
  type AskAuditRecord,
  type AskRequest,
  type PendingAskUi,
  type PendingTurnState,
} from "./ask.js";
import { LogIdAllocator } from "./context/entry/id-allocator.js";
import type { LogEntry } from "./context/entry/types.js";
import { createSystemPrompt, createStatus, createCommandEcho, createError as createErrorEntry } from "./context/entry/factories.js";

import {
  loadArchiveFile,
  loadArchiveMutationIndexes,
  loadArchiveMutationIndexesAsync,
  loadArchiveTurnIndexes,
  loadArchiveTurnIndexesAsync,
  loadArchivedDisplaysForEntries,
  loadArchivedDisplaysForEntriesAsync,
  loadArchivedMetaForTurns,
  loadArchivedMetaForTurnsAsync,
  loadPresentationCapableEntryIds,
  stripEntryForPersistence,
  type ArchivedMutationInfo,
  type ArchivedTurnInfo,
} from "./config/archive.js";
import {
  SEALED_INLINE_BUDGET_BYTES,
  isSealedRef,
  maybeExternalizeReasoning,
  pruneSealed,
  readSealed,
} from "./config/log-sealed.js";
import { inferThinkingArtifact, normalizeThinkingArtifact } from "./thinking/artifact.js";
import { type GlobalTuiPreferences } from "./config/settings/legacy-preferences.js";
import { type LogSessionMeta } from "./config/session-meta.js";
import { saveSessionSidecars } from "./config/log-serialization.js";
import {
  LOG_JSONL_FILENAME,
  LOG_JSONL_VERSION,
  appendRecords,
  loadLogJsonl,
  migrateLogToJsonl,
  readLastSeq,
  recordHasCompactMarker,
  writeLogJsonlSnapshot,
} from "./config/log-jsonl.js";
import {
  HISTORY_PAGE_CACHE_BYTES,
  estimateEntriesBytes,
  openTuiHistoryPager,
  type TuiHistoryPager,
} from "./config/log-history.js";
import {
  TURN_INDEX_VERSION,
  appendTurnIndex,
  buildTurnIndex,
  deleteTurnIndex,
  readTurnIndex,
  writeTurnIndex,
  type TurnIndexData,
  type TurnIndexMutation,
  type TurnIndexOp,
} from "./session/turn-index.js";
import { capPersistedEntry, shouldPersistEntry } from "./config/log-write-policy.js";

import type { SwarmflowSettings } from "./config/settings/types.js";

interface TurnMutationAggregate {
  livePaths: Set<string>;
  revertedPaths: Set<string>;
  additions: number;
  deletions: number;
}

/** 无历史分页的短会话在 turn_end 时自建索引；长日志仍等首次菜单读取重建。 */
const TURN_INDEX_AUTOCREATE_MAX_ENTRIES = 5000;
const HISTORY_PAGE_DEFAULT_ENTRIES = 200;

function normalizeHistoryPageSize(value: number): number {
  if (!Number.isFinite(value)) return HISTORY_PAGE_DEFAULT_ENTRIES;
  return Math.max(1, Math.floor(value));
}
import {
  CHILD_SESSION_CAPABILITIES,
  ROOT_SESSION_CAPABILITIES,
  type SessionCapabilities,
} from "./session/capabilities.js";
import {
  type ArchivedChildRecord,
  type ChildSessionMode,
  type ChildSessionPhase,
  type ChildSessionSnapshot,
  type ChildTaskHandoff,
  type DeliverMessageResult,
  type MessageEnvelope,
} from "./session/tree-types.js";
import {
  type PersistedModelSelection,
} from "./models/selection.js";
import { describeModel } from "./models/presentation.js";
import {
  type ContextThresholds,
} from "./config/compact-thresholds.js";
import { encode as gptEncode } from "gpt-tokenizer/model/gpt-5";
import {
  type DrainPendingToolCallsResult,
  type InlineImageInput,
  type TurnLifecycleEvent,
  type TurnLifecycleStatus,
} from "./session/turn-types.js";

import {
  aggregateTokenUsage,
  tokenUpdateContribution,
  estimatePromptSections,
  scalePromptBreakdown,
  type ContextBreakdown,
  type PromptSectionEstimates,
  type UsageStats,
} from "./session/usage-accounting.js";
import { estimateEntryTokens } from "./context/token-estimate.js";
import {
  ensureSkillToolForSession,
  execSkill,
  getAllSkillNames,
  getDisabledSkills,
  getSkills,
  refreshSkills,
  reloadSkills,
  setSkillEnabled,
  skillsDirty,
} from "./session/skills.js";
import {
  ensureMcp,
  ensureMcpReady,
  ensureMcpReadyFromCommand,
  getMcpManager,
  queueToolAvailabilityNotice,
  reconnectMcpServer,
  reconnectMcpServerFromCommand,
  reloadMcp,
  reloadMcpFromCommand,
  snapshotMcpAvailability,
} from "./session/mcp.js";
import type { McpAvailabilitySnapshot, ToolAvailabilityNotice } from "./session/mcp.js";
import {
  applyGlobalPreferences,
  applySettings,
  getGlobalPreferences,
  getSubagentSettings,
  reloadCurrentModelConfig,
  setSubagentSettings,
  switchModel,
} from "./session/model-settings.js";
import {
  commitPreparedRestore,
  getLogForPersistence,
  prepareRestoreFromLog,
  restoreFromLog,
  type PreparedSessionRestore,
} from "./session/restore.js";
import {
  autoResumeFromIdle,
  beginActiveInput,
  clearCompletedTasksBeforeUserInput,
  deliverInboxMessage,
  deliverMessage,
  drainInboxAsEntries,
  getQueuedUserInputs,
  hasInboxMessages,
  hasUnprocessedUserMessage,
  hasWakingInboxMessages,
  maxLiveInputIndex,
  restoreQueuedUserInput,
  scheduleAutoResume,
} from "./session/inbox.js";
import {
  activeWindowStartIdx,
  appendDeliveredUserMessage,
  appendInterruptionSystemMessage,
  beginWorkIfNeeded,
  computeNextRoundIndex,
  findRoundContextId,
  findToolCallEntry,
  findToolCallContextId,
  finishCurrentWork,
  maybeRunIdleGc,
  recordInputReceived,
  resolveOutputRoundContextId,
  retagRoundEntries,
  toolCallAnchor,
} from "./session/round-tracking.js";
import {
  denyAndInterruptPendingAsk,
  denyPendingAsk,
  emitAskRequestedProgress,
  emitAskResolvedProgress,
  execAsk,
  findChildWithPendingAsk,
  getPendingAsk,
  hasPendingTurnToResume,
  notifyAskChanged,
  resolveAgentQuestionAsk,
  resolveApprovalAsk,
  resolveOwnAgentQuestionAsk,
  resolveOwnApprovalAsk,
  resumeChildPendingTurn,
  subscribeAsk,
  withAskRouting,
} from "./session/ask-flow.js";
import {
  buildCompactCheck,
  discardCompactAttemptEntries,
  doAutoCompact,
  getManualCompactBlocker,
  isCommittedCompactError,
  runCompactPhase,
  runManualCompact,
  runManualCompactBody,
  type CompactCommitResult,
  type CompactOrigin,
} from "./session/compact-flow.js";
import {
  beforeToolExecute,
  drainPendingToolCalls,
  finalizeDrainInterruptedWork,
  findEarliestPendingToolCallLogIndex,
  findNextPendingToolCall,
  isInsideArtifactsDir,
  updateToolCallExecState,
} from "./session/tool-drain.js";
import { runActivation, runTurnActivationLoop } from "./session/activation.js";
import {
  closeSession,
  collectInterruptHints,
  handleInterruption,
  isTurnAbortError,
  recordTurnErrorEntry,
  recordTurnFailure,
  requestTurnInterrupt,
  waitForTurnComplete,
  withTurnLock,
} from "./session/turn-control.js";
import {
  argTaskMetadata,
  ensureTaskStore,
  execTaskCreate,
  execTaskGet,
  execTaskList,
  execTaskResume,
  execTaskUpdate,
  ensureTaskToolsForSession,
  getTaskPersistence,
  getTaskState,
  indexChildOutcomesFromLog,
  notifyTaskListeners,
  onChildSettled,
  reconcileTaskListAfterRestore,
  resumeChildSession,
  resumeRefusalText,
  subscribeTaskState,
} from "./session/task-list.js";
import {
  extractAndSaveImages,
  processAttachments,
  resolveImageRef,
} from "./session/attachments.js";

export type { InlineImageInput, TurnLifecycleEvent, TurnLifecycleStatus } from "./session/turn-types.js";
// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------

const SYSTEM_PREFIXES = [
  "[AUTO-COMPACT]",
  "[Context After Auto-Compact]",
  "[MASTER PLAN:",
  "[PHASE PLAN:",
  "[SUB-AGENT UPDATE]",
  "[SESSION INTERRUPTED]",
  "[SKILL:",
];


// ------------------------------------------------------------------
// MessageEnvelope：带类型的消息信封（见 session/tree-types.ts）
// ------------------------------------------------------------------


// ChildSessionHandle / PreparedChildRestore 已迁移至 ./session/children/types.ts
// BackgroundShellEntry 已迁移至 ./session/background-shell/types.ts



// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------


export class Session implements SessionLike {
  primaryAgent: Agent;
  config: Config;
  agentTemplates: Record<string, Agent>;
  private _promptsDirs?: string[];

  _progress?: ProgressReporter;
  _mcpManager?: MCPClientManager;
  _mcpConnected = false;
  _mcpReadyPromise?: Promise<void>;

  /** 工具权限闸门：添加 advisor 以控制工具执行。 */
  readonly toolGate = new ToolGate();

  /** 权限 advisor：对工具分类并执行权限模式。 */
  _permissionAdvisor!: PermissionAdvisor;
  private _permissionRuleStore!: PermissionRuleStore;

  /** Hook 运行时：触发事件并执行 hook 命令。 */
  readonly hookRuntime = new HookRuntime();

  _createdAt: string;
  /** 会话创建时的模型身份快照；跨恢复与 /model 切换保持稳定。 */
  _initialModel: string;
  _title: string | undefined;
  private _cachedSummary: string | undefined;

  // 结构化日志：条目、revision、监听器与 ID 分配都在 SessionLog
  // (src/session/log.ts)；下面的访问器让 Session 内部大量
  // `_log` / `_idAllocator` 调用点无需改动。
  /** M0：本次保存要按磁盘视图剥离 presentation 的条目 id。 */
  private _persistenceStripIds = new Set<string>();
  private _presentationArchiveIds: Set<string> | undefined;
  private _presentationArchiveCount = -1;
  private _needsPersistenceNormalization = false;
  private _persistenceDirty = false;
  private _persistenceFailure: string | null = null;
  private _turnIndexDirty = false;
  /** M1：reasoningState 解压缓存（4 MiB LRU）。 */
  private _sealedStateCache = new Map<string, { value: unknown; bytes: number }>();
  private _sealedStateCacheBytes = 0;

  _logStore = new SessionLog({
    shouldPersist: (entry) => shouldPersistEntry(entry),
    prepareForPersistence: (entry) => {
      const dir = this._resolvePersistDir();
      return dir ? capPersistedEntry(entry, { sessionDir: dir }) : entry;
    },
  });

  get _log(): LogEntry[] {
    return this._logStore.entries;
  }

  private set _log(entries: LogEntry[]) {
    this._logStore.replace(entries);
  }

  private get _idAllocator(): LogIdAllocator {
    return this._logStore.idAllocator;
  }

  private set _idAllocator(alloc: LogIdAllocator) {
    this._logStore.idAllocator = alloc;
  }

  // Token 统计（按响应快照）
  _lastInputTokens = 0;
  _lastTotalTokens = 0;
  _lastCacheReadTokens = 0;
  _cacheSupported = false;

  // 累计用量（总输入/输出/缓存/未缓存 + system prompt）由日志中的
  // token_update 条目推导，而非实时累加：token_update 跨恢复保留，
  // 压缩后也不会丢（不含 contextId/content，无需剥离），因此日志是
  // 唯一事实来源，实时值与恢复值不会漂移。按日志长度记忆化，
  // 避免用量面板反复渲染时重复扫描日志。
  private _usageStatsCache: { logLen: number; baseVersion: number; stats: UsageStats } | null = null;
  /** 有界恢复的累计基线；null=从内存日志重算。 */
  private _usageBase: { input: number; output: number; cacheRead: number } | null = null;
  private _usageBaseIds = new Set<string>();
  private _usageBaseVersion = 0;
  private _usageFirstInput = 0;
  private _usageFirstUserMessageTokens = 0;

  // system prompt 各段的 gptEncode 估算值；仅在提示词重组时失效
  // （_reloadPromptAndTools / _resetTransientState）。
  private _promptSectionEstimates: { systemPrompt: number; tools: number; agentsMd: number; skills: number } | null = null;
  private _contextEstimateCache: { revision: number; tokens: number } | null = null;

  // 压缩阶段
  _compactInProgress = false;
  _compactTerminatedThisTurn = false;

  // 上下文压力状态（阈值与预算百分比）由 ContextManager 持有。
  _contextManager!: ContextManager;

  private get _thresholds(): ContextThresholds {
    return this._contextManager.thresholds;
  }

  // 技能
  _skills = new Map<string, SkillMeta>();
  _skillRoots: string[] = [];
  _disabledSkills = new Set<string>();
  /**
   * skill 变更只标记脏位，不立即重建工具/system。
   * 只有显式 /reload（或进程重启）才允许改变缓存前缀。
   */
  _skillsDirty = false;

  /** 全局记忆 ~/.swarmflow/MEMORY.md 所在目录。 */
  private readonly _swarmflowHomeDir: string;

  // 缓存的 system prompt（重载之间保持不变，以稳定 prompt cache）
  private _cachedSystemPrompt: string | null = null;

  // 产物与持久化
  _store: any;

  // Path resolution（仅供运行时使用，不进入 system prompt）
  _projectRoot: string;
  _sessionArtifactsOverride: string;
  private _shellLogDirOverride: string;

  // Task list state ({SESSION_ARTIFACTS}/tasks.json 为权威；子会话纯内存)
  _taskStoreScope: "session" | "memory" = "session";
  _taskStoreRef: TaskStore | undefined;
  /** 已绑定的 tasks.json 路径：变化时重建 store（/new、会话恢复、/fork 会切换目录）。 */
  _taskStoreKey: string | undefined;
  _taskListeners: (() => void)[] = [];

  // 文件/bash 回退的规划与应用（持有崩溃日志）。
  private _rewindEngine!: RewindEngine;
  /** rewind 计划期间临时装载的归档 meta；结束后还原，不常驻。 */
  private _archivedMetaLookup: Map<string, Record<string, unknown>> | undefined;

  // 为子会话构建 Agent 实例（模板 + 模型解析）。
  // 惰性构造，使基于原型的测试替身首次使用时也能拿到接到自身
  // stub 字段的可用工厂。
  private _subAgentFactory?: SubAgentFactory;

  // 会话树 / 子会话 —— 状态由 ChildSessionManager 持有。
  // 下方同名私有访问器让内部调用点与测试保持稳定。
  private _childSessionManager?: ChildSessionManager;
  _shellManager!: BackgroundShellManager;

  // 会话能力与路由
  _capabilities: SessionCapabilities = ROOT_SESSION_CAPABILITIES;
  private _turnOutputTarget?: (text: string) => void;
  private _selfPhase: ChildSessionPhase = "idle";
  _lifetimeToolCallCount = 0;
  _lastToolCallSummary = "";
  private _recentSessionEvents: string[] = [];

  // 活动条目跟踪器：标记当前处于「活跃」状态的日志条目
  _activeLogEntryId: string | null = null;

  /** 更新活动条目跟踪器；同时把前一个 reasoning 隐式标记为完成。 */
  _setActiveLogEntry(entryId: string | null): void {
    if (this._activeLogEntryId === entryId) return;
    // 前一个活动条目是 reasoning 条目时，标记其完成
    if (this._activeLogEntryId) {
      const prevEntry = this._log.find((e) => e.id === this._activeLogEntryId);
      if (prevEntry && prevEntry.type === "reasoning") {
        (prevEntry.meta as Record<string, unknown>).reasoningComplete = true;
      }
    }
    this._activeLogEntryId = entryId;
    this._touchLog();
  }
  _lastTurnEndStatus: "completed" | "interrupted" | "error" | null = null;

  // 思考等级与主题色
  _persistedModelSelection: PersistedModelSelection = {};
  _preferredThinkingLevel = "";
  _preferredAccentColor?: string;
  _thinkingLevel = "none";

  /** OpenAI prompt cache 路由亲和性所用的稳定 key。 */
  _promptCacheKey: string;

  /** fork 默认路由策略；可被 session.fork 的显式参数覆盖。 */
  readonly forkInheritPromptCacheKey: boolean;

  // Agent 运行时状态（用于选择消息投递方式）
  _agentState: "working" | "idle" | "waiting" = "idle";

  // 收件箱：保存以推送方式注入工具结果的消息。
  // 带类型的消息收件箱 —— 所有消息统一经 _deliverMessage 投递。
  _inbox: MessageEnvelope[] = [];
  // 真实用户消息驱动过一次激活（或从恢复的日志载入）后为 true。
  // 用于门控工具可用性通知：首条用户消息之前的 skill/MCP 变更不会
  // 排队随行通知。在 _beginActiveInput 中翻转；恢复时由
  // _applyRestoredState 写入。
  _conversationStarted = false;
  _currentTurnSignal: AbortSignal | null = null;
  _currentTurnAbortController: AbortController | null = null;

  // 回合串行化 —— 防止并发 turn() 调用破坏状态
  _turnInFlight: Promise<string | void> | null = null;

  /**
   * SessionStart hooks 延迟到首个 turn 前执行一次。
   *
   * 在构造函数里同步等待会阻塞进程启动；fire-and-forget 又会让首轮请求
   * 看不到 hook 返回的上下文。延迟到首个 turn 前等待，两个问题都避开。
   */
  private _sessionStartHooksPromise: Promise<void> | null = null;

  /** 增量持久化回调 —— 返回日志是否已同步落盘。 */
  onSaveRequest?: () => boolean;
  /** MCP 连接状态回调 —— 首次连接或重载后调用。 */
  onMcpStatus?: (statuses: McpServerStatus[]) => void;

  // 计数器
  _turnCount = 0;
  private _workCount = 0;
  private _currentWorkId: string | null = null;
  private _currentWorkStartedAt = 0;
  _compactCount = 0;
  /** 本 turn 已提交的自动压缩次数；手动 /compact 不占配额。 */
  _autoCompactCountThisTurn = 0;
  private _usedContextIds = new Set<string>();

  // 上次在 idle 执行同步 GC 的时间（ms epoch）。用于限制对外暴露的
  // 可选 GC 调用频率，避免连续的工作边界反复做全堆回收而白烧 CPU。
  _lastIdleGcAt = 0;

  // 工具执行器
  _toolExecutors: Record<string, ToolExecutor>;
  private _toolExecutorOverrides: Record<string, ToolExecutor> = {};

  // Ask 状态。所有读写都经过 `_activeAsk` 访问器对，
  // 使每次状态变更（挂起/解决/恢复/重置）都通知 ask 订阅者 —— 包括将来新增的调用点。
  _activeAskValue: AskRequest | null = null;
  _askHistory: AskAuditRecord[] = [];
  _pendingTurnState: PendingTurnState | null = null;

  get _activeAsk(): AskRequest | null {
    return this._activeAskValue;
  }

  set _activeAsk(value: AskRequest | null) {
    if (this._activeAskValue === value) return;
    this._activeAskValue = value;
    this._notifyAskChanged();
  }

  // Ask 与回合生命周期订阅者（UI + RPC 层）。仅订阅日志观察不到子会话的
  // ask（它们在子会话自己的日志里），因此 ask 状态走独立通道；子会话的
  // ask 通过 createChildSession 的接线冒泡到根会话。
  _askListeners = new Set<() => void>();
  private _turnLifecycleListeners = new Set<(event: TurnLifecycleEvent) => void>();

  /**
   * 订阅 pending-ask 变化（自身的 ask 与子会话的 ask）。
   * 监听器不接收参数；如需当前状态请调用 `getPendingAsk()`。
   */
  /**
   * 订阅 pending-ask 变化（自身的 ask 与子会话的 ask）。
   * 监听器不接收参数；如需当前状态请调用 `getPendingAsk()`。
   */
  subscribeAsk(listener: () => void): () => void {
    return subscribeAsk(this, listener);
  }

  /**
   * 订阅回合生命周期事件。每次 activation-loop 运行都会触发，包括不经过
   * 外部入口的自动续跑与审批后恢复回合。`status: "waiting"` 表示回合停在
   * 某个 pending ask 上，尚未完成。
   */
  subscribeTurnLifecycle(listener: (event: TurnLifecycleEvent) => void): () => void {
    this._turnLifecycleListeners.add(listener);
    return () => {
      this._turnLifecycleListeners.delete(listener);
    };
  }

  _notifyAskChanged(): void {
    notifyAskChanged(this);
  }

  _emitTurnLifecycle(event: TurnLifecycleEvent): void {
    if (!this._turnLifecycleListeners) return;
    for (const listener of this._turnLifecycleListeners) {
      try {
        listener(event);
      } catch {
        // 订阅者抛错绝不能打断回合循环。
      }
    }
  }

  /** 分配一个唯一的随机十六进制 context ID。 */
  _allocateContextId(): string {
    return allocateContextId(this._usedContextIds);
  }

  _setSelfPhase(phase: ChildSessionPhase): void {
    this._selfPhase = phase;
  }

  _recordSessionEvent(summary: string): void {
    const text = summary.trim();
    if (!text) return;
    this._recentSessionEvents.push(text);
    if (this._recentSessionEvents.length > 5) {
      this._recentSessionEvents.shift();
    }
  }

  get pendingInboxCount(): number {
    return this._inbox.length;
  }

  get sessionPhase(): ChildSessionPhase {
    return this._selfPhase;
  }

  get permissionMode(): PermissionMode {
    return this._permissionAdvisor.sessionMode;
  }

  set permissionMode(mode: PermissionMode) {
    this._permissionAdvisor.sessionMode = mode;
    for (const handle of this._childSessions.values()) {
      if (handle.session) handle.session.permissionMode = mode;
    }
  }

  get permissionRuleStore(): PermissionRuleStore {
    return this._permissionRuleStore;
  }

  get permissionAdvisor(): PermissionAdvisor {
    return this._permissionAdvisor;
  }

  get lifetimeToolCallCount(): number {
    return this._lifetimeToolCallCount;
  }

  get lastToolCallSummary(): string {
    return this._lastToolCallSummary;
  }

  get recentSessionEvents(): readonly string[] {
    return this._recentSessionEvents;
  }

  /** 活动 work_start 数；有界恢复时写入 meta.json，避免 work ID 重号。 */
  get workCount(): number {
    return this._workCount;
  }

  /** 各 ID 前缀已用的最大序号；有界恢复的追加安全依赖它。 */
  get idCounters(): Record<string, number> {
    return this._logStore.idAllocator.snapshotCounters();
  }

  get currentTurnRunning(): boolean {
    return this._turnInFlight !== null;
  }

  /** 命令等待项只能在主会话及其自动续跑完全结束后执行。 */
  canRunDeferredCommand(): boolean {
    return this._turnInFlight === null
      && !this._autoResumeScheduled
      && this._agentState === "idle"
      && !this._compactInProgress
      && !this._activeAsk
      && !this._pendingTurnState
      && !this._hasWakingInboxMessages()
      && !this._hasUnprocessedUserMessage();
  }

  /** 当前输入/回合序号（从 1 开始；随用户输入投递递增）。 */
  get turnCount(): number {
    return this._turnCount;
  }

  /** 会话创建的 ISO 时间戳；跨恢复保持不变。 */
  get createdAt(): string {
    return this._createdAt;
  }

  /** 本会话已执行的压缩次数。 */
  get compactCount(): number {
    return this._compactCount;
  }

  /** 绑定接收流式 UI 事件的进度报告器。 */
  setProgressReporter(reporter: ProgressReporter | undefined): void {
    this._progress = reporter;
  }

  /** 仅当给定报告器仍是当前报告器时才解绑。 */
  clearProgressReporter(reporter: ProgressReporter): void {
    if (this._progress === reporter) {
      this._progress = undefined;
    }
  }

  get lastTurnEndStatus(): "completed" | "interrupted" | "error" | null {
    return this._lastTurnEndStatus;
  }

  /** 子会话树状态 + 生命周期（惰性：基于原型的测试替身
   * 首次使用时也能拿到接到自身 stub 字段的 manager）。 */
  get _childSessionManagerInstance(): ChildSessionManager {
    return this._childSessionManager ??= this._buildChildSessionManager();
  }

  get _childSessions(): Map<string, ChildSessionHandle> {
    return this._childSessionManagerInstance.handles;
  }

  get _archivedChildren(): Map<string, ArchivedChildRecord> {
    return this._childSessionManagerInstance.archived;
  }

  get _subAgentCounter(): number {
    return this._childSessionManagerInstance.counter;
  }

  set _subAgentCounter(value: number) {
    this._childSessionManagerInstance.counter = value;
  }

  getChildSessionSnapshots(): ChildSessionSnapshot[] {
    return this._childSessionManagerInstance.getSnapshots();
  }

  getChildSessionLog(childId: string): readonly LogEntry[] | null {
    return this._childSessionManagerInstance.getChildLog(childId);
  }

  private _buildDetailedChildStatusReport(): string {
    return this._childSessionManagerInstance.buildDetailedStatusReport();
  }

  constructor(opts: {
    primaryAgent: Agent;
    config: Config;
    agentTemplates?: Record<string, Agent>;
    skills?: Map<string, SkillMeta>;
    skillRoots?: string[];
    progress?: ProgressReporter;
    mcpManager?: MCPClientManager;
    /** bootstrap 中 fire-and-forget 的 connectAll() 返回的 Promise；首个回合前等待。 */
    mcpReadyPromise?: Promise<void>;
    promptsDirs?: string[];
    store?: any;
    contextBudgetPercent?: number;
    projectRoot?: string;
    /** SwarmFlow 主目录（全局 MEMORY.md 所在目录）。默认 ~/.swarmflow。 */
    homeDir?: string;
    sessionArtifactsDir?: string;
    /**
     * 后台 shell 日志目录覆盖。子会话由父会话传入项目内路径：
     * `.swarmflow/<root-session-id>/agents/<child-id>/shells`。
     * 根会话省略时使用 `.swarmflow/<session-id>/shells`。
     */
    shellLogDir?: string;
    capabilities?: SessionCapabilities;
    /**
     * 任务清单作用域。`session`（默认）：落 `{SESSION_ARTIFACTS}/tasks.json`；
     * `memory`：纯内存（子会话用 —— 子代理不写持久化文件，清单随子会话消亡）。
     */
    taskStoreScope?: "session" | "memory";
    onTurnOutput?: (text: string) => void;
    toolExecutorOverrides?: Record<string, ToolExecutor>;
    /** OpenAI prompt cache 路由亲和性所用的稳定 key；省略时自动生成。 */
    promptCacheKey?: string;
    /** fork 时默认继承父 prompt cache key（settings.json 控制）；默认 false。 */
    forkInheritPromptCacheKey?: boolean;
    /** 本会话的权限模式。默认 "reversible"。 */
    permissionMode?: PermissionMode;
    /** 子会话共享的规则存储；省略时新建。 */
    permissionRuleStore?: PermissionRuleStore;
    /** 预加载的 hook manifest。每个会话持有自己的 runtime，hook 只是拷贝进来。 */
    hooks?: readonly HookManifest[];
  }) {
    initLogger();
    const log = getLogger("session");
    log.info("Session:construct", {
      agent: opts.primaryAgent?.name ?? "unknown",
      hasMcp: Boolean(opts.mcpManager),
      hasSkills: (opts.skills?.size ?? 0) > 0,
    });
    this.primaryAgent = opts.primaryAgent;
    // 思考深度由用户/供应商控制；off 是安全默认值。
    this._thinkingLevel = "off";
    this.config = opts.config;
    this.agentTemplates = opts.agentTemplates ?? {};
    this._skills = opts.skills ?? new Map();
    this._skillRoots = opts.skillRoots ?? [];
    this._swarmflowHomeDir = opts.homeDir ?? getSwarmflowHomeDir();
    this._progress = opts.progress;
    this._mcpManager = opts.mcpManager;
    this._mcpReadyPromise = opts.mcpReadyPromise;
    this._promptsDirs = opts.promptsDirs;
    this._capabilities = opts.capabilities ?? ROOT_SESSION_CAPABILITIES;
    this._taskStoreScope = opts.taskStoreScope ?? "session";
    this._turnOutputTarget = opts.onTurnOutput;
    this._toolExecutorOverrides = opts.toolExecutorOverrides ?? {};
    this._contextManager = new ContextManager({
      getModelConfig: () => this.primaryAgent.modelConfig,
      getBudgetCalcMode: () =>
        (this.primaryAgent as unknown as { _provider?: { budgetCalcMode?: string } })._provider?.budgetCalcMode,
      isCompactInProgress: () => this._compactInProgress,
      canAutoCompact: () => this._capabilities.includeSpawnTool,
      estimateContextTokens: () => this._estimateContextTokens(),
    });

    // 应用上下文预算百分比。
    if (opts.contextBudgetPercent !== undefined) {
      this._contextManager.setBudgetPercent(opts.contextBudgetPercent);
    }

    // 若传入 store 则挂上（必须在 _initConversation 之前设置）
    if (opts.store) {
      this._store = opts.store;
    }

    // 解析运行时路径（system prompt 不再渲染这些值）
    this._projectRoot = resolve(opts.projectRoot ?? process.cwd());
    this._sessionArtifactsOverride = opts.sessionArtifactsDir ?? "";
    this._shellLogDirOverride = opts.shellLogDir ?? "";
    this._shellManager = new BackgroundShellManager({
      projectRoot: this._projectRoot,
      getSessionArtifactsDir: () => this._resolveSessionArtifacts(),
      getShellLogDir: () => this._resolveShellLogDir(),
      deliverMessage: (msg) => this._deliverMessage(msg),
      // shell 日志统一由 read_file 读取；提示只需知道 await/kill 是否存在。
      hasTools: (name) => this._hasTool(name),
    });
    this._rewindEngine = new RewindEngine({
      getLog: () => this._log,
      projectRoot: this._projectRoot,
      getArtifactsDir: () => this._getArtifactsDirIfAvailable(),
      getArchivedMeta: (entryId) => this._archivedMetaLookup?.get(entryId),
      patchFlags: (ids, flags) => this._logStore.patchFlags(ids, flags),
    });
    this._subAgentFactory = this._buildSubAgentFactory();

    // 权限系统
    this._permissionRuleStore = opts.permissionRuleStore ?? new PermissionRuleStore({
      projectStoreDir: this._store?.projectDir ?? this._projectRoot,
      workspaceRoot: this._projectRoot,
    });
    this._permissionAdvisor = new PermissionAdvisor({
      ruleStore: this._permissionRuleStore,
      sessionMode: opts.permissionMode ?? "reversible",
      projectRoot: this._projectRoot,
      shellKind: shell.kind,
    });
    this.toolGate.addAdvisor(this._permissionAdvisor);

    this._createdAt = new Date().toISOString();
    this._initialModel = this._describeInitialModel();
    this._promptCacheKey = opts.promptCacheKey ?? randomUUID();
    this.forkInheritPromptCacheKey = opts.forkInheritPromptCacheKey === true;
    if (opts.hooks && opts.hooks.length > 0) {
      this.hookRuntime.setHooks([...opts.hooks]);
    }
    this._initConversation();
    this._toolExecutors = this._buildToolExecutors();
    this._ensureCommTools();
    this._ensureTaskTools();
    this._ensureSkillTool();
    this._persistedModelSelection = this._buildPersistedModelSelection();

    // 初始化 tree-sitter bash 解析器（异步、不阻塞）
    initBashParser();
  }

  _buildPersistedModelSelection(
    overrides?: Partial<PersistedModelSelection>,
  ): PersistedModelSelection {
    return {
      modelConfigName: this.currentModelConfigName || undefined,
      modelProvider: this.primaryAgent.modelConfig.provider || undefined,
      modelSelectionKey: this.primaryAgent.modelConfig.model || undefined,
      modelId: this.primaryAgent.modelConfig.model || undefined,
      ...overrides,
    };
  }

  setPersistedModelSelection(selection: Partial<PersistedModelSelection>): void {
    this._persistedModelSelection = this._buildPersistedModelSelection(selection);
  }

  // ==================================================================
  // 初始化辅助
  // ==================================================================

  _initConversation(): void {
    this._createdAt = new Date().toISOString();
    this._initialModel = this._describeInitialModel();
    this._title = undefined;
    this._cachedSummary = undefined;
    this._conversationStarted = false;
    this._log = [];
    this._logStore.resetRevision();
    this._idAllocator = new LogIdAllocator();
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    this._workCount = 0;

    // 组装 system prompt 并缓存，以稳定 prompt cache
    this._reloadPromptAndTools();
    this._appendEntry(
      createSystemPrompt(this._nextLogId("system_prompt"), this._cachedSystemPrompt!),
      false,
    );
    this._notifyLogListeners();
  }

  /**
   * 给定 ModelConfig 的有效上下文长度，按上下文预算百分比缩放。
   */
  _effectiveContextLength(mc: ModelConfig): number {
    return this._contextManager.effectiveContextLength(mc);
  }

  /** 用于压力判定的上下文预算（见 ContextManager.budgetInfo）。 */
  private _contextBudgetInfo(): { budget: number; fullContext: boolean } {
    return this._contextManager.budgetInfo();
  }

  // ==================================================================
  // 消息基础设施
  // ==================================================================

  /**
   * 向结构化日志追加一个 LogEntry。
   * 自动触发保存请求并通知日志监听器。
   */
  _appendEntry(entry: LogEntry, save = true): void {
    this._logStore.append(entry);
    if (save) this.onSaveRequest?.();
  }

  _touchLog(): void {
    this._logStore.touch();
  }

  _bumpLogRevision(): void {
    this._logStore.bumpRevision();
  }

  _notifyLogListeners(): void {
    this._logStore.notifyListeners();
  }

  /** 为给定类型分配下一个日志条目 ID。 */
  _nextLogId(type: LogEntry["type"]): string {
    return this._logStore.nextId(type);
  }

  /** 供共享的 log-surgery 函数（session/log-surgery.ts）使用的 live 会话视图。 */
  _logSurgeryView(): LogSurgery {
    const session = this;
    return {
      get entries() { return session._log; },
      appendEntry: (entry) => this._appendEntry(entry, false),
      nextLogId: (type) => this._nextLogId(type),
      allocateContextId: () => this._allocateContextId(),
      recordEvent: (text) => this._recordSessionEvent(text),
      get turnCount() { return session._turnCount; },
      set turnCount(value) { session._turnCount = value; },
      get workCount() { return session._workCount; },
      set workCount(value) { session._workCount = value; },
      get currentWorkId() { return session._currentWorkId; },
      set currentWorkId(value) { session._currentWorkId = value; },
      get currentWorkStartedAt() { return session._currentWorkStartedAt; },
      set currentWorkStartedAt(value) { session._currentWorkStartedAt = value; },
      get lastTurnEndStatus() { return session._lastTurnEndStatus; },
      set lastTurnEndStatus(value) { session._lastTurnEndStatus = value; },
      get activeLogEntryId() { return session._activeLogEntryId; },
      set activeLogEntryId(value) { session._activeLogEntryId = value; },
    };
  }

  _beginWorkIfNeeded(): string {
    return beginWorkIfNeeded(this);
  }

  _finishCurrentWork(
    status: "completed" | "interrupted" | "error",
    interruptHints?: string[],
  ): void {
    finishCurrentWork(this, status, interruptHints);
  }

  /**
   * 在工作边界按需执行同步 GC，抑制长会话中的锯齿状堆增长。
   * 限流为每 10 秒最多一次，避免快速中断/重启循环堆积 GC 停顿；
   * 且仅在 "completed" 状态下执行 —— 被中断或报错的路径之后可能
   * 立刻重启，此时停顿对用户更明显。
   */
  /**
   * 在工作边界按需执行同步 GC，抑制长会话中的锯齿状堆增长。
   * 限流为每 10 秒最多一次，避免快速中断/重启循环堆积 GC 停顿；
   * 且仅在 "completed" 状态下执行 —— 被中断或报错的路径之后可能
   * 立刻重启，此时停顿对用户更明显。
   */
  _maybeRunIdleGc(): void {
    maybeRunIdleGc(this);
  }

  _appendInterruptionSystemMessage(
    partialToolNames: readonly string[] = [],
    compactWasInterrupted = false,
  ): void {
    appendInterruptionSystemMessage(this, partialToolNames, compactWasInterrupted);
  }

  /**
   * 记录一条 input_received 条目。
   *
   * `_turnCount`（后续 provider 轮次使用的「当前输入序号」）只在 agent
   * 空闲时推进到新输入。agent 处于 working/waiting 时，新输入拥有更大的
   * inputIndex，但 `_turnCount` 保持不变 —— 进行中激活产生的回合条目必须
   * 继续使用当前输入的序号，直到 drain 投递新输入。
   */
  /**
   * 记录一条 input_received 条目。
   *
   * `_turnCount`（后续 provider 轮次使用的「当前输入序号」）只在 agent
   * 空闲时推进到新输入。agent 处于 working/waiting 时，新输入拥有更大的
   * inputIndex，但 `_turnCount` 保持不变 —— 进行中激活产生的回合条目必须
   * 继续使用当前输入的序号，直到 drain 投递新输入。
   */
  _recordInputReceived(
    inputKind: "user" | "compact",
    display: string,
    content: unknown,
    contextId?: string,
  ): { inputIndex: number; inputId: string; contextId: string } {
    return recordInputReceived(this, inputKind, display, content, contextId);
  }

  _appendDeliveredUserMessage(
    inputIndex: number,
    inputId: string,
    inputKind: "user" | "compact",
    display: string,
    content: unknown,
    contextId: string,
    tuiVisible = true,
  ): void {
    appendDeliveredUserMessage(this, inputIndex, inputId, inputKind, display, content, contextId, tuiVisible);
  }

  /** 基于已有条目计算给定回合的下一个 roundIndex。 */
  /** 基于已有条目计算给定回合的下一个 roundIndex。 */
  _computeNextRoundIndex(turnIndex: number = this._turnCount): number {
    return computeNextRoundIndex(this, turnIndex);
  }

  _findRoundContextId(turnIndex: number, roundIndex: number): string | undefined {
    return findRoundContextId(this, turnIndex, roundIndex);
  }



  _resolveOutputRoundContextId(turnIndex: number, roundIndex: number): string {
    return resolveOutputRoundContextId(this, turnIndex, roundIndex);
  }

  _retagRoundEntries(turnIndex: number, roundIndex: number, contextId: string): void {
    retagRoundEntries(this, turnIndex, roundIndex, contextId);
  }

  /** 最后一个 live compact_marker 之后的第一条条目索引（活动窗口起点）。 */
  /** 最后一个 live compact_marker 之后的第一条条目索引（活动窗口起点）。 */
  _activeWindowStartIdx(): number {
    return activeWindowStartIdx(this);
  }

  /**
   * 在活动窗口内按 id 查找 tool_call 条目（从新到旧）。
   * 不限定当前回合：即使回合计数已经推进，ask 记账仍需
   * 与其 tool_call 配对。
   */
  /**
   * 在活动窗口内按 id 查找 tool_call 条目（从新到旧）。
   * 不限定当前回合：即使回合计数已经推进，ask 记账仍需
   * 与其 tool_call 配对。
   */
  _findToolCallEntry(toolCallId: string): LogEntry | undefined {
    return findToolCallEntry(this, toolCallId);
  }

  /** ask 记账所用的回合/轮次锚点，由受门控的 tool_call 推导。 */
  /** ask 记账所用的回合/轮次锚点，由受门控的 tool_call 推导。 */
  _toolCallAnchor(toolCallId: string, ask?: AskRequest | null): { turnIndex: number; roundIndex: number } {
    return toolCallAnchor(this, toolCallId, ask);
  }

  _findToolCallContextId(toolCallId: string, roundIndex?: number): string | undefined {
    return findToolCallContextId(this, toolCallId, roundIndex);
  }

  // ------------------------------------------------------------------
  // 统一消息投递（v2 架构）
  // ------------------------------------------------------------------

  /**
   * 统一的消息投递入口。
   * 所有状态都先压入收件箱；空闲状态还会安排自动续跑。
   * working/waiting 时由激活边界或 await_event 轮询排空。
   */
  /**
   * 统一的消息投递入口。
   * 所有状态都先压入收件箱；空闲状态还会安排自动续跑。
   * working/waiting 时由激活边界或 await_event 轮询排空。
   */
  _deliverMessage(msg: MessageEnvelope): DeliverMessageResult {
    return deliverInboxMessage(this, msg);
  }

  /**
   * 供 TUI / GUI 投递消息的公开封装。
   * 保留原有的 (source, content) 签名，兼容外部调用方。
   */
  /**
   * 供 TUI / GUI 投递消息的公开封装。
   * 保留原有的 (source, content) 签名，兼容外部调用方。
   */
  deliverMessage(source: "user" | "system", content: string): DeliverMessageResult {
    return deliverMessage(this, source, content);
  }

  _getQueuedUserInputs(): Array<{
    inputId: string;
    inboxIndex: number;
    message: MessageEnvelope;
    inputEntry: LogEntry;
  }> {
    return getQueuedUserInputs(this);
  }

  _maxLiveInputIndex(): number {
    return maxLiveInputIndex(this);
  }

  restoreQueuedUserInput(): string | null {
    return restoreQueuedUserInput(this);
  }

  _autoResumeScheduled = false;

  /**
   * 为空闲状态安排一次自动续跑回合。用于父 agent 没有活动回合时收到
   * 消息（子代理完成、shell 退出等）的场景。否则排队的消息会一直
   * 躺在日志里，直到用户手动开启新回合才被处理。
   */
  /**
   * 为空闲状态安排一次自动续跑回合。用于父 agent 没有活动回合时收到
   * 消息（子代理完成、shell 退出等）的场景。否则排队的消息会一直
   * 躺在日志里，直到用户手动开启新回合才被处理。
   */
  _scheduleAutoResume(): void {
    scheduleAutoResume(this);
  }

  /**
   * 运行一个排空排队消息、但不接收新用户输入的回合。
   * 获取回合锁，与普通 turn() 调用串行化。
   */
  /**
   * 运行一个排空排队消息、但不接收新用户输入的回合。
   * 获取回合锁，与普通 turn() 调用串行化。
   */
  async _autoResumeFromIdle(): Promise<void> {
    return autoResumeFromIdle(this);
  }

  /**
   * 反向扫描日志，判断最近一条与回合相关的条目是否为尚未响应的
   * user_message（其后没有 assistant_text/tool_call/reasoning）。
   * 供自动续跑判断：finally 块中的排空写过消息、模型却没看到时，
   * 是否需要再触发一个回合。
   */
  /**
   * 反向扫描日志，判断最近一条与回合相关的条目是否为尚未响应的
   * user_message（其后没有 assistant_text/tool_call/reasoning）。
   * 供自动续跑判断：finally 块中的排空写过消息、模型却没看到时，
   * 是否需要再触发一个回合。
   */
  _hasUnprocessedUserMessage(): boolean {
    return hasUnprocessedUserMessage(this);
  }

  /**
   * 检查收件箱是否有待处理消息。
   */
  /**
   * 检查收件箱是否有待处理消息。
   */
  _hasInboxMessages(): boolean {
    return hasInboxMessages(this);
  }

  /**
   * 检查收件箱是否有待处理的 WAKING 消息。随行消息（wake === false）
   * 不阻塞手动上下文命令 —— 它们是被动记录（例如用户发起的 kill 通知），
   * 等下一个回合再处理。
   */
  /**
   * 检查收件箱是否有待处理的 WAKING 消息。随行消息（wake === false）
   * 不阻塞手动上下文命令 —— 它们是被动记录（例如用户发起的 kill 通知），
   * 等下一个回合再处理。
   */
  _hasWakingInboxMessages(): boolean {
    return hasWakingInboxMessages(this);
  }

  /** 投递真实用户输入时，移除上一轮已完成的任务清单。 */
  /** 投递真实用户输入时，移除上一轮已完成的任务清单。 */
  _clearCompletedTasksBeforeUserInput(): void {
    clearCompletedTasksBeforeUserInput(this);
  }

  /**
   * 激活前的公共前奏，供所有记录新活动输入（用户消息或 /compact）的
   * 入口共用。这里是唯一的收口点，负责 wake:false 的顺序与
   * 「会话已开始」边界：
   *
   *   1. 先到的随行（wake:false）收件箱消息按到达顺序先落入日志。
   *      `wake:false` 表示「不要自行开启回合」，而不是「插到下一个
   *      活动输入之后」。
   *   2. 记录新的活动输入。
   *
   * 向模型侧日志的投递（user_message 还是 status 条目）留给调用方 ——
   * 不同激活类型本就不同。「会话已开始」标志在该投递点
   * （_appendDeliveredUserMessage）翻转，因此每条用户消息路径都会置位。
   */
  /**
   * 激活前的公共前奏，供所有记录新活动输入（用户消息或 /compact）的
   * 入口共用。这里是唯一的收口点，负责 wake:false 的顺序与
   * 「会话已开始」边界：
   *
   *   1. 先到的随行（wake:false）收件箱消息按到达顺序先落入日志。
   *      `wake:false` 表示「不要自行开启回合」，而不是「插到下一个
   *      活动输入之后」。
   *   2. 记录新的活动输入。
   *
   * 向模型侧日志的投递（user_message 还是 status 条目）留给调用方 ——
   * 不同激活类型本就不同。「会话已开始」标志在该投递点
   * （_appendDeliveredUserMessage）翻转，因此每条用户消息路径都会置位。
   */
  _beginActiveInput(
    inputKind: "user" | "compact",
    display: string,
    content: unknown,
  ): { inputIndex: number; inputId: string; contextId: string } {
    return beginActiveInput(this, inputKind, display, content);
  }

  _hasRunningShells(): boolean {
    return this._shellManager.hasRunningShells();
  }

  _buildShellReport(): string {
    return this._shellManager.buildShellReport();
  }

  // ------------------------------------------------------------------
  // 后台 shell 的 UI 面（角标、选择器、详情页）
  // ------------------------------------------------------------------

  /** 供 UI 使用的全部受跟踪后台 shell 快照。 */
  getBackgroundShellSnapshots(): BackgroundShellSnapshot[] {
    return this._shellManager.listShells();
  }

  /** shell 详情视图的快照 + 日志尾部；未知 id 返回 null。 */
  getBackgroundShellDetail(id: string, opts?: { maxChars?: number }): BackgroundShellDetail | null {
    return this._shellManager.getShellDetail(id, opts);
  }

  /**
   * 用户主动停止某个后台 shell（Shells 面板 / 详情页）。
   * 实际执行 kill 时，会排队一条随行系统通知，让 agent 在下一个回合
   * 得知 —— 但不唤醒它：用户就在场主导。
   */
  async stopBackgroundShell(id: string): Promise<string> {
    const result = await this._shellManager.killShell(id);
    if (result.performed) {
      this._deliverMessage({
        type: "system_notice",
        sender: "system",
        timestamp: Date.now(),
        content:
          `The user manually stopped background shell '${id}' from the UI (${result.message}). ` +
          `Do not restart it unless the user asks.`,
        wake: false,
        tuiVisible: false,
      });
    }
    return result.message;
  }

  // ------------------------------------------------------------------
  // 收件箱排空 —— 逐条渲染
  // ------------------------------------------------------------------

  /**
   * 把排队消息投递到模型侧日志。
   *
   * 用户消息在收到时先展示，但要等当前 provider 轮次结束后才在这里投递。
   * 这样能保持 API 顺序：user A → assistant A → user B，即使 user B
   * 是在 assistant A 仍在流式输出时输入的。
   */
  /**
   * 把排队消息投递到模型侧日志。
   *
   * 用户消息在收到时先展示，但要等当前 provider 轮次结束后才在这里投递。
   * 这样能保持 API 顺序：user A → assistant A → user B，即使 user B
   * 是在 assistant A 仍在流式输出时输入的。
   */
  _drainInboxAsEntries(): number {
    return drainInboxAsEntries(this);
  }

  _installCurrentTurnSignal(signal?: AbortSignal): {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
    signal: AbortSignal;
  } {
    const prevSignal = this._currentTurnSignal;
    const prevController = this._currentTurnAbortController;
    const controller = new AbortController();

    let cleanup = () => {};
    if (signal) {
      if (signal.aborted) {
        controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
      } else {
        const onAbort = () => controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => signal.removeEventListener("abort", onAbort);
      }
    }

    this._currentTurnAbortController = controller;
    this._currentTurnSignal = controller.signal;

    // 中止时清空活动条目跟踪器
    controller.signal.addEventListener("abort", () => {
      this._activeLogEntryId = null;
    }, { once: true });

    return {
      prevSignal,
      prevController,
      cleanup,
      signal: controller.signal,
    };
  }

  _restoreCurrentTurnSignal(state: {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
  }): void {
    state.cleanup();
    this._currentTurnSignal = state.prevSignal;
    this._currentTurnAbortController = state.prevController;
  }

  // ------------------------------------------------------------------
  // 回合串行化
  // ------------------------------------------------------------------

  /**
   * 等待进行中的回合结束。任何时刻调用都安全。
   * 供 resetForNewSession、close 以及需要确保上一回合完全收尾后再继续的
   * 调用方使用。
   */
  /**
   * 等待进行中的回合结束。任何时刻调用都安全。
   * 供 resetForNewSession、close 以及需要确保上一回合完全收尾后再继续的
   * 调用方使用。
   */
  async waitForTurnComplete(): Promise<void> {
    return waitForTurnComplete(this);
  }

  /**
   * 基于 Promise 的回合锁，保证同一时刻最多只有一个回合入口在执行。
   * 调用方被串行化：若有回合正在进行，下一个调用方会等它结束
   * （中止后通常很快）。
   */
  /**
   * 基于 Promise 的回合锁，保证同一时刻最多只有一个回合入口在执行。
   * 调用方被串行化：若有回合正在进行，下一个调用方会等它结束
   * （中止后通常很快）。
   */
  async _withTurnLock<T>(fn: () => Promise<T>): Promise<T> {
    return withTurnLock(this, fn);
  }

  /**
   * 为当前回合准备并执行中断清理。
   *
   * 先做一次非破坏性的投递快照，然后杀掉活跃 worker，
   * 丢弃未消费的运行时状态。
   */
  /**
   * 为当前回合准备并执行中断清理。
   *
   * 先做一次非破坏性的投递快照，然后杀掉活跃 worker，
   * 丢弃未消费的运行时状态。
   */
  requestTurnInterrupt(): { accepted: true } {
    return requestTurnInterrupt(this);
  }

  denyAndInterruptPendingAsk(): { accepted: boolean; reason?: string; turnFinished?: boolean } {
    return denyAndInterruptPendingAsk(this);
  }

  /** 为 RPC 与生命周期调用方停止所有运行中的子会话。 */
  interruptAllChildAgents(): void {
    if (this._childSessions.size > 0) {
      this._cascadeKillRunningChildren("user_mass_interrupt");
    }
  }

  hasRunningChildAgents(): boolean {
    for (const handle of this._childSessions.values()) {
      if (handle.lifecycle === "running" || handle.lifecycle === "blocked") return true;
    }
    return false;
  }

  killAllShells(): void {
    if (this._shellManager.hasTrackedShells()) {
      this._forceKillAllShells();
    }
  }

  /**
   * 若存在待处理的权限审批或 agent_question ask，合成 Deny/Decline
   * 决议与拒绝用的 tool_result。只要有任一项被拒绝就返回 true。
   * 由 TUI 在提示框显示时按下 ESC/Ctrl+C 调用。
   */
  /**
   * 若存在待处理的权限审批或 agent_question ask，合成 Deny/Decline
   * 决议与拒绝用的 tool_result。只要有任一项被拒绝就返回 true。
   * 由 TUI 在提示框显示时按下 ESC/Ctrl+C 调用。
   */
  denyPendingAsk(): boolean {
    return denyPendingAsk(this);
  }

  /**
   * 向后兼容的别名。
   */
  cancelCurrentTurn(): void {
    this.requestTurnInterrupt();
  }

  _resetTransientState(): void {
    this._lastInputTokens = 0;
    this._lastTotalTokens = 0;
    this._lastCacheReadTokens = 0;
    this._cacheSupported = false;
    this._usageStatsCache = null;
    this._usageBase = null;
    this._usageBaseIds = new Set();
    this._usageBaseVersion += 1;
    this._usageFirstInput = 0;
    this._usageFirstUserMessageTokens = 0;
    this._promptSectionEstimates = null;
    this._contextEstimateCache = null;
    this._compactInProgress = false;
    this._compactTerminatedThisTurn = false;
    this._agentState = "idle";
    this._inbox = [];
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    // _waitHandle 已移除 —— await_event 改为轮询
    this._activeAsk = null;
    this._askHistory = [];
    this._pendingTurnState = null;
    // /clear 只重置当前回合的临时上下文；session 作用域由 /new 或恢复清理。
    this.hookRuntime.clearTurnContext();
    this.hookRuntime.clearNextRoundContext();
    if (this._childSessions.size > 0) {
      this._archiveAllChildSessions();
    }
    if (this._shellManager.hasTrackedShells()) {
      this._forceKillAllShells();
    }
    this._subAgentCounter = 0;
    this._shellManager.resetCounter();
  }

  /**
   * 新会话/恢复边界：丢弃全部 hook 上下文，并允许 SessionStart 重新执行一次。
   * 与 /clear 区分：/clear 只清理回合级临时上下文。
   */
  _resetHookContextForNewSession(): void {
    this.hookRuntime.clearAllContext();
    this._sessionStartHooksPromise = null;
  }

  // ------------------------------------------------------------------
  // 日志访问器（v2）
  // ------------------------------------------------------------------

  /** 结构化日志的只读快照。 */
  get log(): readonly LogEntry[] {
    return this._log;
  }

  /** 展示截断索引 —— 此索引之前的条目对 UI 隐藏，但仍保留在模型上下文中。 */
  private _displayCutoff = 0;

  // R-3 有界历史：活动窗口在 _log，早期历史按页从磁盘取回。
  private _historyStartOffset: number | null = null;
  private _historyPager: TuiHistoryPager | null = null;
  private _historyExhausted = true;
  /** live 会话（日志完整在内存）的历史游标；null 表示尚未开始翻页。 */
  private _liveHistoryCursor: number | null = null;
  private _earlierEntries: LogEntry[] = [];
  private _earlierEntriesBytes = 0;
  private _historyCacheCapped = false;
  private _archivedDisplays: Map<string, string> | null = null;
  private _historyPageLoadInFlight: Promise<{ loaded: number; hasMore: boolean; capped?: boolean }> | null = null;

  /** 按展示截断过滤后的日志只读快照，含已加载的更早历史。 */
  getDisplayLog(): readonly LogEntry[] {
    // 默认只展示活动窗口（含最近的 compact marker）；更早条目通过分页加入。
    const activeStart = this._logStore.activeWindowStartIdx();
    const windowStart = activeStart > 0 ? activeStart - 1 : 0;
    const cutoff = Math.max(this._displayCutoff, windowStart);
    const live = cutoff > 0 ? this._log.slice(cutoff) : this._log;
    if (this._earlierEntries.length === 0) return live;
    const liveIds = new Set(live.map((entry) => entry.id));
    const earlier = this._earlierEntries.filter((entry) => !liveIds.has(entry.id));
    return earlier.length > 0 ? [...earlier, ...live] : live;
  }

  /** 有界恢复后启用历史分页；startOffset 必须是行首（R-2 的 windowStartOffset）。 */
  enableBoundedHistory(startOffset: number): void {
    this._closeHistoryPaging();
    this._historyStartOffset = Math.max(0, startOffset);
    this._historyExhausted = false;
  }

  hasEarlierHistory(): boolean {
    if (this._historyCacheCapped) return false;
    if (this._historyStartOffset !== null) return !this._historyExhausted;
    const activeStart = this._logStore.activeWindowStartIdx();
    if (activeStart <= 0) return false;
    const cursor = this._liveHistoryCursor ?? activeStart;
    return cursor > 0;
  }

  /** 页缓存是否已达到 8 MiB 上限（此时不再加载更早历史）。 */
  isHistoryCacheCapped(): boolean {
    return this._historyCacheCapped;
  }

  /** 取一页更早的历史并合并到展示日志；返回本次加载条数与是否还有更早页。 */
  loadEarlierHistoryPage(maxEntries = HISTORY_PAGE_DEFAULT_ENTRIES): { loaded: number; hasMore: boolean; capped?: boolean } {
    const pageSize = normalizeHistoryPageSize(maxEntries);
    if (this._historyStartOffset === null) {
      return this._loadLiveHistoryPage(pageSize);
    }
    const dir = this._resolvePersistDir();
    if (!dir || this._historyExhausted) {
      return { loaded: 0, hasMore: false };
    }
    try {
      this._historyPager ??= openTuiHistoryPager(dir, {
        startOffset: this._historyStartOffset,
        maxEntries: pageSize,
      });
      const page = this._historyPager.nextPage();
      this._hydrateArchivedDisplays(dir, page.entries);
      return this._mergeHistoryPage(page.entries, page.hasMore);
    } catch (error) {
      this._historyPager?.close();
      this._historyPager = null;
      this._historyExhausted = false;
      throw error;
    }
  }

  private _hydrateArchivedDisplays(dir: string, entries: readonly LogEntry[]): void {
    const missing = entries.filter((entry) =>
      entry.archived && entry.display === "" && !this._archivedDisplays?.has(entry.id));
    const displays = missing.length > 0
      ? loadArchivedDisplaysForEntries(dir, missing).displays
      : undefined;
    this._applyArchivedDisplays(entries, displays);
  }

  private async _hydrateArchivedDisplaysAsync(dir: string, entries: readonly LogEntry[]): Promise<void> {
    const missing = entries.filter((entry) =>
      entry.archived && entry.display === "" && !this._archivedDisplays?.has(entry.id));
    const displays = missing.length > 0
      ? (await loadArchivedDisplaysForEntriesAsync(dir, missing)).displays
      : undefined;
    this._applyArchivedDisplays(entries, displays);
  }

  private _applyArchivedDisplays(
    entries: readonly LogEntry[],
    displays?: ReadonlyMap<string, string>,
  ): void {
    if (displays && displays.size > 0) {
      this._archivedDisplays ??= new Map();
      for (const [id, display] of displays) this._archivedDisplays.set(id, display);
    }
    if (!this._archivedDisplays) return;
    for (const entry of entries) {
      if (!entry.archived || entry.display !== "") continue;
      entry.display = this._archivedDisplays.get(entry.id) ?? "";
    }
  }

  private _mergeHistoryPage(
    entries: readonly LogEntry[],
    hasMore: boolean,
  ): { loaded: number; hasMore: boolean; capped?: boolean } {
    let loaded = 0;
    if (entries.length > 0) {
      const known = new Set<string>([
        ...this._earlierEntries.map((entry) => entry.id),
        ...this._log.map((entry) => entry.id),
      ]);
      const fresh = entries.filter((entry) => !known.has(entry.id));
      const freshBytes = estimateEntriesBytes(fresh);
      if (this._earlierEntriesBytes + freshBytes > HISTORY_PAGE_CACHE_BYTES) {
        this._historyCacheCapped = true;
        this._historyExhausted = true;
        this._historyPager?.close();
        this._historyPager = null;
        this._bumpLogRevision();
        this._notifyLogListeners();
        return { loaded: 0, hasMore: false, capped: true };
      }
      this._earlierEntries = [...fresh, ...this._earlierEntries];
      this._earlierEntriesBytes += freshBytes;
      loaded = fresh.length;
    }
    if (!hasMore) {
      this._historyExhausted = true;
      this._historyPager?.close();
      this._historyPager = null;
    }
    this._bumpLogRevision();
    this._notifyLogListeners();
    return { loaded, hasMore };
  }

  /** 异步历史页：archive display 读取使用异步流；JSONL 分页器仍复用同步窗口读取。 */
  async loadEarlierHistoryPageAsync(maxEntries = HISTORY_PAGE_DEFAULT_ENTRIES): Promise<{ loaded: number; hasMore: boolean; capped?: boolean }> {
    const pageSize = normalizeHistoryPageSize(maxEntries);
    if (this._historyPageLoadInFlight) return this._historyPageLoadInFlight;
    const pending = this._loadEarlierHistoryPageAsync(pageSize);
    this._historyPageLoadInFlight = pending;
    try {
      return await pending;
    } catch (error) {
      this._historyPager?.close();
      this._historyPager = null;
      this._historyExhausted = false;
      throw error;
    } finally {
      if (this._historyPageLoadInFlight === pending) this._historyPageLoadInFlight = null;
    }
  }

  private async _loadEarlierHistoryPageAsync(
    maxEntries: number,
  ): Promise<{ loaded: number; hasMore: boolean; capped?: boolean }> {
    if (this._historyStartOffset === null) return this._loadLiveHistoryPageAsync(maxEntries);
    const dir = this._resolvePersistDir();
    if (!dir || this._historyExhausted) return { loaded: 0, hasMore: false };

    this._historyPager ??= openTuiHistoryPager(dir, {
      startOffset: this._historyStartOffset,
      maxEntries,
    });
    const page = this._historyPager.nextPage();
    await this._hydrateArchivedDisplaysAsync(dir, page.entries);
    return this._mergeHistoryPage(page.entries, page.hasMore);
  }

  private _appendLiveHistoryPage(
    entries: readonly LogEntry[],
    start: number,
    freshBytes: number,
  ): { loaded: number; hasMore: boolean; capped?: boolean } {
    this._earlierEntries = [...entries, ...this._earlierEntries];
    this._earlierEntriesBytes += freshBytes;
    this._liveHistoryCursor = start;
    this._bumpLogRevision();
    this._notifyLogListeners();
    return { loaded: entries.length, hasMore: start > 0 };
  }

  private async _loadLiveHistoryPageAsync(
    maxEntries: number,
  ): Promise<{ loaded: number; hasMore: boolean; capped?: boolean }> {
    const activeStart = this._logStore.activeWindowStartIdx();
    if (activeStart <= 0) {
      this._liveHistoryCursor = 0;
      return { loaded: 0, hasMore: false };
    }
    const cursor = this._liveHistoryCursor ?? activeStart;
    if (cursor <= 0) return { loaded: 0, hasMore: false };
    const start = Math.max(0, cursor - maxEntries);
    const page = this._log.slice(start, cursor);
    if (page.length === 0) return { loaded: 0, hasMore: false };

    const freshBytes = estimateEntriesBytes(page);
    if (this._earlierEntriesBytes + freshBytes > HISTORY_PAGE_CACHE_BYTES) {
      this._historyCacheCapped = true;
      this._liveHistoryCursor = start;
      return { loaded: 0, hasMore: false, capped: true };
    }

    const dir = this._resolvePersistDir();
    if (dir) await this._hydrateArchivedDisplaysAsync(dir, page);
    return this._appendLiveHistoryPage(page, start, freshBytes);
  }

  /** live 会话：从内存日志向更早页移动，不重新读盘。 */
  private _loadLiveHistoryPage(maxEntries: number): { loaded: number; hasMore: boolean; capped?: boolean } {
    const activeStart = this._logStore.activeWindowStartIdx();
    if (activeStart <= 0) {
      this._liveHistoryCursor = 0;
      return { loaded: 0, hasMore: false };
    }
    const cursor = this._liveHistoryCursor ?? activeStart;
    if (cursor <= 0) return { loaded: 0, hasMore: false };
    const start = Math.max(0, cursor - maxEntries);
    const page = this._log.slice(start, cursor);
    if (page.length === 0) return { loaded: 0, hasMore: false };

    const freshBytes = estimateEntriesBytes(page);
    if (this._earlierEntriesBytes + freshBytes > HISTORY_PAGE_CACHE_BYTES) {
      this._historyCacheCapped = true;
      this._liveHistoryCursor = start;
      return { loaded: 0, hasMore: false, capped: true };
    }

    const dir = this._resolvePersistDir();
    if (dir) this._hydrateArchivedDisplays(dir, page);
    return this._appendLiveHistoryPage(page, start, freshBytes);
  }

  private _closeHistoryPaging(): void {
    this._historyPager?.close();
    this._historyPager = null;
    this._historyExhausted = true;
    this._historyStartOffset = null;
    this._liveHistoryCursor = null;
    this._earlierEntries = [];
    this._earlierEntriesBytes = 0;
    this._historyCacheCapped = false;
    this._archivedDisplays = null;
  }

  /**
   * 有界会话的完整历史（只读、不替换 _log）；读失败时退回窗口。
   */
  private _loadFullHistoryEntries(): LogEntry[] {
    if (this._historyStartOffset === null) return this._log;
    const dir = this._resolvePersistDir();
    if (!dir) return this._log;
    try {
      return loadLogJsonl(dir).entries;
    } catch {
      return this._log;
    }
  }

  /**
   * 有界会话在回退/文件回退前物化完整历史：先落盘当前窗口，再整体替换 _log。
   * 之后分页状态关闭，用量回到"从完整日志重算"。
   */
  private _materializeFullHistory(): { ok: true } | { ok: false; error: string } {
    if (this._historyStartOffset === null) return { ok: true };
    const dir = this._resolvePersistDir();
    if (!dir) return { ok: false, error: "session directory is not bound" };
    if (!this.persistToDisk()) return { ok: false, error: "failed to flush the log" };
    try {
      const full = loadLogJsonl(dir).entries;
      const windowStartId = this._log[0]?.id;
      const found = windowStartId ? full.findIndex((entry) => entry.id === windowStartId) : -1;
      const prefixLen = found >= 0
        ? found
        : Math.max(0, full.length - this._log.length);
      const oldCutoff = this._displayCutoff;
      this._log = full;
      this._displayCutoff = oldCutoff > 0
        ? Math.min(full.length, prefixLen + oldCutoff)
        : 0;
      this._closeHistoryPaging();
      this._usageBase = null;
      this._usageBaseIds = new Set();
      this._usageBaseVersion += 1;
      this._usageStatsCache = null;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private _listTurnsFrom(
    entries: LogEntry[],
    archivedTurnInfo: ReadonlyMap<string, ArchivedTurnInfo> | undefined = this._loadArchivedTurnInfo(),
  ): TurnListing[] {
    if (entries === this._log) return this._logStore.listTurns(archivedTurnInfo);
    const temp = new SessionLog();
    temp.replace(entries);
    return temp.listTurns(archivedTurnInfo);
  }

  /** 把展示截断设为当前日志长度（供 /clear 使用）。 */
  setDisplayCutoff(): void {
    this._displayCutoff = this._log.length;
    this._logStore.bumpRevision();
  }

  /** 把展示截断重置为 0（显示全部条目）。 */
  resetDisplayCutoff(): void {
    this._displayCutoff = 0;
  }

  getLogRevision(): number {
    return this._logStore.revision;
  }

  /** 当前活跃（正在流式输出/执行）的日志条目 ID；没有则为 null。 */
  get activeLogEntryId(): string | null {
    return this._activeLogEntryId;
  }

  /** 订阅日志变化，返回取消订阅函数。 */
  subscribeLog(listener: () => void): () => void {
    return this._logStore.subscribe(listener);
  }

  // ------------------------------------------------------------------
  // 回合列表（回退与历史投影共用）
  // ------------------------------------------------------------------

  /**
   * 返回日志中每个回合的元数据（见 SessionLog.listTurns）。
   * 回退与历史投影共用。
   */
  listTurns(): TurnListing[] {
    return this._listTurnsFrom(this._loadFullHistoryEntries());
  }

  async listTurnsAsync(): Promise<TurnListing[]> {
    const entries = this._loadFullHistoryEntries();
    const archivedTurnInfo = await this._loadArchivedTurnInfoAsync();
    if (entries === this._log) return this._logStore.listTurns(archivedTurnInfo);
    const temp = new SessionLog();
    temp.replace(entries);
    return temp.listTurns(archivedTurnInfo);
  }

  /** 归档索引只在 listTurns/回退菜单这类低频路径读取，不常驻。 */
  private _loadArchivedTurnInfo(): Map<string, ArchivedTurnInfo> | undefined {
    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return undefined;
    return loadArchiveTurnIndexes(sessionDir);
  }

  private async _loadArchivedTurnInfoAsync(): Promise<Map<string, ArchivedTurnInfo> | undefined> {
    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return undefined;
    return loadArchiveTurnIndexesAsync(sessionDir);
  }

  /** 回退菜单的文件统计只读摘要索引，不加载 reversePatch。 */
  private _loadArchivedMutations(): Map<string, ArchivedMutationInfo> | undefined {
    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return undefined;
    return loadArchiveMutationIndexes(sessionDir);
  }

  private async _loadArchivedMutationsAsync(): Promise<Map<string, ArchivedMutationInfo> | undefined> {
    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return undefined;
    return loadArchiveMutationIndexesAsync(sessionDir);
  }

  /**
   * 为一次回退计划临时装载归档 meta：旧窗口的 fileMutation/bashMutation
   * 已随压缩搬进 archive/，内存里只剩身份字段。返回还原函数。
   */
  private _installArchivedMeta(fromTurnIndex: number): () => void {
    const previous = this._archivedMetaLookup;
    const sessionDir = this._store?.sessionDir;
    if (sessionDir && this._log.some((entry) => entry.archived)) {
      // 归档不可读时必须失败：空 lookup 会让 rewind 生成“成功但没有 mutation”的计划。
      const lookup = new Map<string, Record<string, unknown>>();
      for (const [id, meta] of loadArchivedMetaForTurns(sessionDir, fromTurnIndex)) {
        lookup.set(id, meta);
      }
      this._archivedMetaLookup = lookup;
    }
    return () => {
      this._archivedMetaLookup = previous;
    };
  }

  private async _installArchivedMetaAsync(fromTurnIndex: number): Promise<() => void> {
    const previous = this._archivedMetaLookup;
    const sessionDir = this._store?.sessionDir;
    if (sessionDir && this._log.some((entry) => entry.archived)) {
      const lookup = await loadArchivedMetaForTurnsAsync(sessionDir, fromTurnIndex);
      this._archivedMetaLookup = lookup;
    }
    return () => {
      this._archivedMetaLookup = previous;
    };
  }

  // ------------------------------------------------------------------
  // 回退
  // ------------------------------------------------------------------

  /**
   * 获取可回退的回合边界列表。
   * 只显示真实的用户回合（不含注入回合与压缩回合）。
   * 包含 compact marker 之前的回合（回退会撤销压缩）。
   * 按时间倒序返回（最近的在前）。
   */
  /**
   * 有界会话的回退数据源：索引有效则只读 turn/mutation 摘要；否则整读重建一次。
   */
  private _loadTurnIndexForRewind(): TurnIndexData | null {
    if (this._historyStartOffset === null) return null;
    const dir = this._resolvePersistDir();
    if (!dir) return null;
    try {
      const seq = readLastSeq(dir);
      const cached = readTurnIndex(dir, seq);
      if (cached) return cached;
      const entries = this._loadFullHistoryEntries();
      if (entries === this._log) return null;
      const data = buildTurnIndex(entries, this._loadArchivedTurnInfo(), this._loadArchivedMutations());
      writeTurnIndex(dir, data, seq);
      return data;
    } catch {
      return null;
    }
  }

  private async _loadTurnIndexForRewindAsync(): Promise<TurnIndexData | null> {
    if (this._historyStartOffset === null) return null;
    const dir = this._resolvePersistDir();
    if (!dir) return null;
    try {
      const seq = readLastSeq(dir);
      const cached = readTurnIndex(dir, seq);
      if (cached) return cached;
      const entries = this._loadFullHistoryEntries();
      if (entries === this._log) return null;
      const [archivedTurns, archivedMutations] = await Promise.all([
        this._loadArchivedTurnInfoAsync(),
        this._loadArchivedMutationsAsync(),
      ]);
      const data = buildTurnIndex(entries, archivedTurns, archivedMutations);
      writeTurnIndex(dir, data, seq);
      return data;
    } catch {
      return null;
    }
  }

  private _aggregateEntryMutations(
    entries: readonly LogEntry[],
    archivedMutations: ReadonlyMap<string, ArchivedMutationInfo> | undefined = this._loadArchivedMutations(),
  ): Map<number, TurnMutationAggregate> {
    const perTurn = new Map<number, TurnMutationAggregate>();
    for (const entry of entries) {
      if (entry.type !== "tool_result" || entry.discarded) continue;
      const meta = entry.meta as Record<string, unknown>;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const liveMutation = toolMeta?.fileMutation as FileMutation | undefined;
      const archivedMutation = liveMutation ? undefined : archivedMutations?.get(entry.id);
      const mutationPath = liveMutation?.path ?? archivedMutation?.path;
      if (!mutationPath) continue;
      let cur = perTurn.get(entry.turnIndex);
      if (!cur) {
        cur = { livePaths: new Set(), revertedPaths: new Set(), additions: 0, deletions: 0 };
        perTurn.set(entry.turnIndex, cur);
      }
      if (meta.fileMutationReverted) {
        cur.revertedPaths.add(mutationPath);
      } else {
        cur.livePaths.add(mutationPath);
        cur.additions += liveMutation?.additions ?? archivedMutation?.additions ?? 0;
        cur.deletions += liveMutation?.deletions ?? archivedMutation?.deletions ?? 0;
      }
    }
    return perTurn;
  }

  private _aggregateIndexMutations(mutations: readonly TurnIndexMutation[]): Map<number, TurnMutationAggregate> {
    const perTurn = new Map<number, TurnMutationAggregate>();
    for (const mutation of mutations) {
      let cur = perTurn.get(mutation.turnIndex);
      if (!cur) {
        cur = { livePaths: new Set(), revertedPaths: new Set(), additions: 0, deletions: 0 };
        perTurn.set(mutation.turnIndex, cur);
      }
      if (mutation.reverted) {
        cur.revertedPaths.add(mutation.path);
      } else {
        cur.livePaths.add(mutation.path);
        cur.additions += mutation.additions;
        cur.deletions += mutation.deletions;
      }
    }
    return perTurn;
  }

  private _buildRewindTargets(
    index: TurnIndexData | null,
    entries: LogEntry[] | null,
    archivedTurns?: ReadonlyMap<string, ArchivedTurnInfo>,
    archivedMutations?: ReadonlyMap<string, ArchivedMutationInfo>,
  ): RewindTargetTurn[] {
    const userTurns = index
      ? index.turns
        .slice()
        .sort((a, b) => a.turnIndex - b.turnIndex || a.entryIndex - b.entryIndex)
        .filter((turn) => turn.kind === "user")
        .map((turn) => ({
          turnIndex: turn.turnIndex,
          entryIndex: turn.entryIndex,
          preview: turn.preview,
          timestamp: turn.timestamp,
        }))
      : this._listTurnsFrom(entries!, archivedTurns)
        .filter((turn) => turn.turnKind === "user")
        .map((turn) => ({
          turnIndex: turn.turnIndex,
          entryIndex: turn.entryIndex,
          preview: turn.preview,
          timestamp: turn.timestamp,
        }));
    const perTurn = index
      ? this._aggregateIndexMutations(index.mutations)
      : this._aggregateEntryMutations(entries!, archivedMutations);

    const turnIndices = userTurns.map((turn) => turn.turnIndex);
    const cumulative = new Map<number, { fileCount: number; additions: number; deletions: number; allReverted: boolean }>();
    const suffixLivePaths = new Set<string>();
    const suffixRevertedPaths = new Set<string>();
    let suffixAdd = 0;
    let suffixDel = 0;
    for (let i = turnIndices.length - 1; i >= 0; i -= 1) {
      const turnIndex = turnIndices[i];
      const current = perTurn.get(turnIndex);
      if (current) {
        for (const path of current.livePaths) suffixLivePaths.add(path);
        for (const path of current.revertedPaths) suffixRevertedPaths.add(path);
        suffixAdd += current.additions;
        suffixDel += current.deletions;
      }
      cumulative.set(turnIndex, {
        fileCount: suffixLivePaths.size,
        additions: suffixAdd,
        deletions: suffixDel,
        allReverted: suffixLivePaths.size === 0 && suffixRevertedPaths.size > 0,
      });
    }

    return userTurns
      .map((turn) => {
        const current = cumulative.get(turn.turnIndex) ?? {
          fileCount: 0,
          additions: 0,
          deletions: 0,
          allReverted: false,
        };
        return {
          turnIndex: turn.turnIndex,
          entryIndex: turn.entryIndex,
          preview: turn.preview,
          timestamp: turn.timestamp,
          fileCount: current.fileCount,
          additions: current.additions,
          deletions: current.deletions,
          filesReverted: current.allReverted,
        };
      })
      .reverse();
  }

  getRewindTargets(): RewindTargetTurn[] {
    const index = this._loadTurnIndexForRewind();
    const entries = index ? null : this._loadFullHistoryEntries();
    const archivedTurns = index ? undefined : this._loadArchivedTurnInfo();
    const archivedMutations = index ? undefined : this._loadArchivedMutations();
    return this._buildRewindTargets(index, entries, archivedTurns, archivedMutations);
  }

  async getRewindTargetsAsync(): Promise<RewindTargetTurn[]> {
    const index = await this._loadTurnIndexForRewindAsync();
    const entries = index ? null : this._loadFullHistoryEntries();
    const archivedTurns = index ? undefined : await this._loadArchivedTurnInfoAsync();
    const archivedMutations = index ? undefined : await this._loadArchivedMutationsAsync();
    return this._buildRewindTargets(index, entries, archivedTurns, archivedMutations);
  }

  /**
   * 有界索引的增量维护：upsert 更新 turn/mutation；patch 翻译成
   * drop-turn / drop-mutation / set-revert（归档与 presentation 剥离为 no-op）；
   * truncate 用 drop-turns-from 定向失效。只有未知语义才删除索引。
   */
  private _updateTurnIndexAfterAppend(
    dir: string,
    beforeSeq: number,
    records: readonly import("./config/log-jsonl.js").JsonlRecord[],
  ): boolean {
    if (records.length === 0) return true;
    const current = readTurnIndex(dir, beforeSeq);
    const ops: TurnIndexOp[] = [];
    const completedTurns = new Set<number>();
    let stale = false;
    for (const record of records) {
      if (stale) break;
      if (record.op === "truncate") {
        const boundary = current?.turns.find((turn) => turn.entryId === record.fromEntryId);
        if (!boundary) {
          stale = true;
          break;
        }
        ops.push({ v: TURN_INDEX_VERSION, op: "drop-turns-from", turnIndex: boundary.turnIndex });
        continue;
      }
      if (record.op === "patch") {
        // discarded:false 是唯一已知的“撤销丢弃”语义，索引无法从当前状态推断，回退重建。
        if (record.flags?.discarded === false) {
          stale = true;
          break;
        }
        for (const id of record.ids) {
          const entry = this._logStore.findEntryById(id);
          if (!entry) {
            stale = true;
            break;
          }
          if (record.flags?.discarded === true) {
            if (entry.type === "input_received" || entry.type === "turn_start") {
              ops.push({ v: TURN_INDEX_VERSION, op: "drop-turn", entryId: id });
            } else if (entry.type === "tool_result") {
              ops.push({ v: TURN_INDEX_VERSION, op: "drop-mutation", entryId: id });
            }
          }
          const reverted = record.flags?.fileMutationReverted;
          if (reverted !== undefined && entry.type === "tool_result") {
            ops.push({ v: TURN_INDEX_VERSION, op: "set-revert", entryId: id, reverted });
          }
        }
        continue;
      }
      if (record.op !== "upsert") continue;
      for (const raw of record.entries) {
        const id = raw.id;
        if (typeof id !== "string") continue;
        const entry = this._logStore.findEntryById(id);
        if (!entry) continue;
        if (entry.type === "turn_end" && !entry.discarded) {
          completedTurns.add(entry.turnIndex);
          continue;
        }
        if (entry.type === "input_received" || entry.type === "turn_start") {
          if (entry.discarded) {
            ops.push({ v: TURN_INDEX_VERSION, op: "drop-turn", entryId: id });
            continue;
          }
          const meta = entry.meta as Record<string, unknown>;
          const rawKind = entry.type === "input_received" ? meta.inputKind : meta.turnKind;
          const kind = typeof rawKind === "string" ? rawKind : "user";
          if (kind !== "user" && kind !== "summarize" && kind !== "compact") continue;
          const preview = entry.type === "input_received"
            ? entry.display.replace(/\s+/g, " ").trim().slice(0, 240)
            : "";
          ops.push({
            v: TURN_INDEX_VERSION,
            op: "turn",
            turn: {
              turnIndex: entry.turnIndex,
              entryId: entry.id,
              entryIndex: this._log.indexOf(entry),
              kind,
              preview: preview || `(turn ${entry.turnIndex})`,
              timestamp: entry.timestamp,
            },
          });
          continue;
        }
        if (entry.type !== "tool_result") continue;
        if (entry.discarded) {
          ops.push({ v: TURN_INDEX_VERSION, op: "drop-mutation", entryId: entry.id });
          continue;
        }
        const meta = entry.meta as Record<string, unknown>;
        const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
        const live = toolMeta?.fileMutation as { path?: unknown; additions?: unknown; deletions?: unknown } | undefined;
        if (typeof live?.path === "string") {
          ops.push({
            v: TURN_INDEX_VERSION,
            op: "mutation",
            mutation: {
              entryId: entry.id,
              turnIndex: entry.turnIndex,
              path: live.path,
              additions: typeof live.additions === "number" ? live.additions : 0,
              deletions: typeof live.deletions === "number" ? live.deletions : 0,
              reverted: meta.fileMutationReverted === true,
            },
          });
        } else if (meta.fileMutationReverted === true) {
          ops.push({ v: TURN_INDEX_VERSION, op: "set-revert", entryId: entry.id, reverted: true });
        }
      }
    }
    if (stale) {
      deleteTurnIndex(dir);
      this._turnIndexDirty = true;
      return false;
    }

    // turn_end 是 turn 的定稿点：刷新该 turn 的完整记录与本地 mutation 摘要，
    // 避免边界/工具结果分散在多个批次时索引只覆盖一半。
    for (const turnIndex of completedTurns) {
      const boundary = this._findTurnBoundaryEntry(turnIndex);
      if (boundary) {
        const meta = boundary.meta as Record<string, unknown>;
        const rawKind = boundary.type === "input_received" ? meta.inputKind : meta.turnKind;
        const kind = typeof rawKind === "string" ? rawKind : "user";
        if (kind === "user" || kind === "summarize" || kind === "compact") {
          const preview = boundary.type === "input_received"
            ? boundary.display.replace(/\s+/g, " ").trim().slice(0, 240)
            : "";
          ops.push({
            v: TURN_INDEX_VERSION,
            op: "turn",
            turn: {
              turnIndex: boundary.turnIndex,
              entryId: boundary.id,
              entryIndex: this._log.indexOf(boundary),
              kind,
              preview: preview || `(turn ${boundary.turnIndex})`,
              timestamp: boundary.timestamp,
            },
          });
        }
      }
      for (const mutation of this._collectTurnMutations(turnIndex)) {
        ops.push({ v: TURN_INDEX_VERSION, op: "mutation", mutation });
      }
    }

    const nextSeq = beforeSeq + records.length;
    if (current && appendTurnIndex(dir, beforeSeq, ops, nextSeq)) {
      this._turnIndexDirty = false;
      return true;
    }
    // 索引缺失：短会话在增量提交后直接自建；未知语义导致的 stale 仍保持失败，
    // 由下一次回退读取触发权威重建，避免把无法证明的 patch 当作已同步。
    if (
      !stale
      && this._historyStartOffset === null
      && this._log.length <= TURN_INDEX_AUTOCREATE_MAX_ENTRIES
    ) {
      try {
        const data = buildTurnIndex(this._log, this._loadArchivedTurnInfo(), this._loadArchivedMutations());
        writeTurnIndex(dir, data, nextSeq);
        this._turnIndexDirty = false;
        return true;
      } catch {
        // 索引是可选加速；失败不影响日志。
      }
    }
    this._turnIndexDirty = true;
    return false;
  }

  /** 快照后直接构建索引：快照已是 O(n)，避免下次回退菜单整读重建。 */
  private _writeTurnIndexAfterSnapshot(dir: string, sourceSeq: number): boolean {
    try {
      const sourceEntries = this._historyStartOffset === null
        ? this._log
        : this._loadFullHistoryEntries();
      const entries = sourceEntries.filter((entry) => shouldPersistEntry(entry));
      const data = buildTurnIndex(entries, this._loadArchivedTurnInfo(), this._loadArchivedMutations());
      writeTurnIndex(dir, data, sourceSeq);
      this._turnIndexDirty = false;
      return true;
    } catch {
      // 索引是可选加速；失败时删除旧索引，下次读取重建。
      deleteTurnIndex(dir);
      this._turnIndexDirty = true;
      return false;
    }
  }

  /** 最近一个未被丢弃的 turn 边界（turn_start / input_received）。 */
  private _findTurnBoundaryEntry(turnIndex: number): LogEntry | undefined {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.turnIndex !== turnIndex || entry.discarded) continue;
      if (entry.type === "input_received" || entry.type === "turn_start") return entry;
    }
    return undefined;
  }

  /** 某 turn 内仍在内存中的文件变更摘要。 */
  private _collectTurnMutations(turnIndex: number): TurnIndexMutation[] {
    const mutations: TurnIndexMutation[] = [];
    for (const entry of this._log) {
      if (entry.type !== "tool_result" || entry.discarded || entry.turnIndex !== turnIndex) continue;
      const meta = entry.meta as Record<string, unknown>;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const live = toolMeta?.fileMutation as { path?: unknown; additions?: unknown; deletions?: unknown } | undefined;
      if (typeof live?.path !== "string") continue;
      mutations.push({
        entryId: entry.id,
        turnIndex,
        path: live.path,
        additions: typeof live.additions === "number" ? live.additions : 0,
        deletions: typeof live.deletions === "number" ? live.deletions : 0,
        reverted: meta.fileMutationReverted === true,
      });
    }
    return mutations;
  }

  /** 构建回退计划（见 RewindEngine.planRewind）。 */
  async planRewind(fromTurnIndex: number): Promise<RewindPlan> {
    const materialized = this._materializeFullHistory();
    if (!materialized.ok) throw new Error(materialized.error);
    const restoreArchivedMeta = await this._installArchivedMetaAsync(fromTurnIndex);
    try {
      return await this._rewindEngine.planRewind(fromTurnIndex);
    } finally {
      restoreArchivedMeta();
    }
  }

  /**
   * 仅回退对话：从给定回合起截断日志。
   */
  rewindConversation(toTurnIndex: number): { removed: number; error?: string } {
    if (this._turnInFlight) {
      return { removed: 0, error: "Cannot rewind while a turn is in progress." };
    }

    const materialized = this._materializeFullHistory();
    if (!materialized.ok) {
      return { removed: 0, error: materialized.error };
    }

    const cutoff = this._log.findIndex(
      (e) => e.turnIndex >= toTurnIndex && (e.type === "input_received" || e.type === "turn_start") && !e.discarded,
    );
    if (cutoff < 0) {
      return { removed: 0, error: `Turn ${toTurnIndex} not found in log.` };
    }

    const removed = this._log.length - cutoff;
    const removedEntries = this._log.slice(cutoff);
    // 先恢复被撤销的归档，再截断。归档缺失/损坏时不能在内存里先砍日志，
    // 否则用户会看到“回退失败但历史已丢”的半完成状态。
    try {
      this._restoreArchivesRescindedBy(removedEntries);
    } catch (error) {
      return {
        removed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this._killChildSessionsAndShells();
    // 网关负责截断、失效索引并记录 truncate。
    this._logStore.truncateFrom(removedEntries[0]!.id);
    if (this._usageBase) {
      // 回退移除的 token_update 若计入过基线，必须同步扣减，避免累计用量虚高。
      for (const entry of removedEntries) {
        if (entry.type !== "token_update" || !this._usageBaseIds.has(entry.id)) continue;
        const contribution = tokenUpdateContribution(entry);
        if (!contribution) continue;
        this._usageBase.input -= contribution.input;
        this._usageBase.output -= contribution.output;
        this._usageBase.cacheRead -= contribution.cacheRead;
        this._usageBaseIds.delete(entry.id);
      }
      this._usageBaseVersion += 1;
      this._usageStatsCache = null;
    }
    this._resetAfterRewind();
    return { removed };
  }

  /**
   * 回退截断可能删掉 summary 条目或 compact marker，而被它们覆盖的
   * 压缩前条目内容已归档到磁盘。回退后这些条目重新成为 live 上下文，
   * 但 API 投影会静默跳过 content 为 null 的归档条目 —— 因此必须从
   * 归档文件恢复其内容，否则复活后的窗口会出现空洞。
   * 归档缺失或损坏按硬失败处理：静默回退会让用户的文件与上下文对不上。
   */
  private _restoreArchivesRescindedBy(removedEntries: LogEntry[]): void {
    const sessionDir = this._store?.sessionDir as string | undefined;
    if (!sessionDir) return;
    // 没有 archived 条目就没有需要复活的冷区；旧测试/未压缩窗口不应被强制要求 archive。
    if (!this._log.some((entry) => entry.archived)) return;
    for (const entry of removedEntries) {
      if (entry.discarded) continue;
      let fileName: string | null = null;
      if (entry.type === "summary") {
        fileName = `summary-${entry.id}.json.gz`;
      } else if (entry.type === "compact_marker") {
        const meta = entry.meta as Record<string, unknown>;
        const archiveFile = meta["archiveFile"];
        if (typeof archiveFile === "string" && archiveFile.length > 0) {
          fileName = archiveFile;
        }
      }
      if (!fileName) continue;
      let archived: ReturnType<typeof loadArchiveFile>;
      try {
        archived = loadArchiveFile(sessionDir, fileName);
      } catch (error) {
        throw new Error(
          `Cannot rewind: archive '${fileName}' is corrupt or unreadable (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
      if (!archived) {
        throw new Error(
          `Cannot rewind: archive '${fileName}' is missing; the revived context would contain holes.`,
        );
      }
      this._logStore.restoreArchivedEntries(archived);
    }
  }

  /**
   * 仅回退文件：应用反向补丁，并把 mutation 标记为已回退。
   * 不截断对话日志。
   */
  async rewindFiles(plan: RewindPlan): Promise<RewindApplyResult> {
    if (this._turnInFlight) {
      return { revertedPaths: [], conflictPaths: [], bashReverted: [], bashSkipped: [], error: "Cannot rewind while a turn is in progress." };
    }

    const restoreArchivedMeta = await this._installArchivedMetaAsync(plan.fromTurnIndex);
    let result: RewindApplyResult;
    try {
      result = await this._rewindEngine.applyFiles(plan);
    } finally {
      restoreArchivedMeta();
    }
    if (!result.error) {
      this._bumpLogRevision();
      this._notifyLogListeners();
      this.onSaveRequest?.();
    }
    return result;
  }

  /**
   * 同时回退对话与文件。
   */
  async rewindBoth(
    toTurnIndex: number,
    plan: RewindPlan,
  ): Promise<RewindApplyResult & { removed: number }> {
    const fileResult = await this.rewindFiles(plan);
    if (fileResult.error) {
      return { ...fileResult, removed: 0 };
    }
    const convResult = this.rewindConversation(toTurnIndex);
    return { ...fileResult, removed: convResult.removed, error: convResult.error };
  }

  private _killChildSessionsAndShells(): void {
    if (this._childSessions.size > 0) {
      this._archiveAllChildSessions();
    }
    if (this._shellManager.hasTrackedShells()) {
      this._forceKillAllShells();
    }
  }

  private _resetAfterRewind(): void {
    const log = this._log;
    this._turnCount = log.length > 0 ? (log[log.length - 1]?.turnIndex ?? 0) : 0;
    this._idAllocator.restoreFrom(log);

    this._compactInProgress = false;
    this._agentState = "idle";
    this._inbox = [];
    this._activeAsk = null;
    this._pendingTurnState = null;
    this._activeLogEntryId = null;
    this._lastTurnEndStatus = null;
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    this._cachedSummary = undefined;

    this._usedContextIds.clear();
    this._compactCount = 0;
    this._workCount = 0;
    // 让「会话已开始」标志与回退后的日志保持一致：若回退删光了所有真实
    // 用户消息，就必须重新屏蔽可用性通知。
    this._conversationStarted = this._entriesHaveRealUserMessage(log);
    for (const entry of log) {
      const ctx = (entry.meta as Record<string, unknown>)?.["contextId"];
      if (typeof ctx === "string") this._usedContextIds.add(ctx);
      if (entry.type === "compact_marker" && !entry.discarded) {
        const raw = (entry.meta as Record<string, unknown>)["compactIndex"];
        const index = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw + 1 : 1;
        this._compactCount = Math.max(this._compactCount, index);
      }
      if (entry.type === "work_start" && !entry.discarded) {
        this._workCount += 1;
      }
    }
    this._autoCompactCountThisTurn = 0;

    this._bumpLogRevision();
    this._notifyLogListeners();
    this.onSaveRequest?.();
  }

  /**
   * 会话恢复时检查并修复崩溃的回退。
   */
  recoverRewindIfNeeded(): boolean {
    const recovered = this._rewindEngine.recoverJournalIfNeeded();
    if (!recovered) return false;
    let saved = false;
    try {
      saved = this.onSaveRequest?.() === true;
    } catch {
      // 保留恢复日志，直到后续保存确认日志状态。
    }
    if (saved) this._rewindEngine.finalizeJournal();
    return true;
  }

  /** 调用方保存日志后，把回退事务标记为完成。 */
  finalizeRewindJournal(): void {
    this._rewindEngine.finalizeJournal();
  }

  /**
   * 从已加载的日志恢复会话。
   */
  prepareRestoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    _idAllocator: LogIdAllocator,
    opts?: { bounded?: boolean },
  ): PreparedSessionRestore {
    // 旧文件没有 policy 标记：下一次保存做一次快照归一化，应用 M0/M1。
    this._needsPersistenceNormalization = meta.persistencePolicy !== 3;
    return prepareRestoreFromLog(this, meta, entries, _idAllocator, opts);
  }

  commitPreparedRestore(prepared: PreparedSessionRestore): string[] {
    return commitPreparedRestore(this, prepared);
  }

  restoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    idAllocator: LogIdAllocator,
  ): void {
    restoreFromLog(this, meta, entries, idAllocator);
  }

  /** 对解析好的恢复数据做一次性赋值（此处没有失败分支）。 */
  _applyRestoredState(state: RestoredSessionState): void {
    this.primaryAgent.replaceModelConfig({ ...state.modelConfig });
    this._persistedModelSelection = { ...state.persistedModelSelection };

    this._log = state.entries;
    // 恢复的日志里已有真实用户消息，说明会话已开始 —— 恢复后切换
    // MCP/技能应正常排队通知。在此处写入该标志（恢复的唯一提交点）。
    this._conversationStarted = this._entriesHaveRealUserMessage(state.entries);
    // 不要重置日志 revision —— 它是瞬时的变更检测计数器，在*本*会话上
    // 必须保持单调递增，这样 UI 订阅者（shouldSyncTranscript）才能
    // 始终检测到日志替换。
    this._idAllocator = state.idAllocator;
    this._turnCount = state.turnCount;
    this._workCount = state.workCount;
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    this._compactCount = state.compactCount;
    this._preferredThinkingLevel = state.preferredThinkingLevel;
    this._thinkingLevel = state.thinkingLevel;
    this._createdAt = state.createdAt;
    this._initialModel = state.initialModel;
    // 普通 resume 必须继承原 key；缺失时保留本进程生成的 key，
    // 并在下一次保存时写入磁盘，从此稳定。
    if (state.promptCacheAffinityKey) {
      this._promptCacheKey = state.promptCacheAffinityKey;
    }
    this._title = state.title;
    this._cachedSummary = state.cachedSummary;
    this._usedContextIds = new Set(state.usedContextIds);
    this._lastInputTokens = state.lastInputTokens;
    this._lastTotalTokens = state.lastTotalTokens;
    this._lastCacheReadTokens = state.lastCacheReadTokens;
    this._cacheSupported = state.cacheSupported;
    this._usageBase = state.usageBase
      ? { input: state.usageBase.input, output: state.usageBase.output, cacheRead: state.usageBase.cacheRead }
      : null;
    this._usageBaseIds = new Set(state.usageBase?.ids ?? []);
    this._usageFirstInput = state.firstInput;
    this._usageFirstUserMessageTokens = state.firstUserMessageTokens;
    this._usageBaseVersion += 1;
    this._usageStatsCache = null;
    this._lifetimeToolCallCount = state.signals.lifetimeToolCallCount;
    this._lastToolCallSummary = state.signals.lastToolCallSummary;
    this._recentSessionEvents = [...state.signals.recentSessionEvents];
    this._lastTurnEndStatus = state.signals.lastTurnEndStatus;
    this._selfPhase = state.signals.selfPhase;
    this._activeLogEntryId = null;
    // 解析出的恢复数据不含 live 的 ask/回合状态：未关闭的 ask 在解析时
    // 已按拒绝处理，被中断的回合也已规范化。
    this._activeAsk = null;
    this._askHistory = state.askHistory;
    this._agentState = "idle";
    this._inbox = [];
    this._pendingTurnState = null;
  }

  private _normalizeInterruptedTurnFromLog(message: string): void {
    normalizeInterruptedTurnInLog(this._logSurgeryView(), message, (ids, flags) => {
      this._logStore.patchFlags(ids, flags);
    });
  }

  /**
   * 获取用于持久化的日志数据（v2）。
   * 返回适合交给 persistToDisk() 的 meta + 条目。
   */
  getLogForPersistence(): { meta: LogSessionMeta; entries: readonly LogEntry[] } {
    return getLogForPersistence(this);
  }

  /** 根会话用 store.sessionDir；子会话没有 store，artifacts 的父目录即会话目录。 */
  private _resolvePersistDir(): string | undefined {
    const storeDir = this._store?.sessionDir;
    if (storeDir) return storeDir;
    return this._sessionArtifactsOverride ? dirname(this._sessionArtifactsOverride) : undefined;
  }

  /** 归档 envelope 已包含 presentation 索引；只剥离已被归档且滑出活动窗口的条目。 */
  private _refreshPersistenceStripIds(): void {
    const dir = this._resolvePersistDir();
    if (dir) {
      const archiveDir = join(dir, "archive");
      let count = -1;
      try {
        count = readdirSync(archiveDir).filter((name) => name.startsWith("window-") && name.endsWith(".jsonl.gz")).length;
      } catch { /* no archive yet */ }
      if (!this._presentationArchiveIds || count !== this._presentationArchiveCount) {
        this._presentationArchiveIds = loadPresentationCapableEntryIds(dir);
        this._presentationArchiveCount = count;
      }
    }

    const capable = this._presentationArchiveIds ?? new Set<string>();
    const stripIdx = this._logStore.activeWindowStartIdx() - 1;
    const ids = new Set<string>();
    if (stripIdx >= 0) {
      for (let i = 0; i <= stripIdx; i++) {
        const entry = this._log[i];
        if (entry.archived && capable.has(entry.id)) ids.add(entry.id);
      }
    }
    this._persistenceStripIds = ids;
  }

  /** M1：sidecar 只保留仍在日志里内联的 reasoningState，或已加载的引用。 */
  private _pruneSealedSidecars(dir: string): void {
    const live = new Set<string>();
    for (const entry of this._log) {
      if (this._persistenceStripIds.has(entry.id)) continue;
      const state = (entry.meta as Record<string, unknown>)["reasoningState"];
      if (isSealedRef(state)) {
        const name = state.sealedRef.split("/").pop() ?? "";
        if (name.endsWith(".json.gz")) live.add(name.slice(0, -".json.gz".length));
      } else if (
        state !== undefined
        && Buffer.byteLength(JSON.stringify(state), "utf8") >= SEALED_INLINE_BUDGET_BYTES
      ) {
        live.add(entry.id);
      }
    }
    pruneSealed(dir, live);
  }

  private _prepareEntryForPersistence(entry: LogEntry): LogEntry | null {
    if (!shouldPersistEntry(entry)) return null;
    if (this._persistenceStripIds.has(entry.id)) {
      return stripEntryForPersistence(entry);
    }
    const dir = this._resolvePersistDir();
    if (!dir) return entry;

    const prepared = capPersistedEntry(entry, { sessionDir: dir });
    const meta = prepared.meta as Record<string, unknown>;
    const state = meta["reasoningState"];
    if (state !== undefined && !isSealedRef(state)) {
      // 外置后投影无法再从 reasoningState 反推 artifact，必须在写入前物化。
      const artifact = normalizeThinkingArtifact(meta["thinkingArtifact"])
        ?? inferThinkingArtifact(prepared.content, state);
      if (artifact) meta["thinkingArtifact"] = artifact;
      const ref = maybeExternalizeReasoning(dir, prepared.id, state);
      if (ref) meta["reasoningState"] = ref;
    }
    return prepared;
  }

  /** M1：投影期解析 sealedRef；失败返回 null，不抛错。 */
  _resolveSealedReasoningState(value: unknown): unknown | null {
    if (!isSealedRef(value)) return value;
    const dir = this._resolvePersistDir();
    if (!dir) return null;

    const key = value.sealedRef;
    const cached = this._sealedStateCache.get(key);
    if (cached) {
      this._sealedStateCache.delete(key);
      this._sealedStateCache.set(key, cached);
      return cached.value;
    }

    const resolved = readSealed(dir, value);
    if (resolved === null) return null;
    const bytes = Math.max(0, value.bytes);
    this._sealedStateCache.set(key, { value: resolved, bytes });
    this._sealedStateCacheBytes += bytes;
    while (this._sealedStateCacheBytes > 4 * 1024 * 1024 && this._sealedStateCache.size > 1) {
      const oldest = this._sealedStateCache.keys().next().value as string;
      const removed = this._sealedStateCache.get(oldest);
      this._sealedStateCache.delete(oldest);
      this._sealedStateCacheBytes -= removed?.bytes ?? 0;
    }
    return resolved;
  }

  getPersistenceStatus(): { dirty: boolean; failure: string | null } {
    return { dirty: this._persistenceDirty, failure: this._persistenceFailure };
  }

  /**
   * 运行期持久化：log.jsonl 追加增量；首次保存写快照；legacy 先迁移。
   * 返回 false 表示没有完成全部辅助持久化步骤。
   */
  persistToDisk(): boolean {
    const dir = this._resolvePersistDir();
    if (!dir) {
      this._persistenceDirty = true;
      this._persistenceFailure = "session directory is unavailable";
      return false;
    }

    let data: ReturnType<typeof getLogForPersistence>;
    try {
      data = getLogForPersistence(this);
      this._refreshPersistenceStripIds();
    } catch (error) {
      this._persistenceDirty = true;
      this._persistenceFailure = error instanceof Error ? error.message : String(error);
      return false;
    }
    const jsonlPath = join(dir, LOG_JSONL_FILENAME);
    const writeSnapshot = (): boolean => {
      try {
        const stats = this._computeUsageStats();
        const snapshot = writeLogJsonlSnapshot(
          dir,
          data.meta,
          data.entries,
          (entry) => this._prepareEntryForPersistence(entry),
          {
            input: stats.cumulativeInput,
            output: stats.cumulativeOutput,
            cacheRead: stats.cumulativeCacheRead,
          },
        );
        this._logStore.markPersisted(
          data.entries.filter((entry) => shouldPersistEntry(entry)).map((entry) => entry.id),
        );
        this._logStore.commitPendingRecords();
        const indexOk = this._writeTurnIndexAfterSnapshot(dir, snapshot.nextSeq - 1);
        const sidecarsOk = saveSessionSidecars(dir, data.meta);
        let sealedOk = true;
        try {
          this._pruneSealedSidecars(dir);
        } catch (error) {
          sealedOk = false;
          this._persistenceFailure = error instanceof Error ? error.message : String(error);
        }
        const ok = indexOk && sidecarsOk && sealedOk;
        this._persistenceDirty = !ok;
        this._persistenceFailure = ok
          ? null
          : this._persistenceFailure ?? `snapshot auxiliary persistence failed (index=${indexOk}, sidecars=${sidecarsOk}, sealed=${sealedOk})`;
        this._needsPersistenceNormalization = false;
        return ok;
      } catch (error) {
        this._persistenceDirty = true;
        this._persistenceFailure = error instanceof Error ? error.message : String(error);
        return false;
      }
    };

    try {
      if (!existsSync(jsonlPath)) {
        // 新会话：一次写入 header + 全部条目；之后只追加。
        if (!existsSync(join(dir, "log.json"))) return writeSnapshot();
        migrateLogToJsonl(dir);
      }
      // 旧 JSONL/legacy 会话：首次保存重写一次，应用 M0/M1。
      if (this._needsPersistenceNormalization) return writeSnapshot();
    } catch (error) {
      this._persistenceDirty = true;
      this._persistenceFailure = error instanceof Error ? error.message : String(error);
      return false;
    }

    let lastSeq: number;
    try {
      lastSeq = readLastSeq(dir);
    } catch (error) {
      this._persistenceDirty = true;
      this._persistenceFailure = error instanceof Error ? error.message : String(error);
      return false;
    }
    if (lastSeq === 0) throw new Error("log.jsonl has no session header");
    const records = this._logStore.peekPendingRecords(lastSeq + 1);
    const hasCompactMarker = records.some(recordHasCompactMarker);
    if (hasCompactMarker) {
      const stats = this._computeUsageStats();
      records.push({
        v: LOG_JSONL_VERSION,
        op: "usage",
        seq: lastSeq + records.length + 1,
        ts: new Date().toISOString(),
        totals: {
          input: stats.cumulativeInput,
          output: stats.cumulativeOutput,
          cacheRead: stats.cumulativeCacheRead,
        },
      });
    }
    let indexOk = !this._turnIndexDirty;
    if (records.length > 0) {
      try {
        appendRecords(dir, records);
      } catch (error) {
        this._persistenceDirty = true;
        this._persistenceFailure = error instanceof Error ? error.message : String(error);
        throw error;
      }
      this._logStore.commitPendingRecords();
      indexOk = this._updateTurnIndexAfterAppend(dir, lastSeq, records);
    } else if (this._turnIndexDirty) {
      indexOk = this._writeTurnIndexAfterSnapshot(dir, lastSeq);
    }
    const sidecarsOk = saveSessionSidecars(dir, data.meta);
    let sealedOk = true;
    try {
      this._pruneSealedSidecars(dir);
    } catch (error) {
      sealedOk = false;
      this._persistenceFailure = error instanceof Error ? error.message : String(error);
    }
    const ok = indexOk && sidecarsOk && sealedOk;
    this._persistenceDirty = !ok;
    this._persistenceFailure = ok
      ? null
      : this._persistenceFailure ?? `incremental auxiliary persistence failed (index=${indexOk}, sidecars=${sidecarsOk}, sealed=${sealedOk})`;
    this._needsPersistenceNormalization = false;
    return ok;
  }

  setStore(store: any): void {
    this._store = store;
    // 路径不再进入 system snapshot，绑定 store 不触发提示词重建。
  }

  /**
   * /new 的完整重置 —— 等价于新建一个 Session。
   * 不绑定存储；session/artifacts 目录在后续首个回合才惰性创建。
   */
  async resetForNewSession(newStore?: any): Promise<void> {
    // 0. 重置前先终止进行中的回合
    this.requestTurnInterrupt();
    await this.waitForTurnComplete();

    // 1. 杀掉活跃子代理，重置瞬时标志
    this._resetTransientState();
    this._resetHookContextForNewSession();

    // 2. 先更新 store（让路径解析取到新会话）
    if (newStore !== undefined) {
      this._store = newStore;
    }

    // 3. 重置计数器
    this._turnCount = 0;
    this._workCount = 0;
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    this._compactCount = 0;
    this._usedContextIds = new Set<string>();

    // 4. 重置思考状态
    this._thinkingLevel = this._preferredThinkingLevel || "off";

    // 5. 重置 MCP 连接标志（下个回合会重连）
    this._mcpConnected = false;

    // 6. 丢弃内存中的任务清单。文件留在旧会话目录里
    // （每个会话有自己的 tasks.json）。
    this._taskStoreRef = undefined;
    this._taskStoreKey = undefined;
    if (this._taskListeners.length > 0) this._notifyTaskListeners();

    // 7. /new 必须从全新的会话树开始。_resetTransientState() 会归档现有
    // 子会话，以便拆除前保存；但这些归档句柄不能泄漏进下一个根会话的持久化 meta。
    this._childSessionManagerInstance.clearTables();

    // 8. 最后再重新初始化对话（全新会话状态，存储仍可保持惰性）
    // _initConversation 同时会重置 _log 与 _idAllocator
    this._initConversation();
    this._displayCutoff = 0;
  }

  private _buildToolExecutors(): Record<string, ToolExecutor> {
    return buildToolExecutors({
      projectRoot: this._projectRoot,
      getSessionArtifactsDir: () => this._resolveSessionArtifacts(),
      supportsMultimodal: this.primaryAgent.modelConfig.supportsMultimodal,
      commExecutors: {
        bash_background: (args) => this._shellManager.execBashBackground(args),
        kill_shell: (args) => this._shellManager.execKillShell(args),
        spawn: (args) => this._execSpawn(args),
        kill_agent: (args) => this._execKillAgent(args),
        check_status: (args) => this._execCheckStatus(args),
        await_event: () => this._execAwaitEvent(),
        ask: (args) => this._execAsk(args),
        skill: (args) => this._execSkill(args),
        send: (args) => this._execSend(args),
        $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
      },
      taskExecutors: {
        task_create: (args) => this._execTaskCreate(args),
        task_list: () => this._execTaskList(),
        task_get: (args) => this._execTaskGet(args),
        task_update: (args) => this._execTaskUpdate(args),
        task_resume: (args) => this._execTaskResume(args),
      },
      overrides: this._toolExecutorOverrides,
      onFileWrite: undefined,
      getApprovedExternalPrefixes: () => {
        if (this._permissionAdvisor.sessionMode === "yolo") return ["/"];
        return this._permissionRuleStore.getApprovedExternalPrefixes();
      },
      adoptShell: (req) => {
        const entry = this._shellManager.adoptRunningProcess(req);
        return { id: entry.id, logPath: entry.logPath };
      },
      hasTools: (name) => this._hasTool(name),
    });
  }

  /** 本会话是否拥有某个工具（提示文案按真实能力分支时使用）。 */
  private _hasTool(name: string): boolean {
    return this.primaryAgent.tools.some((tool) => tool.name === name);
  }

  private _ensureCommTools(): void {
    ensureCommTools(this.primaryAgent.tools, this._capabilities);
  }

  // ==================================================================
  // 技能
  // ==================================================================

  /** 已加载技能的只读访问（供命令注册使用）。 */
  /** 已加载技能的只读访问（供命令注册使用）。 */
  get skills(): ReadonlyMap<string, SkillMeta> {
    return getSkills(this);
  }

  // ==================================================================
  // 子代理内省（供 TUI/GUI 使用）
  // ==================================================================

  getAgentLog(agentId: string): readonly LogEntry[] | null {
    // 与 getChildSessionLog 同一条路径 —— manager 会从磁盘读取
    // 已释放子会话的日志。
    return this.getChildSessionLog(agentId);
  }

  getActiveAgentIds(): Array<{ id: string; status: string; interactive: boolean }> {
    const result: Array<{ id: string; status: string; interactive: boolean }> = [];
    for (const snapshot of this.getChildSessionSnapshots()) {
      const status = snapshot.running
        ? "working"
        : snapshot.lifecycle === "blocked"
          ? "waiting"
          : snapshot.lifecycle === "running"
            ? "working"
            : snapshot.lifecycle;
      result.push({
        id: snapshot.id,
        status,
        interactive: snapshot.mode === "persistent",
      });
    }
    return result;
  }

  get mcpManager(): MCPClientManager | undefined {
    return getMcpManager(this);
  }

  async ensureMcpReady(): Promise<void> {
    return ensureMcpReady(this);
  }

  /** 已禁用技能名称的只读访问。 */
  /** 已禁用技能名称的只读访问。 */
  get disabledSkills(): ReadonlySet<string> {
    return getDisabledSkills(this);
  }

  /**
   * 返回磁盘上的全部技能（含启用与禁用），供 UI 展示。
   */
  /**
   * 返回磁盘上的全部技能（含启用与禁用），供 UI 展示。
   */
  getAllSkillNames(): { name: string; description: string; enabled: boolean }[] {
    return getAllSkillNames(this);
  }

  /** 是否存在尚未通过 /reload 应用的 skill 变更。 */
  /** 是否存在尚未通过 /reload 应用的 skill 变更。 */
  get skillsDirty(): boolean {
    return skillsDirty(this);
  }

  /** 按名称启用或禁用技能。调用 applySkillsFromCommand() 使其生效。 */
  /** 按名称启用或禁用技能。调用 applySkillsFromCommand() 使其生效。 */
  setSkillEnabled(name: string, enabled: boolean): void {
    setSkillEnabled(this, name, enabled);
  }

  /**
   * 重扫技能目录，应用禁用过滤，并重建 skill 工具定义。
   * /skills 会立即调用；/reload 也会在完整重载配置时调用。
   * 返回变更报告，供需要的调用方使用。
   */
  /**
   * 重扫技能目录，应用禁用过滤，并重建 skill 工具定义。
   * /skills 会立即调用；/reload 也会在完整重载配置时调用。
   * 返回变更报告，供需要的调用方使用。
   */
  reloadSkills(): { added: string[]; removed: string[]; total: number } {
    return reloadSkills(this);
  }

  /**
   * 构建固定的 `skill` 工具定义。
   *
   * skills 列表位于 system prompt；工具的 description 不随 skills 集合变化，
   * 从而保持 tools 段字节稳定。
   */
  /**
   * 构建固定的 `skill` 工具定义。
   *
   * skills 列表位于 system prompt；工具的 description 不随 skills 集合变化，
   * 从而保持 tools 段字节稳定。
   */
  private _ensureSkillTool(): void {
    ensureSkillToolForSession(this);
  }

  /**
   * 从磁盘刷新技能。在提示词/工具重载时调用，使新增、移除或修改的技能
   * 更新动态的 skill 工具定义。
   */
  /**
   * 从磁盘刷新技能。在提示词/工具重载时调用，使新增、移除或修改的技能
   * 更新动态的 skill 工具定义。
   */
  private _refreshSkills(): void {
    refreshSkills(this);
  }

  /** 执行 `skill` 工具 —— 加载并返回技能说明。 */
  /** 执行 `skill` 工具 —— 加载并返回技能说明。 */
  private _execSkill(
    args: Record<string, unknown>,
  ): ToolResult {
    return execSkill(this, args);
  }

  // ==================================================================
  // 共享辅助
  // ==================================================================

  _sortedUnique(values: Iterable<string | undefined | null>): string[] {
    return [...new Set([...values].filter((v): v is string => typeof v === "string" && v.length > 0))]
      .sort((a, b) => a.localeCompare(b));
  }

  /** 一次性扫描辅助：给定条目中是否含已投递的真实用户消息？
   * 仅在恢复时用于初始化 _conversationStarted —— 实时守卫读的是缓存标志。 */
  _entriesHaveRealUserMessage(entries: Iterable<LogEntry>): boolean {
    for (const entry of entries) {
      if (entry.discarded || entry.type !== "user_message") continue;
      if ((entry.meta as Record<string, unknown>)["inputKind"] === "user") {
        return true;
      }
    }
    return false;
  }

  _diffNames(before: Iterable<string>, after: Iterable<string>): { added: string[]; removed: string[] } {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    return {
      added: this._sortedUnique([...afterSet].filter((name) => !beforeSet.has(name))),
      removed: this._sortedUnique([...beforeSet].filter((name) => !afterSet.has(name))),
    };
  }

  _snapshotMcpAvailability(): McpAvailabilitySnapshot {
    return snapshotMcpAvailability(this);
  }

  _queueToolAvailabilityNotice(notice: ToolAvailabilityNotice): void {
    queueToolAvailabilityNotice(this, notice);
  }

  /**
   * 按设置重载 MCP 服务器：读取全局与本地设置，重新配置
   * MCPClientManager，并通知 TUI。返回人类可读的变更摘要。
   */
  /**
   * 按设置重载 MCP 服务器：读取全局与本地设置，重新配置
   * MCPClientManager，并通知 TUI。返回人类可读的变更摘要。
   */
  async reloadMcp(options?: { notice?: boolean; reason?: string }): Promise<string> {
    return reloadMcp(this, options);
  }

  async reconnectMcpServer(serverName: string): Promise<boolean> {
    return reconnectMcpServer(this, serverName);
  }

  // 面向命令的 MCP 变更：先拿回合锁，避免 connect/disconnect（以及它排队的
  // 随行通知）与回合的工具快照重叠。reloadMcp/reconnectMcpServer 刻意保持
  // 无锁 —— 需要它们的重载路径要么跑在回合的工具执行里，要么已被命令侧的
  // _withTurnLock 包住，而 _withTurnLock 不可重入，再锁一次会死锁。
  // 面向命令的 MCP 变更：先拿回合锁，避免 connect/disconnect（以及它排队的
  // 随行通知）与回合的工具快照重叠。reloadMcp/reconnectMcpServer 刻意保持
  // 无锁 —— 需要它们的重载路径要么跑在回合的工具执行里，要么已被命令侧的
  // _withTurnLock 包住，而 _withTurnLock 不可重入，再锁一次会死锁。
  async reloadMcpFromCommand(reason: string): Promise<string> {
    return reloadMcpFromCommand(this, reason);
  }

  async reconnectMcpServerFromCommand(serverName: string): Promise<boolean> {
    return reconnectMcpServerFromCommand(this, serverName);
  }

  // /mcp 命令在展示选择器前会预热 MCP 状态。该 ensure 可能连接服务器
  // （修改 agent.tools），因此必须像 reload/reconnect 变体一样与回合串行化 ——
  // 命令侧的 MCP 连接工作不能与回合的工具快照并发。
  // /mcp 命令在展示选择器前会预热 MCP 状态。该 ensure 可能连接服务器
  // （修改 agent.tools），因此必须像 reload/reconnect 变体一样与回合串行化 ——
  // 命令侧的 MCP 连接工作不能与回合的工具快照并发。
  async ensureMcpReadyFromCommand(): Promise<void> {
    return ensureMcpReadyFromCommand(this);
  }

  /**
   * 用户显式重载（/reload 命令）的唯一实现。
   *
   * 历史上还有一个 `reload` 工具把同一函数暴露给模型，已移除：重载会重建
   * system prompt 并使会话的提示缓存前缀失效，这必须由用户显式触发。此函数
   * 现在只经由 reloadConfigurationFromCommand() 到达，因此调用方负责持锁。
   */
  private async _execReload(): Promise<string> {
    const report: string[] = [];

    // 1. 重载技能与 system prompt
    const skillResult = this.reloadSkills();
    report.push(
      `Skills: ${skillResult.total} loaded` +
      (skillResult.added.length ? `, +${skillResult.added.join(", ")}` : "") +
      (skillResult.removed.length ? `, -${skillResult.removed.join(", ")}` : ""),
    );

    // 2. 重建 system prompt
    this._rebuildSystemPrompt();
    report.push("System prompt: rebuilt");

    // 3. 重载 MCP
    const mcpBefore = this._snapshotMcpAvailability();
    try {
      report.push(await this.reloadMcp({
        notice: false,
        reason: "the /reload command refreshed MCP configuration",
      }));
    } catch (err) {
      report.push(`MCP: reload failed —${err instanceof Error ? err.message : String(err)}`);
    }
    const mcpAfter = this._snapshotMcpAvailability();
    const mcpServerDiff = this._diffNames(mcpBefore.servers, mcpAfter.servers);
    const mcpToolDiff = this._diffNames(mcpBefore.tools, mcpAfter.tools);

    this._queueToolAvailabilityNotice({
      reason: "the /reload command refreshed skills, MCP servers, and the system prompt",
      skillsAdded: skillResult.added,
      skillsRemoved: skillResult.removed,
      mcpServersConnected: mcpServerDiff.added,
      mcpServersDisconnected: mcpServerDiff.removed,
      mcpToolsAdded: mcpToolDiff.added,
      mcpToolsRemoved: mcpToolDiff.removed,
    });

    return report.join("\n");
  }

  /**
   * 用户显式重载（/reload 命令）的入口。
   *
   * 这是重载的唯一用户入口；通过 turn lock 串行化，避免 skill/MCP 变更与
   * 活动回合的工具快照重叠。模型侧不存在对应工具。
   */
  async reloadConfigurationFromCommand(): Promise<string> {
    return this._withTurnLock(() => this._execReload());
  }

  /**
   * /skills 的即时应用入口：重扫技能、重建 system prompt，但不重载 MCP。
   * 通过 turn lock 与活动回合串行化，避免工具/system 前缀在回合中途变化。
   */
  async applySkillsFromCommand(): Promise<{ added: string[]; removed: string[]; total: number }> {
    return this._withTurnLock(async () => {
      const result = this.reloadSkills();
      this._rebuildSystemPrompt();
      return result;
    });
  }

  // ==================================================================
  // 会话标题
  // ==================================================================

  setTitle(title: string): void {
    this._title = title || undefined;
    // 不触发 onSaveRequest —— 重命名不应更新 last_active_at。
    // 调用方（store:renameSession）会直接把标题写入磁盘。
  }

  getTitle(): string | undefined {
    return this._title;
  }

  getDisplayName(): string {
    return this._title || this._generateSummary();
  }

  // ==================================================================
  // Task list —— 存储生命周期见 ./session/task-list.ts
  // ==================================================================

  /** 当前会话的任务清单（按 id 升序）。 */
  getTaskState(): readonly Task[] {
    return getTaskState(this);
  }

  /**
   * 每个请求末尾的 ephemeral 运行时快照：open tasks / active children / shells。
   * 不写日志、不进入缓存前缀；压缩上下文不再烘静态任务快照。
   */
  _buildRuntimeStateBlock(): string {
    const tasks = getTaskState(this).filter((task) => task.status !== "completed");
    const agents = [...this._childSessions.values()]
      .filter((handle) => handle.lifecycle !== "archived" && handle.status !== "completed")
      .slice(-8);
    const shellReport = this._buildShellReport();
    const shellLines = shellReport.startsWith("No shells tracked.")
      ? []
      : shellReport.split("\n").filter((line) => line.startsWith("- ") || line.startsWith("    ")).slice(0, 12);

    if (tasks.length === 0 && agents.length === 0 && shellLines.length === 0) return "";

    const lines: string[] = [
      "[RUNTIME STATE]",
      "Read-only runtime snapshot; do not treat it as a new user request.",
    ];
    if (tasks.length > 0) {
      const snapshot = formatTaskSnapshot(tasks).replace(/^\[Current Tasks\]\n/, "");
      lines.push("Open tasks:", snapshot);
    }
    if (agents.length > 0) {
      lines.push("Active child agents:");
      for (const handle of agents) {
        const last = handle.recentEvents.length > 0
          ? `; last: ${handle.recentEvents[handle.recentEvents.length - 1]}`
          : "";
        lines.push(`- #${handle.numericId} ${handle.template} [${handle.status}/${handle.phase}]${last}`);
      }
    }
    if (shellLines.length > 0) {
      lines.push("Shells:", ...shellLines);
    }
    return lines.join("\n");
  }

  subscribeTaskState(listener: () => void): () => void {
    return subscribeTaskState(this, listener);
  }

  _notifyTaskListeners(): void {
    notifyTaskListeners(this);
  }

  _ensureTaskStore(): TaskStore {
    return ensureTaskStore(this);
  }

  private _ensureTaskTools(): void {
    ensureTaskToolsForSession(this);
  }

  getTaskPersistence(): "file" | "pending" | "memory" {
    return getTaskPersistence(this);
  }

  /**
   * 子会话 settle：把"子拆分结果"回写进对应任务的 metadata。
   *
   * 由父会话写（子不写盘），让子的拆分结果在父侧可审计、重派时有上下文。
   * 任务是按 `metadata.agentId` 关联的；子代理可能只是被 spawn 派生而未登记为任务，
   * 此时静默跳过。
   */
  private _onChildSettled(info: {
    childId: string;
    outcome: ChildOutcome;
    cause: TerminationCause;
    taskSummary?: { total: number; open: number; done: number };
    openTasks: ChildTaskHandoff[];
  }): void {
    onChildSettled(this, info);
  }

  // -- 启动对账 ------------------------------------------------------

  /**
   * 重启对账：子代理一律视为已终止，只判定"是否值得断点续跑"。
   *
   * 顺序要求：必须在子日志加载完成（`commitPreparedChildren`）之后调用 ——
   * 阈值指标（toolCalls / tokensIn）由恢复出的子会话从日志重算。
   *
   * 天然幂等：对账后不再有 `in_progress` 任务，重复调用是空操作。
   */
  reconcileTaskListAfterRestore(opts: { fork?: boolean } = {}): { warnings: string[]; notice?: string } {
    return reconcileTaskListAfterRestore(this, opts);
  }

  /**
   * 把对账结果作为"随行"系统通知放入收件箱。
   *
   * `wake: false`：不唤醒空闲会话 —— 用户刚 resume，可能只想看看；通知在下一次
   * 真实输入时随该轮送达模型，而不是立刻自动跑一轮。
   */
  deliverRestoreNotice(text: string): void {
    this._deliverMessage({
      type: "system_notice",
      sender: "system",
      content: text,
      timestamp: Date.now(),
      wake: false,
      tuiVisible: false,
    });
  }

  /** 从父日志的 agent_result 条目索引每个子代理的最终结局与终止原因。 */
  private _indexChildOutcomesFromLog(): Map<string, { outcome: ChildOutcome; cause?: TerminationCause }> {
    return indexChildOutcomesFromLog(this);
  }

  // -- 任务工具执行器 ------------------------------------------------

  // -- 任务工具执行器 ------------------------------------------------

  private _execTaskCreate(args: Record<string, unknown>): ToolResult {
    return execTaskCreate(this, args);
  }

  private _execTaskList(): ToolResult {
    return execTaskList(this);
  }

  private _execTaskGet(args: Record<string, unknown>): ToolResult {
    return execTaskGet(this, args);
  }

  private _execTaskUpdate(args: Record<string, unknown>): ToolResult {
    return execTaskUpdate(this, args);
  }

  /**
   * 断点续跑：把某个被重启打断的子代理从它自己的上下文里接着跑。
   *
   * 守卫（任一不满足即拒绝，且不消耗尝试次数）：任务存在、带可续的 resumeHint、
   * 未被新的 run 接管、尝试次数未超上限。`beginResume` 成功但子代理不可用时回滚
   * 任务状态（尝试次数保留，避免死循环）。
   */
  private _execTaskResume(args: Record<string, unknown>): ToolResult {
    return execTaskResume(this, args);
  }

  private _resumeRefusalText(reason: string): string {
    return resumeRefusalText(reason);
  }

  private _resumeChildSession(childId: string, prompt: string): { ok: boolean; reason?: string } {
    return resumeChildSession(this, childId, prompt);
  }

  /** `metadata` 参数解析：必须是普通对象；`null` 值保留（语义为删除该键）。 */
  private _argTaskMetadata(raw: unknown): Record<string, unknown> | undefined | ToolResult {
    return argTaskMetadata(raw);
  }

  // ==================================================================
  // 思考等级与缓存命中
  // ==================================================================

  get thinkingLevel(): string {
    return this._thinkingLevel;
  }

  set thinkingLevel(value: string) {
    this._preferredThinkingLevel = value;
    this._thinkingLevel = value || "off";
    this.onSaveRequest?.();
  }

  get accentColor(): string | undefined {
    return this._preferredAccentColor;
  }

  set accentColor(value: string | undefined) {
    this._preferredAccentColor = value;
  }

  /** 主 agent 配置中的模型名。 */
  get currentModelName(): string {
    return this.primaryAgent.modelConfig.model;
  }

  /** 当前模型的配置名（例如 "my-claude"）。 */
  get currentModelConfigName(): string {
    return this.primaryAgent.modelConfig.name;
  }

  /**
   * 把主 agent 切换到另一个模型配置。
   * 只能在回合之间调用（回合进行中不可调用）。
   */
  /**
   * 把主 agent 切换到另一个模型配置。
   * 只能在回合之间调用（回合进行中不可调用）。
   */
  switchModel(modelConfigName: string): void {
    switchModel(this, modelConfigName);
  }

  reloadCurrentModelConfig(): void {
    reloadCurrentModelConfig(this);
  }

  applyGlobalPreferences(preferences: GlobalTuiPreferences): void {
    applyGlobalPreferences(this, preferences);
  }

  /**
   * 应用 settings.json 中的启动设置。
   *
   * thinkingLevel 由启动解析器从 currentProvider.currentModel 取得；
   * 缺失时回退 settings.thinking_level，再回退 off。
   */
  /**
   * 应用 settings.json 中的启动设置。
   *
   * thinkingLevel 由启动解析器从 currentProvider.currentModel 取得；
   * 缺失时回退 settings.thinking_level，再回退 off。
   */
  applySettings(settings: SwarmflowSettings, opts?: { thinkingLevel?: string }): void {
    applySettings(this, settings, opts);
  }

  getGlobalPreferences(): GlobalTuiPreferences {
    return getGlobalPreferences(this);
  }

  /** 当前会话按角色保存的子代理模型配置。 */
  /** 当前会话按角色保存的子代理模型配置。 */
  getSubagentSettings(): SubagentSettings | undefined {
    return getSubagentSettings(this);
  }

  /** 保存当前会话按角色保存的子代理模型配置。 */
  /** 保存当前会话按角色保存的子代理模型配置。 */
  setSubagentSettings(settings: SubagentSettings): void {
    setSubagentSettings(this, settings);
  }

  private _invalidateProviderTokenSnapshot(): void {
    this._lastInputTokens = 0;
    this._lastTotalTokens = 0;
    this._lastCacheReadTokens = 0;
    this._cacheSupported = false;
  }

  /** 最近一次 provider 响应的输入 token 数。 */
  get lastInputTokens(): number {
    return this._lastInputTokens;
  }

  set lastInputTokens(value: number) {
    this._lastInputTokens = value;
  }

  /** 最近一次 provider 响应的总 token 数（输入 + 输出）。 */
  get lastTotalTokens(): number {
    return this._lastTotalTokens;
  }

  set lastTotalTokens(value: number) {
    this._lastTotalTokens = value;
  }

  /** 最近一次 provider 响应的缓存读取 token 数。 */
  get lastCacheReadTokens(): number {
    return this._lastCacheReadTokens;
  }

  get cacheSupported(): boolean {
    return this._cacheSupported;
  }

  set cacheSupported(value: boolean) {
    this._cacheSupported = value;
  }

  set lastCacheReadTokens(value: number) {
    this._lastCacheReadTokens = value;
  }

  // —— 累计用量统计（由日志的 token_update 条目推导） ——

  /**
   * 用 gpt-tokenizer 估算 system prompt 各段的 token 数。
   * 缓存至提示词/技能/工具重载时失效。
   */
  private _getPromptSectionEstimates(): PromptSectionEstimates {
    if (this._promptSectionEstimates) return this._promptSectionEstimates;
    this._promptSectionEstimates = estimatePromptSections({
      recipe: this.primaryAgent.promptRecipe,
      systemPrompt: this.primaryAgent.systemPrompt,
      toolDefs: this.primaryAgent.tools,
      projectRoot: this._projectRoot,
      swarmflowHomeDir: this._swarmflowHomeDir,
      skills: this._skills.values(),
    });
    return this._promptSectionEstimates;
  }

  /**
   * provider 不返回 usage 时的本地估算：活动窗口条目 + 静态前缀。
   * 按 log revision 缓存，避免每次 tool round 全扫。
   */
  _estimateContextTokens(): number {
    const revision = this._logStore.revision;
    if (this._contextEstimateCache?.revision === revision) {
      return this._contextEstimateCache.tokens;
    }
    const activeStart = Math.max(0, this._logStore.activeWindowStartIdx() - 1);
    let tokens = 0;
    for (let i = activeStart; i < this._log.length; i += 1) {
      const entry = this._log[i]!;
      if (entry.discarded || entry.archived) continue;
      tokens += estimateEntryTokens(entry);
    }
    tokens += this._estimateStaticContextTokens();
    this._contextEstimateCache = { revision, tokens };
    return tokens;
  }

  _estimateStaticContextTokens(): number {
    const est = this._getPromptSectionEstimates();
    return est.systemPrompt + est.tools + est.agentsMd + est.skills;
  }

  _estimateEphemeralTailTokens(): number {
    const runtimeState = this._buildRuntimeStateBlock();
    const hookContext = this.hookRuntime.getAdditionalContext() ?? "";
    const tail = [runtimeState, hookContext].filter(Boolean).join("\n\n");
    return tail ? gptEncode(tail).length : 0;
  }

  /**
   * 汇总日志中所有 token_update 条目，重算累计用量。
   * 按日志长度记忆化：只有追加条目（live 回合）或替换日志
   * （恢复 / 新会话）时结果才会变化。
   */
  private _computeUsageStats(): UsageStats {
    const logLen = this._log.length;
    const cached = this._usageStatsCache;
    if (cached && cached.logLen === logLen && cached.baseVersion === this._usageBaseVersion) {
      return cached.stats;
    }

    let cumulativeInput: number;
    let cumulativeOutput: number;
    let cumulativeCacheRead: number;
    if (this._usageBase) {
      // 有界恢复：meta.tokens 已包含窗口内 token_update，只追加恢复后新增的条目。
      cumulativeInput = this._usageBase.input;
      cumulativeOutput = this._usageBase.output;
      cumulativeCacheRead = this._usageBase.cacheRead;
      for (const entry of this._log) {
        if (entry.type !== "token_update" || this._usageBaseIds.has(entry.id)) continue;
        const contribution = tokenUpdateContribution(entry);
        if (!contribution) continue;
        cumulativeInput += contribution.input;
        cumulativeOutput += contribution.output;
        cumulativeCacheRead += contribution.cacheRead;
      }
    } else {
      const agg = aggregateTokenUsage(this._log);
      cumulativeInput = agg.cumulativeInput;
      cumulativeOutput = agg.cumulativeOutput;
      cumulativeCacheRead = agg.cumulativeCacheRead;
      this._usageFirstInput = agg.firstInput;
      this._usageFirstUserMessageTokens = agg.firstUserMessageTokens;
    }

    const systemPromptTotal = Math.max(0, this._usageFirstInput - this._usageFirstUserMessageTokens);
    const est = this._getPromptSectionEstimates();
    const stats: UsageStats = {
      cumulativeInput,
      cumulativeOutput,
      cumulativeCacheRead,
      cumulativeUncached: Math.max(0, cumulativeInput - cumulativeCacheRead),
      systemPromptTotal,
      systemPromptBreakdown: scalePromptBreakdown(est, systemPromptTotal),
      firstInput: this._usageFirstInput,
      firstUserMessageTokens: this._usageFirstUserMessageTokens,
    };
    this._usageStatsCache = { logLen, baseVersion: this._usageBaseVersion, stats };
    return stats;
  }

  /** 写入 meta.json 的累计用量基线（统计页与有界恢复共用）。 */
  get usageTotals(): { input: number; output: number; cacheRead: number } {
    const stats = this._computeUsageStats();
    return { input: stats.cumulativeInput, output: stats.cumulativeOutput, cacheRead: stats.cumulativeCacheRead };
  }

  get usageFirstInput(): number { return this._computeUsageStats().firstInput; }
  get usageFirstUserMessageTokens(): number { return this._computeUsageStats().firstUserMessageTokens; }

  get cumulativeInputTokens(): number { return this._computeUsageStats().cumulativeInput; }
  get cumulativeOutputTokens(): number { return this._computeUsageStats().cumulativeOutput; }
  get cumulativeCacheReadTokens(): number { return this._computeUsageStats().cumulativeCacheRead; }
  get cumulativeUncachedTokens(): number { return this._computeUsageStats().cumulativeUncached; }
  get systemPromptTokens(): number { return this._computeUsageStats().systemPromptTotal; }
  get contextBreakdown(): ContextBreakdown { return this._computeUsageStats().systemPromptBreakdown; }

  computeGlobalTokenStats(): import("./config/session-store.js").GlobalTokenStats {
    return (this._store as import("./config/session-store.js").SessionStore)?.computeGlobalTokenStats?.()
      ?? { cumulativeInput: 0, cumulativeOutput: 0, cumulativeCacheRead: 0, cumulativeUncached: 0, sessionCount: 0 };
  }

  /** 有效上下文预算：contextLength × 上下文预算百分比。 */
  get contextBudget(): number {
    return Math.round((this.primaryAgent?.modelConfig?.contextLength ?? 0) * this._contextManager.budgetPercent / 100);
  }

  appendStatusMessage(text: string, statusType = "status", ephemeral = false): void {
    const entry = createStatus(this._nextLogId("status"), this._turnCount, text, statusType);
    if (ephemeral) {
      (entry.meta as Record<string, unknown>)["ephemeral"] = true;
    }
    this._appendEntry(entry, true);
  }

  /**
   * 在主界面记录一条用户输入样式条目（背景色 userWash），不进入 LLM 轮次。
   * 用于 /memory、/theme brief 等斜杠命令：显示给用户看，但不发给模型。
   */
  appendUserInputDisplay(text: string): void {
    this.appendCommandEcho(text, "injected");
  }

  appendCommandEcho(
    text: string,
    style: "switch" | "injected",
    tone: "default" | "worked" = "default",
  ): void {
    this._appendEntry(
      createCommandEcho(this._nextLogId("user_message"), this._turnCount, text, style, tone),
      true,
    );
  }

  appendErrorMessage(text: string, errorType?: string): void {
    this._appendEntry(
      createErrorEntry(this._nextLogId("error"), this._turnCount, text, errorType),
      true,
    );
  }

  _getManualCompactBlocker(): string | null {
    return getManualCompactBlocker(this);
  }

  private async _runInjectedTurn(
    displayText: string,
    content: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    this._lastTurnEndStatus = null;
    const inputKind = "user" as const;
    const received = this._beginActiveInput(inputKind, displayText, content);
    this._appendDeliveredUserMessage(
      received.inputIndex,
      received.inputId,
      inputKind,
      displayText,
      content,
      received.contextId,
    );
    this.onSaveRequest?.();

    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    try {
      return await this._runTurnActivationLoop(opts?.signal, textAccumulator, reasoningAccumulator);
    } catch (err) {
      if (!this._activeAsk) {
        this._recordTurnFailure(err, opts?.signal);
      }
      if (!this._activeAsk && this._turnCount > 0 && this._lastTurnEndStatus === null) {
        this._finishCurrentWork("error");
      }
      throw err;
    }
  }

  async runInjectedCommand(
    displayText: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    return this._withTurnLock(async () => {
      // catch 必须放在锁内部：失败标志在每次获取锁时重置，排队中的
      // 竞争者会在外部 catch 执行前恢复 —— 那会重复写入或漏写该条目。
      try {
        this._ensureSessionStorageReady();
        await this._claimSessionWriter();
        await this._ensureMcp();
        return await this._runInjectedTurn(displayText, content, { signal: options?.signal });
      } catch (err) {
        this._recordTurnFailure(err, options?.signal);
        throw err;
      }
    });
  }


  async runManualCompact(
    instruction?: string,
    options?: { signal?: AbortSignal; completionDisplay?: string },
  ): Promise<void> {
    return runManualCompact(this, instruction, options);
  }

  /** runManualCompact 的主体。调用方持有回合锁。 */
  /** runManualCompact 的主体。调用方持有回合锁。 */
  async _runManualCompactBody(
    instruction?: string,
    options?: { signal?: AbortSignal; completionDisplay?: string },
  ): Promise<void> {
    return runManualCompactBody(this, instruction, options);
  }

  // ==================================================================
  // Ask 状态
  // ==================================================================

  /**
   * 从日志条目恢复 ask 状态。
   * 扫描未关闭的 ask_request（没有匹配的 ask_resolution）。
   */
  /**
   * 从日志条目恢复 ask 状态。
   * 扫描未关闭的 ask_request（没有匹配的 ask_resolution）。
   */
  getPendingAsk(): PendingAskUi | null {
    return getPendingAsk(this);
  }

  hasPendingTurnToResume(): boolean {
    return hasPendingTurnToResume(this);
  }

  _emitAskRequestedProgress(ask: AskRequest): void {
    emitAskRequestedProgress(this, ask);
  }

  _emitAskResolvedProgress(askId: string, decision: string, askKind?: string): void {
    emitAskResolvedProgress(this, askId, decision, askKind);
  }

  /** 路径严格位于会话 artifacts 目录内时返回 true。 */
  /** 路径严格位于会话 artifacts 目录内时返回 true。 */
  _isInsideArtifactsDir(rawPath: unknown): boolean {
    return isInsideArtifactsDir(this, rawPath);
  }

  _beforeToolExecute = (ctx: ToolPreflightContext): Promise<ToolPreflightDecision | void> =>
    beforeToolExecute(this, ctx);


  // ==================================================================
  // 主回合循环
  // ==================================================================

  async resumePendingTurn(options?: { signal?: AbortSignal }): Promise<string> {
    return this._withTurnLock(async () => {
      await this._claimSessionWriter();
      if (this._activeAsk) {
        throw new Error("Cannot resume while an ask is still pending approval.");
      }
      const pending = this._pendingTurnState;
      if (!pending) return "";

      await this._ensureSessionStartHooks();
      this._contextManager?.assertBudgetAvailable();
      this._pendingTurnState = null;
      if (pending.stage === "pre_user_input") {
        // 已在锁内 —— 直接调用内层回合逻辑
        return this._turnInner(pending.userInput ?? "", options);
      }
      return this._resumeActivationStage(options);
    });
  }

  /**
   * 继续一个在激活中途挂起的回合（审批已解决、问题已回答）。
   * 这是唯一的规范续跑路径 —— turn() 与 resumePendingTurn() 都汇到这里，
   * 因此无论 UI 从哪个入口进来，已批准的 pending tool_call 都会执行、
   * 排队消息都会投递。调用方必须持有回合锁，并在 session-start hooks 与
   * 上下文预算检查通过后清空 _pendingTurnState。
   */
  async _resumeActivationStage(options?: { signal?: AbortSignal }): Promise<string> {
    this._invalidateProviderTokenSnapshot();
    // 挂起的回合从未收尾，上一回合的结束状态在此已过期；像其他回合入口
    // 一样置空，下面的错误路径才能判断 work 是否仍需关闭。
    this._lastTurnEndStatus = null;
    try {
      return await this._resumeActivationStageInner(options);
    } catch (err) {
      if (!this._activeAsk) {
        this._recordTurnFailure(err, options?.signal);
      }
      if (!this._activeAsk && this._turnCount > 0 && this._lastTurnEndStatus === null) {
        this._finishCurrentWork("error");
      }
      throw err;
    }
  }

  async _resumeActivationStageInner(options?: { signal?: AbortSignal }): Promise<string> {
    // 尽早安装回合信号，使 _drainPendingToolCalls 能把它传给工具执行器
    // （例如客户端 web_search）。
    const turnSignalState = this._installCurrentTurnSignal(options?.signal);

    const interruptionStartIdx = this._findEarliestPendingToolCallLogIndex();

    try {
      // 排空所有 pending tool_call（包括刚批准的那个，以及并行发出却没执行到的
      // 兄弟调用）。这是审批后唯一的规范执行路径；遇到挂起即停止。
      const drainResult = await this._drainPendingToolCalls(turnSignalState.signal);
      if (drainResult.kind === "suspended") {
        return "";
      }
      if (drainResult.kind === "interrupted") {
        this._finalizeDrainInterruptedWork(interruptionStartIdx);
        return "";
      }

      // 续跑后的激活边界排空：刚解决的审批产生的 tool_result 已在日志里；
      // 在模型下一次激活看到它们之前，先排空收件箱中的排队消息。
      if (this._hasInboxMessages()) {
        this._drainInboxAsEntries();
      }
    } finally {
      this._restoreCurrentTurnSignal(turnSignalState);
    }

    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    const result = await this._runTurnActivationLoop(options?.signal, textAccumulator, reasoningAccumulator);
    // 把续跑回合的输出通知父会话。否则审批后的 assistant_text 会丢失，
    // agent_result.content 会显示 "(no output)"。
    if (!this._activeAsk) {
      this._turnOutputTarget?.(result?.trim() || "");
      if (result?.trim()) this._recordSessionEvent("returned output");
    }
    return result;
  }

  /**
   * 续跑排空的中断处理从活动窗口中最早的未解决 tool_call 开始，而不是
   * 从当前日志尾部：孤儿 tool_call 在审批 ask 之前就已发出，必须让中断
   * 清理看到。按整个窗口扫描（而非按回合）：work 挂起期间回合计数可能
   * 已推进，但其孤儿调用仍需补全。
   */
  /**
   * 在活动窗口中查找第一个在整个窗口内都没有匹配 tool_result 的 tool_call。
   * 这是 index 与对象两种调用方共用的唯一实现。故意分两遍：在
   * scripts/bench-log-hotpaths.ts 中实测，改用 pending map 的单遍合并写法
   * 慢约 2.8 倍（Map 增删的开销超过第二遍提前退出省下的时间）。
   */
  _firstPendingToolCall(): { index: number; entry: LogEntry } | null {
    const windowStart = this._activeWindowStartIdx();
    const resultIds = new Set<string>();
    for (let index = windowStart; index < this._log.length; index += 1) {
      const entry = this._log[index]!;
      if (entry.type !== "tool_result") continue;
      if (entry.discarded) continue;
      const id = String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "");
      if (id) resultIds.add(id);
    }
    for (let index = windowStart; index < this._log.length; index += 1) {
      const entry = this._log[index]!;
      if (entry.type !== "tool_call") continue;
      if (entry.discarded) continue;
      const toolCallId = String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "");
      if (!toolCallId || resultIds.has(toolCallId)) continue;
      return { index, entry };
    }
    return null;
  }

  _findEarliestPendingToolCallLogIndex(): number {
    return findEarliestPendingToolCallLogIndex(this);
  }

  _finalizeDrainInterruptedWork(fromLogIndex: number): void {
    finalizeDrainInterruptedWork(this, fromLogIndex);
  }

  /**
   * 按发出顺序排空当前回合的 pending tool_call。
   * 每个调用依次：门控 → 执行 → 追加 tool_result，并更新 tool_call meta。
   * 返回结构化结果，避免把审批挂起与中断都压成同一条空字符串续跑路径。
   *
   * 这是流式 tool-loop 之外执行 tool_call 的唯一规范路径 —— 用于审批后
   * 续跑，以及处理并行的孤儿 tool_call。
   */
  /**
   * 按发出顺序排空当前回合的 pending tool_call。
   * 每个调用依次：门控 → 执行 → 追加 tool_result，并更新 tool_call meta。
   * 返回结构化结果，避免把审批挂起与中断都压成同一条空字符串续跑路径。
   *
   * 这是流式 tool-loop 之外执行 tool_call 的唯一规范路径 —— 用于审批后
   * 续跑，以及处理并行的孤儿 tool_call。
   */
  async _drainPendingToolCalls(signal?: AbortSignal): Promise<DrainPendingToolCallsResult> {
    return drainPendingToolCalls(this, signal);
  }

  /**
   * 按日志/发出顺序找出活动窗口中下一个 pending tool_call（无匹配结果）。
   * 全部解决时返回 null。按整个窗口而非按回合查找：即使 ask 挂起期间
   * 回合计数已推进，已批准的 tool_call 也必须在续跑时执行。
   */
  /**
   * 按日志/发出顺序找出活动窗口中下一个 pending tool_call（无匹配结果）。
   * 全部解决时返回 null。按整个窗口而非按回合查找：即使 ask 挂起期间
   * 回合计数已推进，已批准的 tool_call 也必须在续跑时执行。
   */
  _findNextPendingToolCall(): {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    turnIndex: number;
    roundIndex: number;
    agentName: string;
  } | null {
    return findNextPendingToolCall(this);
  }

  /** 就地更新 tool_call 条目的 toolExecState meta。 */
  /** 就地更新 tool_call 条目的 toolExecState meta。 */
  _updateToolCallExecState(
    toolCallId: string,
    state: "not_started" | "running" | "completed" | "failed",
  ): void {
    updateToolCallExecState(this, toolCallId, state);
  }

  async _runTurnActivationLoop(
    signal: AbortSignal | undefined,
    textAccumulator: { text: string },
    reasoningAccumulator: { text: string },
  ): Promise<string> {
    return runTurnActivationLoop(this, signal, textAccumulator, reasoningAccumulator);
  }

  /**
   * 首次写入前拿到单写者锁：锁是内核对象（命名管道 / unix socket），进程退出
   * 自动释放，所以不需要陈旧锁判定。另一个进程正在写同一会话时直接失败，
   * 不带着半份状态继续写日志。
   */
  async _claimSessionWriter(): Promise<void> {
    const dir = this._store?.sessionDir;
    if (!dir) return;
    const lock = await this._store.acquireSessionLock(dir);
    if (!lock.ok) {
      throw new Error(`Session is being written by another SwarmFlow process: ${dir}`);
    }
  }

  async turn(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
    const turnLog = getLogger("session.turn");
    turnLog.info("turn:enter", { len: userInput.length, hasSignal: Boolean(options?.signal) });
    return this._withTurnLock(async () => {
      try {
        await this._claimSessionWriter();
        const result = await this._turnInner(userInput, options);
        turnLog.info("turn:exit:ok");
        return result;
      } catch (err) {
        turnLog.error("turn:exit:err", { err: err instanceof Error ? err.message : String(err) });
        // 兜底 _turnInner 自身 catch 覆盖不到的失败（存储/MCP/附件/
        // 回合前压缩）。借助按锁的 once 标志与内层保持幂等。
        this._recordTurnFailure(err, options?.signal);
        throw err;
      }
    });
  }

  /**
   * 在首个 turn 前执行一次 SessionStart hooks。
   *
   * 返回的 additionalContext 会进入本轮 ephemeral 尾巴，而不是永久 system。
   * 每个 hook 仍受自身 timeoutMs 约束，因此不会无限阻塞首个 turn。
   */
  async _ensureSessionStartHooks(): Promise<void> {
    this._sessionStartHooksPromise ??= (async () => {
      if (!this.hookRuntime.hooks.some((hook) => hook.event === "SessionStart")) return;
      await this.hookRuntime.evaluate("SessionStart", {
        event: "SessionStart",
        timestamp: Date.now(),
      });
    })();
    await this._sessionStartHooksPromise;
  }

  /** 内层回合逻辑，在回合锁内调用。 */
  async _turnInner(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
    // pending ask 独占对话：用户回答之前回合无法运行。新输入会排队（Q5），
    // 等 work 恢复时投递 —— 既不丢弃，也不会挤进挂起轮次的记账。
    if (this._activeAsk) {
      if (!options?.skipUserInput && userInput.trim()) {
        this._deliverMessage({
          type: "user_input",
          sender: "user",
          content: userInput,
          timestamp: Date.now(),
        });
      }
      return "";
    }

    const resumingActivation = this._pendingTurnState?.stage === "activation";
    if (!resumingActivation) {
      this._autoCompactCountThisTurn = 0;
      this._compactTerminatedThisTurn = false;
    }
    this._invalidateProviderTokenSnapshot();
    this._ensureSessionStorageReady();
    await this._claimSessionWriter();
    await this._ensureSessionStartHooks();
    this._contextManager?.assertBudgetAvailable();

    const signal = options?.signal;
    if (this._pendingTurnState) {
      // 已经通过 turn() 处于锁内 —— 就地续跑（此处再调 turn()
      // 会在回合锁上死锁）。
      const pending = this._pendingTurnState;
      this._pendingTurnState = null;
      if (pending.stage === "pre_user_input") {
        return this._turnInner(pending.userInput ?? "", options);
      }
      // work 等待续跑期间又有新输入经 turn() 到来：先排队，
      // 由规范续跑路径负责投递（Q5）。
      if (!options?.skipUserInput && userInput.trim()) {
        this._deliverMessage({
          type: "user_input",
          sender: "user",
          content: userInput,
          timestamp: Date.now(),
        });
      }
      return this._resumeActivationStage(options);
    }

    // skipUserInput 路径：从 idle 自动续跑。把收件箱按独立条目排空，
    // 而不是写一条合成的空用户输入。
    if (options?.skipUserInput) {
      this._lastTurnEndStatus = null;
      if (!this._hasInboxMessages() && !this._hasUnprocessedUserMessage()) {
        return "";
      }
      this._drainInboxAsEntries();
      this.onSaveRequest?.();
    } else {
      let userContent: string | Array<Record<string, unknown>>;
      try {
        userContent = await this._processFileAttachments(userInput);
      } catch (err) {
        if (isAskPendingError(err)) {
          this._pendingTurnState = { stage: "pre_user_input", userInput };
          this.onSaveRequest?.();
          return "";
        }
        throw err;
      }
      // 触发 UserPromptSubmit hooks（可拒绝或修改提示词）
      if (this.hookRuntime.hooks.length > 0) {
        this.hookRuntime.clearTurnContext();
        // 上一轮若因异常退出，next-round 上下文可能残留；新用户输入前清理。
        this.hookRuntime.clearNextRoundContext();
        const hookResult = await this.hookRuntime.evaluate("UserPromptSubmit", {
          event: "UserPromptSubmit",
          timestamp: Date.now(),
          userPrompt: typeof userContent === "string" ? userContent : userInput,
        });
        if (hookResult.decision === "deny") {
          this.appendStatusMessage(
            `Prompt blocked by hook: ${hookResult.denyReason ?? "denied"}`,
            "hook_deny",
          );
          return "";
        }
      }

      this._lastTurnEndStatus = null;
      // 把内联图片（剪贴板粘贴）合并进多模态内容
      const inlineImages = options?.inlineImages;
      if (inlineImages && inlineImages.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        if (typeof userContent === "string") {
          if (userContent.trim()) {
            parts.push({ type: "text", text: userContent });
          }
        } else {
          parts.push(...userContent);
        }
        for (const img of inlineImages) {
          parts.push({
            type: "image",
            media_type: img.mediaType,
            data: img.base64,
          });
        }
        userContent = parts;
      }

      // display = 用户原始输入（键入内容）；content = 为 API 展开后的内容
      const displayText = userInput;
      // 写入日志条目时，把内联 base64 图片替换为 image_ref 文件路径
      const logContent = this._extractAndSaveImages(userContent);
      const received = this._beginActiveInput("user", displayText, logContent);
      this._appendDeliveredUserMessage(
        received.inputIndex,
        received.inputId,
        "user",
        displayText,
        logContent,
        received.contextId,
      );
    }
    this.onSaveRequest?.();

    // 确保 MCP 已连接（在用户消息展示之后）。
    if (this._mcpManager) {
      await this._ensureMcp();
    }

    // 回合前自动压缩：若已知用量 + 估算的新 token 超过阈值，就现在压缩，
    // 让激活在新鲜上下文中运行。
    if (this._capabilities.includeSpawnTool && !this._compactInProgress) {
      const { budget } = this._contextBudgetInfo();
      if (budget > 0) {
        const estimatedTokens = (this._lastInputTokens > 0
          ? this._lastInputTokens
          : this._estimateContextTokens()) + gptEncode(userInput).length;
        const beforeTurnRatio = this._thresholds.compact_before_turn / 100;
        if (estimatedTokens > beforeTurnRatio * budget) {
          const logLenBefore = this._log.length;
          try {
            await this._doAutoCompact("before_turn", signal);
          } catch (compactErr) {
            if (!isCommittedCompactError(compactErr)) {
              this._truncateCompactAttemptEntries(logLenBefore);
            }
            if (signal?.aborted || this._isCompactAbortError(compactErr)) {
              this._beginWorkIfNeeded();
              this._appendInterruptionSystemMessage([], true);
              this._recordSessionEvent("interrupted by user");
              this._finishCurrentWork("interrupted");
            }
            throw compactErr;
          }
          // 压缩期间被暂扣的消息（Q6）在 marker 之后落位。
          if (this._hasInboxMessages()) {
            this._drainInboxAsEntries();
          }
          this.onSaveRequest?.();
        }
      }
    }

    // 记录流式内容，用于中止后的恢复
    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    try {
      const result = await this._runTurnActivationLoop(signal, textAccumulator, reasoningAccumulator);
      // 总是通知父会话 —— 即使结果为空。
      if (!this._activeAsk) {
        this._turnOutputTarget?.(result?.trim() || "");
        if (result?.trim()) this._recordSessionEvent("returned output");
      }
      return result;
    } catch (err) {
      // 把错误投递给父会话，绝不静默丢失
      if (!this._activeAsk) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this._turnOutputTarget?.(`[Error] ${errorMsg}`);
        this._recordTurnFailure(err, options?.signal);
      }
      if (!this._activeAsk && this._turnCount > 0 && this._lastTurnEndStatus === null) {
        this._finishCurrentWork("error");
      }
      throw err;
    }
  }

  /** 错误是用户中断而非真实失败时返回 true。 */
  /** 错误是用户中断而非真实失败时返回 true。 */
  _isTurnAbortError(err: unknown, signal?: AbortSignal): boolean {
    return isTurnAbortError(this, err, signal);
  }

  /**
   * 内部压缩代码用这条固定消息表示主动停止。provider 也可能抛 AbortError，
   * 但没有该标记时它属于传输失败，必须继续作为错误暴露。
   */
  _isCompactAbortError(err: unknown): boolean {
    return (err as { name?: unknown })?.name === "AbortError"
      && (err as { message?: unknown })?.message === "Compact phase aborted.";
  }

  // 当前这次回合锁执行已写入错误日志条目时置位；每次获取锁时重置。
  // 这样多个 catch 层（入口封装、续跑阶段、手动上下文命令）都能调用
  // _recordTurnErrorEntry 而不会重复写入。
  _turnErrorEntryWritten = false;

  // 当前这次回合锁执行是否已发出生命周期 "ended" 事件（由
  // _runTurnActivationLoop 的 finally 设置）。在激活循环之前就失败的
  // 路径据此补发缺失的 ended(error)，且只发一次。每次获取锁时重置。
  _lifecycleEndedEmitted = false;

  /**
   * 为失败的回合写入用户可见的错误日志条目 —— 每次回合锁执行最多一次，
   * 且用户中断时从不写入。错误可见性由 runtime 负责：所有 UI 都通过日志
   * 投影看到该条目。（历史上由 TUI 的 catch 写这条，导致 server 模式的
   * UI 看不到回合错误。）
   */
  /**
   * 为失败的回合写入用户可见的错误日志条目 —— 每次回合锁执行最多一次，
   * 且用户中断时从不写入。错误可见性由 runtime 负责：所有 UI 都通过日志
   * 投影看到该条目。（历史上由 TUI 的 catch 写这条，导致 server 模式的
   * UI 看不到回合错误。）
   */
  _recordTurnErrorEntry(err: unknown, signal?: AbortSignal): void {
    recordTurnErrorEntry(this, err, signal);
  }

  /**
   * 回合在锁内（或紧邻锁外）任意位置失败时的完整失败面：错误日志条目，
   * 以及激活循环来不及发出时补发的生命周期 ended(error) 事件（循环前
   * 失败：存储、MCP、附件、回合前压缩、手动命令校验）。两部分都按锁
   * 执行保持幂等，因此每个 catch 层都可以无条件调用。
   */
  /**
   * 回合在锁内（或紧邻锁外）任意位置失败时的完整失败面：错误日志条目，
   * 以及激活循环来不及发出时补发的生命周期 ended(error) 事件（循环前
   * 失败：存储、MCP、附件、回合前压缩、手动命令校验）。两部分都按锁
   * 执行保持幂等，因此每个 catch 层都可以无条件调用。
   */
  _recordTurnFailure(err: unknown, signal?: AbortSignal): void {
    recordTurnFailure(this, err, signal);
  }

  /**
   * 基于结构化日志处理中断（v2）。
   *
   * 规则：
   * - 保留已完成的 reasoning，丢弃当前被中断轮次中未完成的 reasoning
   * - 把部分流式文本固化为 assistant_text
   * - 对每个缺少结果的完整 tool_call，追加带上下文的 tool_result
   * - 对只在 TUI 可见的部分（未关闭）tool_call，追加一条 user 角色
   *   system 消息，说明它们为何不在 API 上下文中
   * - 注入一条关于本次中断的 user 角色 system 消息
   */
  /**
   * 基于结构化日志处理中断（v2）。
   *
   * 规则：
   * - 保留已完成的 reasoning，丢弃当前被中断轮次中未完成的 reasoning
   * - 把部分流式文本固化为 assistant_text
   * - 对每个缺少结果的完整 tool_call，追加带上下文的 tool_result
   * - 对只在 TUI 可见的部分（未关闭）tool_call，追加一条 user 角色
   *   system 消息，说明它们为何不在 API 上下文中
   * - 注入一条关于本次中断的 user 角色 system 消息
   */
  _handleInterruption(
    logLenBefore: number,
    accumulatedText: string,
    opts?: { activationCompleted?: boolean },
  ): void {
    handleInterruption(this, logLenBefore, accumulatedText, opts);
  }

  /**
   * 扫描当前回合的日志条目，收集人类可读的中断提示。
   * 在 _handleInterruption 之后、写入 turn_end 之前调用。
   */
  /**
   * 扫描当前回合的日志条目，收集人类可读的中断提示。
   * 在 _handleInterruption 之后、写入 turn_end 之前调用。
   */
  _collectInterruptHints(): string[] {
    return collectInterruptHints(this);
  }

  _completeMissingToolResultsFromLog(fromIdx: number): void {
    completeMissingToolResultsInLog(this._logSurgeryView(), fromIdx);
  }

  // ==================================================================
  // 激活
  // ==================================================================

  async _runActivation(
    activationTurnIndex: number,
    signal?: AbortSignal,
    textAccumulator?: { text: string },
    reasoningAccumulator?: { text: string },
    suppressStreaming?: boolean,
  ): Promise<ToolLoopResult> {
    return runActivation(this, activationTurnIndex, signal, textAccumulator, reasoningAccumulator, suppressStreaming);
  }

  // ==================================================================
  // Ask 工具
  // ==================================================================

  _execAsk(args: Record<string, unknown>): ToolResult {
    return execAsk(this, args);
  }

  _buildAgentQuestionToolResult(
    questions: AgentQuestionItem[],
    decision: AgentQuestionDecision,
  ): ToolResult {
    const lines: string[] = [];
    let hasDiscussFurther = false;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const answer = decision.answers.find((a) => a.questionIndex === i);
      lines.push(`Question ${i + 1}: "${q.question}"`);
      if (!answer) {
        lines.push("Answer: [missing]");
      } else {
        lines.push(`Answer: ${answer.answerText}`);
        const selected = q.options[answer.selectedOptionIndex];
        if (selected?.kind === "discuss_further") {
          hasDiscussFurther = true;
        }
      }
      if (answer?.note) {
        lines.push(`User note: ${answer.note}`);
      }
      lines.push("");
    }
    if (hasDiscussFurther) {
      lines.push(ASK_DISCUSS_FURTHER_GUIDANCE);
    }
    return new ToolResult({ content: lines.join("\n").trim() });
  }

  _buildAgentQuestionPreview(
    questions: AgentQuestionItem[],
    decision: AgentQuestionDecision,
  ): string {
    const lines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const answer = decision.answers.find((a) => a.questionIndex === i);
      // 展示问题及全部选项，并标出当前选中项
      lines.push(`Q${questions.length > 1 ? i + 1 : ""}: ${q.question}`);
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        const isSelected = answer?.selectedOptionIndex === j;
        const marker = isSelected ? "●" : "○?";
        const desc = opt.description ? ` —${opt.description}` : "";
        lines.push(`  ${marker} ${opt.label}${desc}`);
      }
      if (answer && q.options[answer.selectedOptionIndex]?.kind === "custom_input") {
        lines.push(`  ✎ ${answer.answerText}`);
      }
      if (answer?.note) {
        lines.push(`  📝 ${answer.note}`);
      }
    }
    return lines.join("\n");
  }

  resolveAgentQuestionAsk(
    askId: string,
    decision: AgentQuestionDecision,
  ): void {
    resolveAgentQuestionAsk(this, askId, decision);
  }

  _resolveOwnAgentQuestionAsk(askId: string, decision: AgentQuestionDecision): void {
    resolveOwnAgentQuestionAsk(this, askId, decision);
  }

  /**
   * 解决一个权限审批 ask。
   * @param askId  要解决的 ask ID。
   * @param choiceIndex  ask 选项数组中的下标。最后一个选项始终是 "Deny"。
   */
  /**
   * 解决一个权限审批 ask。
   * @param askId  要解决的 ask ID。
   * @param choiceIndex  ask 选项数组中的下标。最后一个选项始终是 "Deny"。
   */
  resolveApprovalAsk(askId: string, choiceIndex: number): void {
    resolveApprovalAsk(this, askId, choiceIndex);
  }

  _resolveOwnApprovalAsk(askId: string, choiceIndex: number): void {
    resolveOwnApprovalAsk(this, askId, choiceIndex);
  }

  _findChildWithPendingAsk(askId: string): ChildSessionHandle | null {
    return findChildWithPendingAsk(this, askId);
  }

  _resumeChildPendingTurn(handle: ChildSessionHandle): void {
    resumeChildPendingTurn(this, handle);
  }

  _finishChildTurn(handle: ChildSessionHandle, error?: unknown): void {
    this._childSessionManagerInstance.finishChildTurn(handle, error);
  }

  /**
   * 把 ask 操作路由到正确的会话（自身或子会话）。
   * ask 属于本会话时执行 onSelf；属于子会话时执行 onChild，
   * 然后续跑子会话的 pending 回合。
   */
  /**
   * 把 ask 操作路由到正确的会话（自身或子会话）。
   * ask 属于本会话时执行 onSelf；属于子会话时执行 onChild，
   * 然后续跑子会话的 pending 回合。
   */
  _withAskRouting<T>(
    askId: string,
    onSelf: () => T,
    onChild: (child: ChildSessionHandle) => T,
  ): T {
    return withAskRouting(this, askId, onSelf, onChild);
  }

  // ==================================================================
  // 工具调用可见性
  // ==================================================================

  /**
   * 覆盖工具调用 TUI 可见性的 hook。返回 "hide" 会完全隐藏该调用 ——
   * runtime 的 "hide" 机制保留备用，目前没有地方使用。
   */
  _resolveToolCallVisibility: ResolveToolCallVisibilityCallback = () => {
    return undefined;
  };


  _getArtifactsDirIfAvailable(): string | undefined {
    if (this._sessionArtifactsOverride) return this._sessionArtifactsOverride;
    if (!this._store) return undefined;
    const d = this._store.artifactsDir;
    if (d) return d;
    return undefined;
  }

  private _createMissingSessionDirOrThrow(): void {
    if (!this._store) return;
    if (this._store.sessionDir) return;
    if (typeof this._store.createSession !== "function") {
      throw new Error(
        "Session artifacts directory is unavailable. " +
        "No session directory is active and the attached SessionStore " +
        "cannot create one.",
      );
    }
    try {
      this._store.createSession();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        "Failed to create session storage before running this turn. " +
        `Reason: ${reason}`,
      );
    }
  }

  _ensureSessionStorageReady(): void {
    if (this._sessionArtifactsOverride) {
      return;
    }
    if (!this._store) {
      throw new Error(
        "Session artifacts directory is unavailable. " +
        "No SessionStore is attached and no paths.session_artifacts override is configured.",
      );
    }
    if (!this._store.sessionDir) {
      this._createMissingSessionDirOrThrow();
    }
    const artifacts = this._getArtifactsDirIfAvailable();
    if (!artifacts) {
      throw new Error(
        "Session artifacts directory is unavailable after session initialization. " +
        "Possible causes: (1) ~/.swarmflow/ is not writable, (2) disk is full, " +
        "(3) permission issues creating the artifacts directory.",
      );
    }
  }

  private _getArtifactsDir(): string {
    if (this._sessionArtifactsOverride) return this._sessionArtifactsOverride;
    const d = this._getArtifactsDirIfAvailable();
    if (d) return d;
    throw new Error(
      "Session artifacts directory is unavailable. " +
      "This usually means no active session directory exists yet, or session " +
      "persistence failed to initialize. " +
      "Possible causes: (1) ~/.swarmflow/ is not writable, (2) disk is full, " +
      "(3) SessionStore is missing or not ready.",
    );
  }

  // ==================================================================
  // 路径变量解析
  // ==================================================================

  private _resolveSessionArtifacts(): string {
    if (this._sessionArtifactsOverride) return this._sessionArtifactsOverride;
    return this._getArtifactsDir();
  }

  /**
   * 根会话 ID：优先使用会话存储目录名，存储尚未惰性创建时退回
   * prompt cache key。两者都对同一会话稳定，保证日志路径不变。
   */
  private _resolveRootSessionId(): string {
    const sessionDir = typeof this._store?.sessionDir === "string" ? this._store.sessionDir : "";
    return sessionDir ? basename(sessionDir) : this._promptCacheKey;
  }

  /**
   * 项目内 shell 日志目录。
   *
   * 根会话：`{project}/.swarmflow/<session-id>/shells`
   * 子会话：由父会话显式传入 `.../agents/<child-id>/shells`，避免与根会话的
   * `shell-1` 等自动 id 冲突。日志放在工作区而不是 ~/.swarmflow，便于用户
   * 直接查看；`.swarmflow` 已被仓库的隐藏目录规则忽略。
   */
  private _resolveShellLogDir(): string {
    if (this._shellLogDirOverride) return this._shellLogDirOverride;
    return join(this._projectRoot, ".swarmflow", this._resolveRootSessionId(), "shells");
  }

  /** 子会话的 shell 日志目录（挂在该根会话的 agents/<child-id> 下）。 */
  private _resolveChildShellLogDir(childId: string): string {
    return join(this._projectRoot, ".swarmflow", this._resolveRootSessionId(), "agents", childId, "shells");
  }

  /**
   * 用分层 assembler 组装完整的 system prompt。
   * 由 _reloadPromptAndTools() 调用，不是每次请求都调用。
   */
  _describeInitialModel(): string {
    const mc = this.primaryAgent.modelConfig;
    const d = describeModel({
      providerId: mc.provider,
      selectionKey: mc.model,
      modelId: mc.model,
    });
    return d.compactScopedLabel || mc.model;
  }

  private _assembleSystemPrompt(): string {
    const recipe = this.primaryAgent.promptRecipe;
    const agentPrompt = recipe
      ? assembleSystemPrompt(recipe)
      : this.primaryAgent.systemPrompt;

    return assembleFullSystemPrompt({
      agentPrompt,
      projectRoot: this._projectRoot,
      homeDir: this._swarmflowHomeDir,
      skills: [...this._skills.values()],
      shellNotes: buildShellNotes(shell.kind),
    });
  }

  /**
   * 获取缓存的 system prompt。只计算一次并在多次 API 调用间复用，
   * 以稳定 prompt cache；仅由 _reloadPromptAndTools() 刷新。
   *
   * 动态 hooks/提醒不再拼接到 system：它们由消息投影追加到 ephemeral 尾巴，
   * 否则每次请求都会改变 system 前缀，使整段历史失去缓存。
   */
  _getSystemPrompt(): string {
    if (!this._cachedSystemPrompt) {
      this._cachedSystemPrompt = this._assembleSystemPrompt();
    }
    return this._cachedSystemPrompt;
  }

  /**
   * 重载技能并重建 system 快照。
   * 仅在会话初始化与显式 /reload 时调用；文件修改与 store 绑定
   * 都不会改变缓存前缀。
   */
  _reloadPromptAndTools(): void {
    this._refreshSkills();
    this._rebuildSystemPrompt();
  }

  /** 工具/技能/记忆变化后重建缓存的 system 快照。 */
  _rebuildSystemPrompt(): void {
    this._cachedSystemPrompt = this._assembleSystemPrompt();
    this._promptSectionEstimates = null;
    this._contextEstimateCache = null;
  }

  // ==================================================================
  // 自动压缩
  // ==================================================================

  _buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
    return buildCompactCheck(this);
  }

  /**
   * 运行压缩阶段：注入压缩提示词，让 Agent 生成续跑提示词
   * （可能借助工具），然后返回。
   */
  /**
   * 运行压缩阶段：注入压缩提示词，让 Agent 生成续跑提示词
   * （可能借助工具），然后返回。
   */
  async _runCompactPhase(
    scenario: "before_turn" | "mid_turn",
    promptOverride?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return runCompactPhase(this, scenario, promptOverride, signal);
  }

  /**
   * 执行自动压缩：先跑压缩阶段，再用 marker + system prompt + 续跑提示词
   * 重建对话。
   */
  /**
   * 执行自动压缩：先跑压缩阶段，再用 marker + system prompt + 续跑提示词
   * 重建对话。
   */
  async _doAutoCompact(
    scenario: "before_turn" | "mid_turn",
    signal?: AbortSignal,
    promptOverride?: string,
    hideCompactMarker = false,
    origin?: CompactOrigin,
  ): Promise<CompactCommitResult> {
    return doAutoCompact(this, scenario, signal, promptOverride, hideCompactMarker, origin);
  }

  _appendCompactCheckpoint(
    marker: LogEntry,
    context: LogEntry,
    meta: {
      checkpointId: string;
      archiveFile: string;
      archiveIndexFile: string;
      compactIndex: number;
      scenario: "before_turn" | "mid_turn" | "manual";
    },
  ): void {
    this._logStore.appendCheckpoint(marker, context, meta);
  }

  /**
   * 归档前把当前累计用量折成 usage base。
   * 冷区 token_update 的 meta 会被 strip，不能靠继续扫描日志保账。
   */
  _foldArchivedUsage(): void {
    const totals = this._computeUsageStats();
    this._usageBase = {
      input: totals.cumulativeInput,
      output: totals.cumulativeOutput,
      cacheRead: totals.cumulativeCacheRead,
    };
    for (const entry of this._log) {
      if (entry.type === "token_update") this._usageBaseIds.add(entry.id);
    }
    this._usageBaseVersion += 1;
    this._usageStatsCache = null;
  }

  /** 未提交的压缩尝试：物理截断到尝试起点，而不是只打 discarded。 */
  _truncateCompactAttemptEntries(fromIndex: number): void {
    const first = this._log[fromIndex];
    if (!first) return;
    this._logStore.truncateFrom(first.id);
  }

  /**
   * 压缩失败清理：丢弃本次压缩尝试写入的全部条目（索引区间即事实来源）。
   * 不能只看 meta.compactPhase：tool-loop 同步工具状态时会用 updateEntry
   * 整体替换 meta，标记会丢失，留下的半截 tool_call 会破坏 API 投影。
   * 调用方必须在追加失败/中断记录之前调用。
   */
  /**
   * 压缩失败清理：丢弃本次压缩尝试写入的全部条目（索引区间即事实来源）。
   * 不能只看 meta.compactPhase：tool-loop 同步工具状态时会用 updateEntry
   * 整体替换 meta，标记会丢失，留下的半截 tool_call 会破坏 API 投影。
   * 调用方必须在追加失败/中断记录之前调用。
   */
  _discardCompactAttemptEntries(fromIndex: number): void {
    discardCompactAttemptEntries(this, fromIndex);
  }

  // ==================================================================
  // 子代理的 spawn / cancel / 生命周期
  // ==================================================================

  private _saveChildSession(handle: ChildSessionHandle): boolean {
    if (!handle.session) return true; // 已释放 —— settle 时已持久化
    try {
      return handle.session.persistToDisk();
    } catch (e) {
      console.warn(`Failed to save child session '${handle.id}':`, e);
      return false;
    }
  }

  /** @internal 作为 ChildSessionManager 的稳定测试/运行时 hook 保留。 */
  _instantiateChildSession(
    taskId: string,
    templateLabel: string,
    mode: ChildSessionMode,
    agent: Agent,
    opts?: { numericId?: number; order?: number },
  ): ChildSessionHandle {
    return this._childSessionManagerInstance.instantiateChild(taskId, templateLabel, mode, agent, opts);
  }

  interruptChildSession(childId: string): { accepted: boolean; reason?: string } {
    return this._childSessionManagerInstance.interruptChild(childId);
  }

  killChildSession(childId: string): { accepted: boolean; reason?: string } {
    return this._childSessionManagerInstance.killAgent(childId);
  }

  private async _execSpawn(args: Record<string, unknown>): Promise<ToolResult> {
    const idArg = argRequiredString("spawn", args, "id", { nonEmpty: true });
    if (idArg instanceof ToolResult) return idArg;
    const taskArg = argRequiredString("spawn", args, "task", { nonEmpty: true });
    if (taskArg instanceof ToolResult) return taskArg;
    const modeArg = argRequiredString("spawn", args, "mode", { nonEmpty: true });
    if (modeArg instanceof ToolResult) return modeArg;
    const templateArg = argOptionalString("spawn", args, "template");
    if (templateArg instanceof ToolResult) return templateArg;
    const templatePathArg = argOptionalPath("spawn", args, "template_path");
    if (templatePathArg instanceof ToolResult) return templatePathArg;

    const template = (templateArg ?? "").trim();
    const templatePath = (templatePathArg ?? "").trim();

    if (!template && !templatePath) {
      return new ToolResult({ content: "Error: must specify either 'template' or 'template_path'." });
    }
    if (template && templatePath) {
      return new ToolResult({ content: "Error: cannot specify both 'template' and 'template_path'." });
    }

    const spec: Record<string, unknown> = { id: idArg.trim(), task: taskArg.trim(), mode: modeArg.trim() };
    if (template) spec["template"] = template;
    if (templatePath) spec["template_path"] = templatePath;
    return this._execSpawnFromSpecs([spec]);
  }

  private _execSpawnFromSpecs(
    tasksSpec: Array<Record<string, unknown>>,
  ): ToolResult {
    return this._childSessionManagerInstance.spawnFromSpecs(tasksSpec);
  }

  private _execKillAgent(args: Record<string, unknown>): ToolResult {
    const idsArg = argRequiredStringArray("kill_agent", args, "ids");
    if (idsArg instanceof ToolResult) return idsArg;
    const ids = idsArg;

    if (!ids.length) {
      return new ToolResult({ content: "No agent IDs specified." });
    }

    return this._childSessionManagerInstance.killAgents(ids);
  }

  // ==================================================================
  // send 工具 —— 向交互式/团队 agent 异步发送消息
  // ==================================================================

  private async _execSend(args: Record<string, unknown>): Promise<ToolResult> {
    const to = ((args["to"] as string) ?? "").trim();
    const content = ((args["content"] as string) ?? "").trim();
    if (!to || !content) {
      return new ToolResult({ content: "Error: 'to' and 'content' are required." });
    }

    return this._childSessionManagerInstance.sendOrRevive(to, content);
  }

  private async _execCheckStatus(_args: Record<string, unknown>): Promise<ToolResult> {
    const sections = [
      "# Sub-Session Status",
      this._buildDetailedChildStatusReport(),
      "",
      "# Pending Root Messages",
      this._buildQueuedRootMessageSummary(),
      "",
      "# Shell",
      this._buildShellReport(),
    ];
    return new ToolResult({ content: sections.join("\n") });
  }

  // ------------------------------------------------------------------
  // await_event —— 阻塞等待子代理完成或新消息
  //
  // 设计约定（2026-10-19）：本工具不接受时长参数。它阻塞到「runtime 事件落进
  // inbox」为止，唯一的退出条件是：事件到达 / 用户中断 / 无可等对象 / 防卡死
  // 上限。历史上模型每次传 seconds=30，导致每 30 秒超时返回一次、每返回一次
  // 就触发一轮 provider 调用，模型于是反复重发同一份计划（实测一次 turn 内 61
  // 次等待、38 次调用、61 分钟）。等待本身不花钱，返回后的调用才花钱。
  // ------------------------------------------------------------------

  /**
   * 防卡死上限（ms）：单个 await_event 最长阻塞时间。不是「超时」而是保险丝——
   * 等的东西卡死时强制返回，让模型重新决策。做成实例字段以便测试注入，
   * 生产环境恒为 2 小时。
   */
  private _awaitEventCeilingMs = 2 * 60 * 60 * 1000;

  /**
   * 是否还有「值得等下去」的对象：活跃子 agent、运行中的后台 shell，或已在
   * inbox 排队的消息。三者皆空时阻塞毫无意义——只会白耗到上限，这正是历史上
   * 模型对着一个已经结束的子 agent 反复 await_event 的典型场景。
   */
  private _hasWaitables(): boolean {
    return this._hasActiveAgents() || this._hasRunningShells() || this._hasInboxMessages();
  }

  /**
   * 把毫秒差格式化成模型可读的时长：`45s` / `3m20s` / `2h5m`。
   * 仅用于 await_event 的结果头部，不引入额外的格式化依赖。
   */
  private _formatWaitDuration(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
  }

  /**
   * 等待运行时事件（工具入口，无参数）。
   *
   * 轮询间隔固定 1s，仅用于观察事件；不存在按调用时长设置的超时，
   * 退出路径见函数内注释。
   */
  private async _execAwaitEvent(): Promise<ToolResult> {
    const signal = this._currentTurnSignal;

    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // 短路 1：已经没有任何可等对象。不要进入阻塞——直接带着现状返回。
    if (!this._hasWaitables()) {
      const parts = [
        "Returned immediately — nothing is running and no messages are pending.",
        this._buildDetailedChildStatusReport(),
        this._buildShellReport(),
      ];
      return new ToolResult({ content: parts.filter(Boolean).join("\n\n") });
    }

    // 预检：inbox 已有消息则立即返回。
    // inbox 内容不写进 tool_result —— 激活边界会在本条 tool_result 之后
    // 把它们作为独立条目注入。
    if (this._hasInboxMessages()) {
      const brief = this._buildDetailedChildStatusReport();
      const shell = this._buildShellReport();
      const parts = ["Messages pending.", brief, shell].filter(Boolean);
      return new ToolResult({ content: parts.join("\n\n") });
    }

    this._agentState = "waiting";
    this._setSelfPhase("waiting");
    const startMs = Date.now();
    const ceilingMs = startMs + this._awaitEventCeilingMs;
    let exitReason: "event" | "nothing_left" | "ceiling" = "ceiling";

    // 阻塞循环：只由「事件到达 / 无可等对象 / 用户中断 / 防卡死上限」退出。
    // 这里刻意没有 schedule timeout——按固定时长返回是历史故障的根因。
    for (;;) {
      if (this._hasInboxMessages()) {
        exitReason = "event";
        break;
      }
      if (!this._hasWaitables()) {
        exitReason = "nothing_left";
        break;
      }
      if (signal?.aborted) {
        this._agentState = "working";
        this._setSelfPhase("idle");
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const now = Date.now();
      if (now >= ceilingMs) break;
      // 已知限制：阻塞期间没有周期性的 UI 进度刷新（_setSelfPhase 只接受固定
      // 枚举，塞不进 elapsed）。用户看到的是「waiting」相位一直挂着，要等这次
      // 调用返回才能在 tool_result 里看到实际等了多久。若要做成可见进度，需要
      // 新建一条 session → UI 的通知通道，不在本次改动范围内。
      const sleepMs = Math.min(1000, ceilingMs - now);
      await new Promise<void>((r) => setTimeout(r, sleepMs));
    }

    this._agentState = "working";
    this._setSelfPhase("idle");

    // tool_result 只放头部与状态报告；inbox 内容由激活边界单独注入。
    const waited = this._formatWaitDuration(Date.now() - startMs);
    const header =
      exitReason === "event"
        ? `Waited for ${waited} —new message arrived.`
        : exitReason === "nothing_left"
          ? `Waited for ${waited} —nothing is still running and no event arrived.`
          : `Waited for ${waited} (ceiling reached) —still no events.`;
    const brief = this._buildDetailedChildStatusReport();
    const shell = this._buildShellReport();
    const parts = [header, brief, shell].filter(Boolean);
    return new ToolResult({ content: parts.join("\n\n") });
  }

  private _buildQueuedRootMessageSummary(): string {
    if (this._inbox.length === 0) return "No pending root messages.";
    const counts = new Map<string, number>();
    for (const msg of this._inbox) {
      counts.set(msg.sender, (counts.get(msg.sender) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([sender, count]) => `- ${sender}: ${count} queued`)
      .join("\n");
  }

  _hasActiveAgents(): boolean {
    return this._childSessionManagerInstance.hasActiveAgents();
  }

  _cascadeKillRunningChildren(
    cause: "user_mass_interrupt" | "parent_kill",
  ): number {
    return this._childSessionManagerInstance.cascadeKillRunning(cause);
  }

  _suspendAllChildSessions(): void {
    this._childSessionManagerInstance.suspendAll();
  }

  private _archiveAllChildSessions(): void {
    this._childSessionManagerInstance.archiveAll();
  }

  async _waitForAllChildTurnsSettled(): Promise<void> {
    await this._childSessionManagerInstance.waitForAllTurnsSettled();
  }

  _forceKillAllShells(): void {
    this._shellManager.forceKillAll();
  }

  private _buildChildSessionManager(): ChildSessionManager {
    return new ChildSessionManager({
      appendEntry: (entry, notify) => this._appendEntry(entry, notify),
      nextLogId: (type) => this._nextLogId(type),
      allocateContextId: () => this._allocateContextId(),
      getTurnCount: () => this._turnCount,
      notifyLogListeners: () => this._notifyLogListeners(),
      requestSave: () => this.onSaveRequest?.(),
      deliverMessageToParent: (msg) => { this._deliverMessage(msg); },
      // 子会话私有访问的封装：在 Session 内同类私有访问是合法的，
      // 而经由实例路由能让测试桩（例如 mock 的 _saveChildSession）继续生效。
      deliverToChild: (child, msg) => { child._deliverMessage(msg); },
      childHasInbox: (child) => child._hasInboxMessages(),
      setChildInbox: (child, msgs) => { child._inbox = msgs; },
      recordChildEvent: (child, event) => child._recordSessionEvent(event),
      normalizeChildInterruptedTurn: (child, message) => child._normalizeInterruptedTurnFromLog?.(message),
      saveChildSession: (handle) => this._saveChildSession(handle),
      reportChildSettled: (info) => this._onChildSettled(info),
      getProgress: () => this._progress,
      fireHook: (event, payload) => this.hookRuntime.fireAndForget(event, payload),
      resolveSessionArtifacts: () => this._resolveSessionArtifacts(),
      getArtifactsDir: () => this._getArtifactsDir(),
      resolveChildShellLogDir: (childId) => this._resolveChildShellLogDir(childId),
      getPromptCacheKey: () => this._promptCacheKey,
      getPreferredThinkingLevel: () => this._preferredThinkingLevel,
      getPrimaryAgent: () => this.primaryAgent,
      getAgentTemplates: () => this.agentTemplates,
      createFromPredefined: (templateName, taskId, persistedSelection) =>
        this._createSubAgentFromPredefined(templateName, taskId, persistedSelection),
      createFromPath: (templateDir, taskId, persistedSelection) =>
        this._createSubAgentFromPath(templateDir, taskId, persistedSelection),
      resolveTemplatePath: (relPath) => this._resolveTemplatePath(relPath),
      buildSubAgentSystemPrompt: (basePrompt, persistent) =>
        this._buildSubAgentSystemPrompt(basePrompt, persistent),
      createChildSession: (o) => {
        const childSession = new Session({
          primaryAgent: o.primaryAgent,
          config: this.config,
          promptsDirs: this._promptsDirs,
          projectRoot: this._projectRoot,
          homeDir: this._swarmflowHomeDir,
          sessionArtifactsDir: o.artifactsDir,
          shellLogDir: o.shellLogDir,
          capabilities: CHILD_SESSION_CAPABILITIES,
          // 子代理不写持久化文件：清单只在内存里，随子会话消亡
          taskStoreScope: "memory",
          onTurnOutput: o.onTurnOutput,
          toolExecutorOverrides: {},
          promptCacheKey: o.promptCacheKey,
          permissionMode: this.permissionMode,
          progress: this._progress,
          permissionRuleStore: this._permissionRuleStore,
          mcpManager: this.config.subAgentInheritMcp ? this._mcpManager : undefined,
          hooks: this.config.subAgentInheritHooks ? this.hookRuntime.hooks : undefined,
        });
        childSession.onSaveRequest = o.onSaveRequest;
        // 把子会话的 ask 变化冒泡到本会话（并间接到根会话）：子会话的 ask
        // 存在子会话自己的日志里，没有这个 hook，进程外的 UI（只订阅根会话）
        // 永远不知道有子代理在等待审批。
        childSession.subscribeAsk(() => this._notifyAskChanged());
        return childSession;
      },
    });
  }

  private _buildSubAgentFactory(): SubAgentFactory {
    return new SubAgentFactory({
      getAgentTemplates: () => this.agentTemplates,
      getConfig: () => this.config,
      getMcpManager: () => this._mcpManager,
      getPromptsDirs: () => this._promptsDirs,
      resolveSessionArtifacts: () => this._resolveSessionArtifacts(),
      resolveRoleModel: (role, persistedSelection) =>
        persistedSelection
          ? resolveRoleModelConfig(this, role, undefined, persistedSelection)
          : resolveRoleModelConfig(this, role, this.getSubagentSettings()),
    });
  }

  private get _subAgentFactoryInstance(): SubAgentFactory {
    return this._subAgentFactory ??= this._buildSubAgentFactory();
  }

  private _createSubAgentFromPredefined(
    templateName: string,
    taskId: string,
    persistedSelection?: PersistedRoleModelSelection,
  ): { agent: Agent; thinkingLevel?: string } {
    return this._subAgentFactoryInstance.createFromPredefined(templateName, taskId, persistedSelection);
  }

  private _createSubAgentFromPath(
    templateDir: string,
    taskId: string,
    persistedSelection?: PersistedRoleModelSelection,
  ): { agent: Agent; thinkingLevel?: string } {
    return this._subAgentFactoryInstance.createFromPath(templateDir, taskId, persistedSelection);
  }

  private _resolveTemplatePath(relPath: string): string {
    return this._subAgentFactoryInstance.resolveTemplatePath(relPath);
  }

  private _buildSubAgentSystemPrompt(basePrompt: string, persistent: boolean): string {
    return this._subAgentFactoryInstance.buildSubAgentSystemPrompt(basePrompt, persistent);
  }

  // _waitForAnyAgent 已移除 —— await_event 现在用 1s 轮询，激活循环也不再
  // 做隐式等待。模型应显式调用 await_event 等待子代理完成。

  // ==================================================================
  // 图片文件存储（v2 —— image_ref）
  // ==================================================================

  private _imageCounter = 0;

  // ==================================================================
  // 附件处理（实现见 ./session/attachments.ts）
  // ==================================================================


  _extractAndSaveImages(
    content: string | Array<Record<string, unknown>>,
  ): string | Array<Record<string, unknown>> {
    return extractAndSaveImages({
      projectRoot: this._projectRoot,
      sessionDir: () => this._store?.sessionDir,
      artifactsDir: () => this._sessionArtifactsOverride ?? this._getArtifactsDirIfAvailable?.(),
      supportsMultimodal: () => this.primaryAgent.modelConfig.supportsMultimodal,
      nextImageNumber: () => ++this._imageCounter,
    }, content);
  }

  _resolveImageRef(refPath: string): { data: string; media_type: string } | null {
    return resolveImageRef(this._store?.sessionDir, refPath);
  }

  private async _processFileAttachments(userInput: string): Promise<string | Array<Record<string, unknown>>> {
    return processAttachments({
      projectRoot: this._projectRoot,
      sessionDir: () => this._store?.sessionDir,
      artifactsDir: () => this._sessionArtifactsOverride ?? this._getArtifactsDirIfAvailable?.(),
      supportsMultimodal: () => this.primaryAgent.modelConfig.supportsMultimodal,
      nextImageNumber: () => ++this._imageCounter,
    }, userInput);
  }

  // ==================================================================
  // MCP 集成
  // ==================================================================

  async _ensureMcp(): Promise<void> {
    return ensureMcp(this);
  }

  // ==================================================================
  // 持久化
  // ==================================================================

  // getStateForPersistence() 与 restoreFromPersistence() 已移除。
  // 现在所有持久化都走 getLogForPersistence() / restoreFromLog()。

  _generateSummary(): string {
    for (const entry of this._log) {
      if (entry.type !== "user_message") continue;
      if (entry.apiRole !== "user") continue;
      if (entry.discarded || entry.archived) continue;
      const display = entry.display;
      if (!display) continue;
      if (SYSTEM_PREFIXES.some((prefix) => display.startsWith(prefix))) continue;
      this._cachedSummary = stripContextTags(display).slice(0, 100).trim();
      return this._cachedSummary;
    }

    const sessionDir = this._store?.sessionDir;
    if (sessionDir) {
      const archivedInputs = [...loadArchiveTurnIndexes(sessionDir).values()]
        .filter((turn) => turn.type === "input_received" && turn.turnKind === "user" && turn.preview)
        .sort((a, b) => a.turnIndex - b.turnIndex);
      const preview = archivedInputs[0]?.preview;
      if (preview) {
        this._cachedSummary = stripContextTags(preview).slice(0, 100).trim();
        return this._cachedSummary;
      }
    }

    this._cachedSummary = undefined;
    return "New session";
  }

  // ==================================================================
  // 资源清理
  // ==================================================================

  async close(): Promise<void> {
    this._closeHistoryPaging();
    try {
      return await closeSession(this);
    } finally {
      this._store?.releaseSessionLocks?.();
    }
  }
}
