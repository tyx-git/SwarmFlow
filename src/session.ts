/**
 * 多轮对话会话与上下文管理。
 *
 * 提供 Session 类——核心运行时编排器。
 * 管理主 Agent 的对话、
 * 自动压缩和子代理生命周期。
 */

import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
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

import { loadArchiveFile, restoreArchiveToEntries } from "./config/archive.js";
import { type GlobalTuiPreferences } from "./config/settings/legacy-preferences.js";
import { type LogSessionMeta } from "./config/session-meta.js";
import { saveLog } from "./config/log-serialization.js";

import type { SwarmflowSettings } from "./config/settings/types.js";
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
  estimatePromptSections,
  scalePromptBreakdown,
  type ContextBreakdown,
  type PromptSectionEstimates,
  type UsageStats,
} from "./session/usage-accounting.js";
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
  runCompactPhase,
  runManualCompact,
  runManualCompactBody,
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
// Constants
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
// MessageEnvelope —typed message envelope (see session/tree-types.ts)
// ------------------------------------------------------------------


// ChildSessionHandle / PreparedChildRestore —moved to ./session/children/types.ts
// BackgroundShellEntry —moved to ./session/background-shell/types.ts



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

  /** Tool permission gate —add advisors to control tool execution. */
  readonly toolGate = new ToolGate();

  /** Permission advisor —classifies tools and enforces permission mode. */
  _permissionAdvisor!: PermissionAdvisor;
  private _permissionRuleStore!: PermissionRuleStore;

  /** Hook runtime —fires events and evaluates hook commands. */
  readonly hookRuntime = new HookRuntime();

  _createdAt: string;
  /** Model identity snapshot taken at session creation. Stable across resumes and /model switches. */
  _initialModel: string;
  _title: string | undefined;
  private _cachedSummary: string | undefined;

  // Structured log —entries, revision, listeners, and id allocation live in
  // SessionLog (src/session/log.ts); these accessors keep the many
  // Session-internal `_log` / `_idAllocator` call sites unchanged.
  _logStore = new SessionLog();

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

  // Token tracking (per-response snapshot)
  _lastInputTokens = 0;
  _lastTotalTokens = 0;
  _lastCacheReadTokens = 0;
  _cacheSupported = false;

  // Cumulative usage (Total Input/Output/Cached/Uncached + system prompt) is
  // DERIVED from the log's token_update entries, not kept as live counters:
  // token_update entries persist across restore and survive compaction (they
  // carry no contextId/content to strip), so the log is the single source of
  // truth and live/restored values can't drift. Memoized by log length so
  // repeated usage-panel renders don't rescan the log.
  private _usageStatsCache: { logLen: number; stats: UsageStats } | null = null;

  // Per-section gptEncode estimates of the system prompt. Invalidated only
  // when the prompt is reassembled (_reloadPromptAndTools / _resetTransientState).
  private _promptSectionEstimates: { systemPrompt: number; tools: number; agentsMd: number; skills: number } | null = null;

  // Compact phase
  _compactInProgress = false;

  // Context-pressure state (thresholds and budget percent) lives in ContextManager.
  _contextManager!: ContextManager;

  private get _thresholds(): ContextThresholds {
    return this._contextManager.thresholds;
  }

  // Skills
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

  // Cached system prompt (static between reloads for prompt cache stability)
  private _cachedSystemPrompt: string | null = null;

  // Artifacts / persistence
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

  // File/bash rewind planning + application (owns the crash journal).
  private _rewindEngine!: RewindEngine;

  // Builds Agent instances for child sessions (templates + model resolution).
  // Lazily constructed so prototype-based test doubles get a working factory
  // wired to their own stubbed fields on first use.
  private _subAgentFactory?: SubAgentFactory;

  // Session tree / child sessions —state lives in ChildSessionManager.
  // Same-name private accessors below keep internal call sites and tests stable.
  private _childSessionManager?: ChildSessionManager;
  _shellManager!: BackgroundShellManager;

  // Session capabilities / routing
  _capabilities: SessionCapabilities = ROOT_SESSION_CAPABILITIES;
  private _turnOutputTarget?: (text: string) => void;
  private _selfPhase: ChildSessionPhase = "idle";
  _lifetimeToolCallCount = 0;
  _lastToolCallSummary = "";
  private _recentSessionEvents: string[] = [];

  // Active entry tracker —tracks which log entry is currently "live"
  _activeLogEntryId: string | null = null;

  /** Update the active entry tracker; implicitly marks previous reasoning as complete. */
  _setActiveLogEntry(entryId: string | null): void {
    if (this._activeLogEntryId === entryId) return;
    // If the previous active entry was a reasoning entry, mark it complete
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

  // Thinking level + accent
  _persistedModelSelection: PersistedModelSelection = {};
  _preferredThinkingLevel = "";
  _preferredAccentColor?: string;
  _thinkingLevel = "none";

  /** Stable key for OpenAI prompt cache routing affinity. */
  _promptCacheKey: string;

  /** fork 默认路由策略；可被 session.fork 的显式参数覆盖。 */
  readonly forkInheritPromptCacheKey: boolean;

  // Agent runtime state (for message delivery mode selection)
  _agentState: "working" | "idle" | "waiting" = "idle";

  // Inbox: holds messages for push delivery into tool results.
  // Typed message inbox —all messages flow through _deliverMessage.
  _inbox: MessageEnvelope[] = [];
  // True once a real user message has driven an activation (or was loaded from
  // a restored log). Gates tool-availability notices: skill/MCP changes made
  // before the first user message never queue a ride-along notice. Flipped in
  // _beginActiveInput; seeded on restore in _applyRestoredState.
  _conversationStarted = false;
  _currentTurnSignal: AbortSignal | null = null;
  _currentTurnAbortController: AbortController | null = null;

  // Turn serialization —prevents concurrent turn() calls from corrupting state
  _turnInFlight: Promise<string | void> | null = null;

  /**
   * SessionStart hooks 延迟到首个 turn 前执行一次。
   *
   * 在构造函数里同步等待会阻塞进程启动；fire-and-forget 又会让首轮请求
   * 看不到 hook 返回的上下文。延迟到首个 turn 前等待，两个问题都避开。
   */
  private _sessionStartHooksPromise: Promise<void> | null = null;

  /** Callback for incremental persistence —called at save-worthy checkpoints. */
  onSaveRequest?: () => void | boolean;
  /** Callback for MCP connection status —called after initial connect or reload. */
  onMcpStatus?: (statuses: McpServerStatus[]) => void;

  // Counters
  _turnCount = 0;
  private _workCount = 0;
  private _currentWorkId: string | null = null;
  private _currentWorkStartedAt = 0;
  _compactCount = 0;
  private _usedContextIds = new Set<string>();

  // Last time we ran a sync GC at idle (ms epoch). Used to throttle the
  // optional exposed GC call so back-to-back work boundaries don't burn
  // CPU on repeated full-heap collections.
  _lastIdleGcAt = 0;

  // Tool executors
  _toolExecutors: Record<string, ToolExecutor>;
  private _toolExecutorOverrides: Record<string, ToolExecutor> = {};

  // Ask state. All reads/writes go through the `_activeAsk` accessor pair so
  // every transition (suspend/resolve/restore/reset) notifies ask subscribers —  // including sites added in the future.
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

  // Ask / turn-lifecycle subscribers (UI + RPC layer). Log subscription alone
  // cannot observe child-session asks (they live in the child's log), so ask
  // state gets its own channel; child asks bubble to the root via the
  // createChildSession wiring.
  _askListeners = new Set<() => void>();
  private _turnLifecycleListeners = new Set<(event: TurnLifecycleEvent) => void>();

  /**
   * Subscribe to pending-ask changes (own asks and child-session asks).
   * Listeners receive no payload; call `getPendingAsk()` for current state.
   */
  /**
   * Subscribe to pending-ask changes (own asks and child-session asks).
   * Listeners receive no payload; call `getPendingAsk()` for current state.
   */
  subscribeAsk(listener: () => void): () => void {
    return subscribeAsk(this, listener);
  }

  /**
   * Subscribe to turn lifecycle events. Fires for every activation-loop run,
   * including auto-resume and post-approval resume turns that never pass
   * through an external entry point. `status: "waiting"` means the turn parked
   * on a pending ask —it has not completed.
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
        // Subscriber errors must never break the turn loop.
      }
    }
  }

  /** Allocate a unique random hex context ID. */
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

  /** Current input/turn index (1-based; advances as user inputs are delivered). */
  get turnCount(): number {
    return this._turnCount;
  }

  /** ISO timestamp of session creation. Stable across resumes. */
  get createdAt(): string {
    return this._createdAt;
  }

  /** Number of compactions performed in this session. */
  get compactCount(): number {
    return this._compactCount;
  }

  /** Attach the progress reporter that receives streaming UI events. */
  setProgressReporter(reporter: ProgressReporter | undefined): void {
    this._progress = reporter;
  }

  /** Detach the given reporter only if it is still the active one. */
  clearProgressReporter(reporter: ProgressReporter): void {
    if (this._progress === reporter) {
      this._progress = undefined;
    }
  }

  get lastTurnEndStatus(): "completed" | "interrupted" | "error" | null {
    return this._lastTurnEndStatus;
  }

  /** Child-session tree state + lifecycle (lazy: prototype-based test doubles
   * get a manager wired to their own stubbed fields on first use). */
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
    /** Promise from bootstrap's fire-and-forget connectAll(). Awaited on first turn. */
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
    /** Stable key for OpenAI prompt cache routing affinity. Auto-generated if omitted. */
    promptCacheKey?: string;
    /** fork 时默认继承父 prompt cache key（settings.json 控制）；默认 false。 */
    forkInheritPromptCacheKey?: boolean;
    /** Permission mode for this session. Default: "reversible". */
    permissionMode?: PermissionMode;
    /** Shared rule store for child sessions. If omitted, a new store is created. */
    permissionRuleStore?: PermissionRuleStore;
    /** Pre-loaded hook manifests. Each session keeps its own runtime; hooks are copied in. */
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
    // Thinking depth is user/provider controlled; off is the safe default.
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
    });

    // Apply context budget percentage.
    if (opts.contextBudgetPercent !== undefined) {
      this._contextManager.setBudgetPercent(opts.contextBudgetPercent);
    }

    // Attach store if provided (must be set before _initConversation)
    if (opts.store) {
      this._store = opts.store;
    }

    // Resolve runtime paths（system prompt 不再渲染这些值）
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
    });
    this._subAgentFactory = this._buildSubAgentFactory();

    // Permission system
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

    // Init tree-sitter bash parser (async, non-blocking)
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
  // Initialisation helpers
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

    // Assemble system prompt and cache it for prompt cache stability
    this._reloadPromptAndTools();
    this._appendEntry(
      createSystemPrompt(this._nextLogId("system_prompt"), this._cachedSystemPrompt!),
      false,
    );
    this._notifyLogListeners();
  }

  /**
   * Effective context length for a given ModelConfig, scaled by context budget percent.
   */
  _effectiveContextLength(mc: ModelConfig): number {
    return this._contextManager.effectiveContextLength(mc);
  }

  /** Context budget for pressure decisions (see ContextManager.budgetInfo). */
  private _contextBudgetInfo(): { budget: number; fullContext: boolean } {
    return this._contextManager.budgetInfo();
  }

  // ==================================================================
  // Message infrastructure
  // ==================================================================

  /**
   * Append a LogEntry to the structured log.
   * Auto-triggers save request and notifies log listeners.
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

  /** Allocate the next log entry ID for a given type. */
  _nextLogId(type: LogEntry["type"]): string {
    return this._logStore.nextId(type);
  }

  /** Live-session view for the shared log-surgery functions (session/log-surgery.ts). */
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
   * Run an optional synchronous GC at work boundaries to keep saw-tooth heap
   * growth in check during long sessions. Throttled to once per 10s so
   * rapid interrupt/restart cycles don't pile up GC pauses, and only on
   * "completed" status —interrupted/error paths may be followed by an
   * immediate restart where pausing is more visible to the user.
   */
  /**
   * Run an optional synchronous GC at work boundaries to keep saw-tooth heap
   * growth in check during long sessions. Throttled to once per 10s so
   * rapid interrupt/restart cycles don't pile up GC pauses, and only on
   * "completed" status —interrupted/error paths may be followed by an
   * immediate restart where pausing is more visible to the user.
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
   * Record an input_received entry.
   *
   * `_turnCount` (the "current input index" used by subsequent provider rounds)
   * advances to this new input ONLY when the agent is idle. While the agent
   * is working/waiting, the new input gets its own higher inputIndex but
   * `_turnCount` stays put —round entries from the in-flight activation must
   * keep using the current input's index until drain delivers the new one.
   */
  /**
   * Record an input_received entry.
   *
   * `_turnCount` (the "current input index" used by subsequent provider rounds)
   * advances to this new input ONLY when the agent is idle. While the agent
   * is working/waiting, the new input gets its own higher inputIndex but
   * `_turnCount` stays put —round entries from the in-flight activation must
   * keep using the current input's index until drain delivers the new one.
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

  /** Compute the next roundIndex for the given turn based on existing entries. */
  /** Compute the next roundIndex for the given turn based on existing entries. */
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

  /** Index of the first entry after the last live compact_marker (active window start). */
  /** Index of the first entry after the last live compact_marker (active window start). */
  _activeWindowStartIdx(): number {
    return activeWindowStartIdx(this);
  }

  /**
   * Find a tool_call entry by id within the active window (newest first).
   * Not scoped to the current turn: ask bookkeeping must keep pairing with
   * its tool_call even when the turn counter has moved on.
   */
  /**
   * Find a tool_call entry by id within the active window (newest first).
   * Not scoped to the current turn: ask bookkeeping must keep pairing with
   * its tool_call even when the turn counter has moved on.
   */
  _findToolCallEntry(toolCallId: string): LogEntry | undefined {
    return findToolCallEntry(this, toolCallId);
  }

  /** Turn/round anchor for ask bookkeeping, derived from the gated tool_call. */
  /** Turn/round anchor for ask bookkeeping, derived from the gated tool_call. */
  _toolCallAnchor(toolCallId: string, ask?: AskRequest | null): { turnIndex: number; roundIndex: number } {
    return toolCallAnchor(this, toolCallId, ask);
  }

  _findToolCallContextId(toolCallId: string, roundIndex?: number): string | undefined {
    return findToolCallContextId(this, toolCallId, roundIndex);
  }

  // ------------------------------------------------------------------
  // Unified message delivery (v2 architecture)
  // ------------------------------------------------------------------

  /**
   * Unified message delivery entry point.
   * All states push to inbox. Idle state also schedules auto-resume.
   * Working/waiting: the activation boundary or await_event poll drains.
   */
  /**
   * Unified message delivery entry point.
   * All states push to inbox. Idle state also schedules auto-resume.
   * Working/waiting: the activation boundary or await_event poll drains.
   */
  _deliverMessage(msg: MessageEnvelope): DeliverMessageResult {
    return deliverInboxMessage(this, msg);
  }

  /**
   * Public wrapper for TUI / GUI to deliver messages.
   * Preserves the original (source, content) signature for external callers.
   */
  /**
   * Public wrapper for TUI / GUI to deliver messages.
   * Preserves the original (source, content) signature for external callers.
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
   * Schedule an auto-resume turn for the idle state. Used when messages arrive
   * (sub-agent completion, shell exit, etc.) while the parent agent has no
   * active turn. Without this, the queued messages would sit in the log
   * unprocessed until the user manually starts a new turn.
   */
  /**
   * Schedule an auto-resume turn for the idle state. Used when messages arrive
   * (sub-agent completion, shell exit, etc.) while the parent agent has no
   * active turn. Without this, the queued messages would sit in the log
   * unprocessed until the user manually starts a new turn.
   */
  _scheduleAutoResume(): void {
    scheduleAutoResume(this);
  }

  /**
   * Run a turn that drains queued messages without taking new user input.
   * Acquires the turn lock to serialize with normal turn() calls.
   */
  /**
   * Run a turn that drains queued messages without taking new user input.
   * Acquires the turn lock to serialize with normal turn() calls.
   */
  async _autoResumeFromIdle(): Promise<void> {
    return autoResumeFromIdle(this);
  }

  /**
   * Scan the log backward to find whether the most recent turn-relevant entry
   * is a user_message that hasn't been responded to (no assistant_text/tool_call/
   * reasoning after it). Used by auto-resume to decide whether to fire a new
   * turn after a finally-block drain wrote messages without the model seeing
   * them.
   */
  /**
   * Scan the log backward to find whether the most recent turn-relevant entry
   * is a user_message that hasn't been responded to (no assistant_text/tool_call/
   * reasoning after it). Used by auto-resume to decide whether to fire a new
   * turn after a finally-block drain wrote messages without the model seeing
   * them.
   */
  _hasUnprocessedUserMessage(): boolean {
    return hasUnprocessedUserMessage(this);
  }

  /**
   * Check whether the inbox has pending messages.
   */
  /**
   * Check whether the inbox has pending messages.
   */
  _hasInboxMessages(): boolean {
    return hasInboxMessages(this);
  }

  /**
   * Check whether the inbox has pending WAKING messages. Ride-along messages
   * (wake === false) don't block manual context commands —they are passive
   * records (e.g. user-initiated kill notices) that wait for the next turn.
   */
  /**
   * Check whether the inbox has pending WAKING messages. Ride-along messages
   * (wake === false) don't block manual context commands —they are passive
   * records (e.g. user-initiated kill notices) that wait for the next turn.
   */
  _hasWakingInboxMessages(): boolean {
    return hasWakingInboxMessages(this);
  }

  /** Remove the previous completed task list when a real user input is delivered. */
  /** Remove the previous completed task list when a real user input is delivered. */
  _clearCompletedTasksBeforeUserInput(): void {
    clearCompletedTasksBeforeUserInput(this);
  }

  /**
   * Pre-activation prelude shared by every entry that records a NEW active
   * input (user message or /compact). The single choke point that
   * enforces wake:false ordering and the "conversation has started" boundary:
   *
   *   1. Earlier-arrived ride-along (wake:false) inbox messages land in the log
   *      first, in arrival order. `wake:false` means "do not start a turn by
   *      itself", not "jump behind the next active input".
   *   2. The new active input is recorded.
   *
   * Delivery to the model-facing log (user_message vs status entry) stays with
   * the caller —it legitimately differs per activation kind. The
   * "conversation started" flag is flipped at that delivery point
   * (_appendDeliveredUserMessage), so every user-message path sets it.
   */
  /**
   * Pre-activation prelude shared by every entry that records a NEW active
   * input (user message or /compact). The single choke point that
   * enforces wake:false ordering and the "conversation has started" boundary:
   *
   *   1. Earlier-arrived ride-along (wake:false) inbox messages land in the log
   *      first, in arrival order. `wake:false` means "do not start a turn by
   *      itself", not "jump behind the next active input".
   *   2. The new active input is recorded.
   *
   * Delivery to the model-facing log (user_message vs status entry) stays with
   * the caller —it legitimately differs per activation kind. The
   * "conversation started" flag is flipped at that delivery point
   * (_appendDeliveredUserMessage), so every user-message path sets it.
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
  // Background shells —UI surface (badge, picker, detail tab)
  // ------------------------------------------------------------------

  /** Snapshots of all tracked background shells for UI surfaces. */
  getBackgroundShellSnapshots(): BackgroundShellSnapshot[] {
    return this._shellManager.listShells();
  }

  /** Snapshot + log tail for the shell detail view. Null for unknown ids. */
  getBackgroundShellDetail(id: string, opts?: { maxChars?: number }): BackgroundShellDetail | null {
    return this._shellManager.getShellDetail(id, opts);
  }

  /**
   * User-initiated stop of a background shell (Shells panel / detail tab).
   * When a kill is actually performed, a ride-along system notice is queued
   * so the agent learns about it on its next turn —without being woken:
   * the user is present and steering.
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
  // Inbox drain —per-entry rendering
  // ------------------------------------------------------------------

  /**
   * Deliver queued messages to the model-facing log.
   *
   * User messages are displayed when received, then delivered here only after
   * the current provider round has finished. This preserves the API ordering:
   * user A →assistant A →user B, even when user B was typed while assistant A
   * was still streaming.
   */
  /**
   * Deliver queued messages to the model-facing log.
   *
   * User messages are displayed when received, then delivered here only after
   * the current provider round has finished. This preserves the API ordering:
   * user A →assistant A →user B, even when user B was typed while assistant A
   * was still streaming.
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

    // Clear active entry tracker on abort
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
  // Turn serialization
  // ------------------------------------------------------------------

  /**
   * Wait for any in-flight turn to finish. Safe to call at any time.
   * Used by resetForNewSession, close, and callers that need to ensure
   * the previous turn has fully unwound before proceeding.
   */
  /**
   * Wait for any in-flight turn to finish. Safe to call at any time.
   * Used by resetForNewSession, close, and callers that need to ensure
   * the previous turn has fully unwound before proceeding.
   */
  async waitForTurnComplete(): Promise<void> {
    return waitForTurnComplete(this);
  }

  /**
   * Promise-based turn lock. Ensures at most one turn entry point executes
   * at a time. Callers are serialized: if a turn is in flight, the next
   * caller waits for it to finish (which happens quickly after abort).
   */
  /**
   * Promise-based turn lock. Ensures at most one turn entry point executes
   * at a time. Callers are serialized: if a turn is in flight, the next
   * caller waits for it to finish (which happens quickly after abort).
   */
  async _withTurnLock<T>(fn: () => Promise<T>): Promise<T> {
    return withTurnLock(this, fn);
  }

  /**
   * Prepare and execute interruption cleanup for the current turn.
   *
   * This captures a non-destructive delivery snapshot first, then kills active
   * workers and drops unconsumed runtime state.
   */
  /**
   * Prepare and execute interruption cleanup for the current turn.
   *
   * This captures a non-destructive delivery snapshot first, then kills active
   * workers and drops unconsumed runtime state.
   */
  requestTurnInterrupt(): { accepted: true } {
    return requestTurnInterrupt(this);
  }

  denyAndInterruptPendingAsk(): { accepted: boolean; reason?: string; turnFinished?: boolean } {
    return denyAndInterruptPendingAsk(this);
  }

  /** Stop all running child sessions for RPC and lifecycle callers. */
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
   * If a permission approval or agent_question ask is pending, synthesize
   * Deny/Decline resolution + denial tool_result. Returns true if anything
   * was denied. Called by TUI on ESC/Ctrl+C while a prompt is showing.
   */
  /**
   * If a permission approval or agent_question ask is pending, synthesize
   * Deny/Decline resolution + denial tool_result. Returns true if anything
   * was denied. Called by TUI on ESC/Ctrl+C while a prompt is showing.
   */
  denyPendingAsk(): boolean {
    return denyPendingAsk(this);
  }

  /**
   * Backward-compatible alias.
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
    this._promptSectionEstimates = null;
    this._compactInProgress = false;
    this._agentState = "idle";
    this._inbox = [];
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    // _waitHandle removed —await_event uses polling now
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
  // Log accessors (v2)
  // ------------------------------------------------------------------

  /** Read-only snapshot of the structured log. */
  get log(): readonly LogEntry[] {
    return this._log;
  }

  /** Display cutoff index — entries before this index are hidden from UI but preserved for model context. */
  private _displayCutoff = 0;

  /** Read-only snapshot of the log filtered by display cutoff. */
  getDisplayLog(): readonly LogEntry[] {
    return this._displayCutoff > 0
      ? this._log.slice(this._displayCutoff)
      : this._log;
  }

  /** Set display cutoff to current log length (used by /clear). */
  setDisplayCutoff(): void {
    this._displayCutoff = this._log.length;
    this._logStore.bumpRevision();
  }

  /** Reset display cutoff to 0 (show all entries). */
  resetDisplayCutoff(): void {
    this._displayCutoff = 0;
  }

  getLogRevision(): number {
    return this._logStore.revision;
  }

  /** The ID of the currently active (streaming/executing) log entry, or null. */
  get activeLogEntryId(): string | null {
    return this._activeLogEntryId;
  }

  /** Subscribe to log changes. Returns an unsubscribe function. */
  subscribeLog(listener: () => void): () => void {
    return this._logStore.subscribe(listener);
  }

  // ------------------------------------------------------------------
  // Turn listing (shared by rewind and history projections)
  // ------------------------------------------------------------------

  /**
   * Return metadata for every turn in the log (see SessionLog.listTurns).
   * Shared by rewind and history projections.
   */
  listTurns(): TurnListing[] {
    return this._logStore.listTurns();
  }

  // ------------------------------------------------------------------
  // Rewind
  // ------------------------------------------------------------------

  /**
   * Get the list of turn boundaries available for rewind.
   * Only shows real user turns (not injected or compact turns).
   * Includes turns before compact markers (rewind undoes compacts).
   * Returns turns in reverse chronological order (most recent first).
   */
  getRewindTargets(): RewindTargetTurn[] {
    const userTurns = this.listTurns().filter(t => t.turnKind === "user");

    // Collect per-turn mutation data: distinct paths, additions, deletions
    interface TurnMutData {
      livePaths: Set<string>;
      revertedPaths: Set<string>;
      additions: number;
      deletions: number;
    }
    const perTurn = new Map<number, TurnMutData>();
    for (const entry of this._log) {
      if (entry.type !== "tool_result" || entry.discarded) continue;
      const meta = entry.meta as Record<string, unknown>;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const fm = toolMeta?.fileMutation as FileMutation | undefined;
      if (!fm) continue;
      const ti = entry.turnIndex;
      let cur = perTurn.get(ti);
      if (!cur) { cur = { livePaths: new Set(), revertedPaths: new Set(), additions: 0, deletions: 0 }; perTurn.set(ti, cur); }
      if (meta.fileMutationReverted) {
        cur.revertedPaths.add(fm.path);
      } else {
        cur.livePaths.add(fm.path);
        cur.additions += fm.additions ?? 0;
        cur.deletions += fm.deletions ?? 0;
      }
    }

    // Suffix accumulation: cumulative from each turn to the end
    const turnIndices = userTurns.map(t => t.turnIndex);
    const cumulative = new Map<number, { fileCount: number; additions: number; deletions: number; allReverted: boolean }>();
    const suffixLivePaths = new Set<string>();
    const suffixRevertedPaths = new Set<string>();
    let suffixAdd = 0;
    let suffixDel = 0;
    for (let i = turnIndices.length - 1; i >= 0; i--) {
      const ti = turnIndices[i];
      const cur = perTurn.get(ti);
      if (cur) {
        for (const p of cur.livePaths) suffixLivePaths.add(p);
        for (const p of cur.revertedPaths) suffixRevertedPaths.add(p);
        suffixAdd += cur.additions;
        suffixDel += cur.deletions;
      }
      const hasLive = suffixLivePaths.size > 0;
      const allReverted = !hasLive && suffixRevertedPaths.size > 0;
      cumulative.set(ti, {
        fileCount: suffixLivePaths.size,
        additions: suffixAdd,
        deletions: suffixDel,
        allReverted,
      });
    }

    return userTurns
      .map(t => {
        const cum = cumulative.get(t.turnIndex) ?? { fileCount: 0, additions: 0, deletions: 0, allReverted: false };
        return {
          turnIndex: t.turnIndex,
          entryIndex: t.entryIndex,
          preview: t.preview,
          timestamp: t.timestamp,
          fileCount: cum.fileCount,
          additions: cum.additions,
          deletions: cum.deletions,
          filesReverted: cum.allReverted,
        };
      })
      .reverse();
  }

  /** Build a rewind plan (see RewindEngine.planRewind). */
  async planRewind(fromTurnIndex: number): Promise<RewindPlan> {
    return this._rewindEngine.planRewind(fromTurnIndex);
  }

  /**
   * Rewind conversation only: truncate log from the given turn onward.
   */
  rewindConversation(toTurnIndex: number): { removed: number; error?: string } {
    if (this._turnInFlight) {
      return { removed: 0, error: "Cannot rewind while a turn is in progress." };
    }

    const cutoff = this._log.findIndex(
      (e) => e.turnIndex >= toTurnIndex && (e.type === "input_received" || e.type === "turn_start") && !e.discarded,
    );
    if (cutoff < 0) {
      return { removed: 0, error: `Turn ${toTurnIndex} not found in log.` };
    }

    this._killChildSessionsAndShells();
    const removed = this._log.length - cutoff;
    const removedEntries = this._log.slice(cutoff);
    this._log.length = cutoff;
    // Truncation bypasses SessionLog's append/replace paths —drop its lookup
    // indexes (entry ids can even be reused after the allocator re-bases below).
    this._logStore.invalidateIndexes();
    this._restoreArchivesRescindedBy(removedEntries);
    this._resetAfterRewind();
    return { removed };
  }

  /**
   * Rewind truncation can remove a summary entry or compact marker whose
   * covered / pre-compact entries had their content archived to disk. Those
   * entries are live context again after the rewind, but the API projection
   * silently skips archived entries with null content —so restore their
   * content from the archive files, or the revived window would have holes.
   * Missing/corrupt archive files degrade to leaving the entries archived.
   */
  private _restoreArchivesRescindedBy(removedEntries: LogEntry[]): void {
    const sessionDir = this._store?.sessionDir as string | undefined;
    if (!sessionDir) return;
    for (const entry of removedEntries) {
      if (entry.discarded) continue;
      let fileName: string | null = null;
      if (entry.type === "summary") {
        fileName = `summary-${entry.id}.json.gz`;
      } else if (entry.type === "compact_marker") {
        const idx = (entry.meta as Record<string, unknown>)["compactIndex"];
        if (typeof idx === "number") fileName = `window-${idx}.json.gz`;
      }
      if (!fileName) continue;
      try {
        const archived = loadArchiveFile(sessionDir, fileName);
        if (archived) restoreArchiveToEntries(this._log, archived);
      } catch {
        // Corrupt archive —keep the entries archived (today's behavior).
      }
    }
  }

  /**
   * Rewind files only: apply reverse patches and mark mutations as reverted.
   * Does not truncate the conversation log.
   */
  async rewindFiles(plan: RewindPlan): Promise<RewindApplyResult> {
    if (this._turnInFlight) {
      return { revertedPaths: [], conflictPaths: [], bashReverted: [], bashSkipped: [], error: "Cannot rewind while a turn is in progress." };
    }

    const result = await this._rewindEngine.applyFiles(plan);
    if (!result.error) {
      this._bumpLogRevision();
      this._notifyLogListeners();
      this.onSaveRequest?.();
    }
    return result;
  }

  /**
   * Rewind both conversation and files.
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
    // Keep the "conversation started" flag truthful to the rewound log: a rewind
    // that drops every real user message must re-suppress availability notices.
    this._conversationStarted = this._entriesHaveRealUserMessage(log);
    for (const entry of log) {
      const ctx = (entry.meta as Record<string, unknown>)?.["contextId"];
      if (typeof ctx === "string") this._usedContextIds.add(ctx);
      if (entry.type === "compact_marker" && !entry.discarded) {
        this._compactCount += 1;
      }
      if (entry.type === "work_start" && !entry.discarded) {
        this._workCount += 1;
      }
    }

    this._bumpLogRevision();
    this._notifyLogListeners();
    this.onSaveRequest?.();
  }

  /**
   * Check for and recover from a crashed rewind on session restore.
   */
  recoverRewindIfNeeded(): boolean {
    const recovered = this._rewindEngine.recoverJournalIfNeeded();
    if (!recovered) return false;
    let saved = false;
    try {
      saved = this.onSaveRequest?.() === true;
    } catch {
      // Keep the recovery journal until a later save confirms the log state.
    }
    if (saved) this._rewindEngine.finalizeJournal();
    return true;
  }

  /** Mark a rewind transaction complete after the caller has saved the log. */
  finalizeRewindJournal(): void {
    this._rewindEngine.finalizeJournal();
  }

  /**
   * Restore session from a loaded log.
   */
  /**
   * Restore session from a loaded log.
   */
  prepareRestoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    _idAllocator: LogIdAllocator,
  ): PreparedSessionRestore {
    return prepareRestoreFromLog(this, meta, entries, _idAllocator);
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

  /** Single assignment pass for a parsed restore (no failure paths in here). */
  _applyRestoredState(state: RestoredSessionState): void {
    this.primaryAgent.replaceModelConfig({ ...state.modelConfig });
    this._persistedModelSelection = { ...state.persistedModelSelection };

    this._log = state.entries;
    // A restored log that already holds a real user message means the
    // conversation has started —toggling MCP/skills after resume should queue
    // notices normally. Seed the flag here (the single restore commit point).
    this._conversationStarted = this._entriesHaveRealUserMessage(state.entries);
    // Do NOT reset the log revision —it is a transient change-detection
    // counter that must stay monotonically increasing on *this* session so
    // that UI subscribers (shouldSyncTranscript) always detect the swap.
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
    this._lifetimeToolCallCount = state.signals.lifetimeToolCallCount;
    this._lastToolCallSummary = state.signals.lastToolCallSummary;
    this._recentSessionEvents = [...state.signals.recentSessionEvents];
    this._lastTurnEndStatus = state.signals.lastTurnEndStatus;
    this._selfPhase = state.signals.selfPhase;
    this._activeLogEntryId = null;
    // A parsed restore carries no live ask/turn state: open asks were
    // deny-resolved during parsing and the interrupted turn was normalized.
    this._activeAsk = null;
    this._askHistory = state.askHistory;
    this._agentState = "idle";
    this._inbox = [];
    this._pendingTurnState = null;
  }

  private _normalizeInterruptedTurnFromLog(message: string): void {
    normalizeInterruptedTurnInLog(this._logSurgeryView(), message);
  }

  /**
   * Get log data for persistence (v2).
   * Returns meta + entries suitable for saveLog().
   */
  /**
   * Get log data for persistence (v2).
   * Returns meta + entries suitable for saveLog().
   */
  getLogForPersistence(): { meta: LogSessionMeta; entries: readonly LogEntry[] } {
    return getLogForPersistence(this);
  }

  setStore(store: any): void {
    this._store = store;
    // 路径不再进入 system snapshot，绑定 store 不触发提示词重建。
  }

  /**
   * Full reset for /new —equivalent to constructing a fresh Session.
   * Leaves storage unbound; session/artifacts directories are created lazily
   * on the first subsequent turn.
   */
  async resetForNewSession(newStore?: any): Promise<void> {
    // 0. Terminate any in-flight turn before resetting
    this.requestTurnInterrupt();
    await this.waitForTurnComplete();

    // 1. Kill active sub-agents, reset transient flags
    this._resetTransientState();
    this._resetHookContextForNewSession();

    // 2. Update store FIRST (so path resolution picks up new session)
    if (newStore !== undefined) {
      this._store = newStore;
    }

    // 3. Reset counters
    this._turnCount = 0;
    this._workCount = 0;
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    this._compactCount = 0;
    this._usedContextIds = new Set<string>();

    // 4. Reset thinking state
    this._thinkingLevel = this._preferredThinkingLevel || "off";

    // 5. Reset MCP connection flag (will reconnect on next turn)
    this._mcpConnected = false;

    // 6. Drop the in-memory task list. The file stays in the old session
    // directory (each session owns its own tasks.json).
    this._taskStoreRef = undefined;
    this._taskStoreKey = undefined;
    if (this._taskListeners.length > 0) this._notifyTaskListeners();

    // 7. /new must start from a truly fresh session tree. _resetTransientState()
    // archives existing children so they can be saved before teardown, but those
    // archived handles must not leak into the next root session's persisted meta.
    this._childSessionManagerInstance.clearTables();

    // 8. Re-init conversation LAST (fresh session state, storage may still be lazy)
    // _initConversation also resets _log and _idAllocator
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
  // Skills
  // ==================================================================

  /** Read-only access to loaded skills (for command registration). */
  /** Read-only access to loaded skills (for command registration). */
  get skills(): ReadonlyMap<string, SkillMeta> {
    return getSkills(this);
  }

  // ==================================================================
  // Sub-agent introspection (for TUI/GUI)
  // ==================================================================

  getAgentLog(agentId: string): readonly LogEntry[] | null {
    // Same path as getChildSessionLog —the manager serves released
    // children's logs from disk.
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

  /** Read-only access to disabled skill names. */
  /** Read-only access to disabled skill names. */
  get disabledSkills(): ReadonlySet<string> {
    return getDisabledSkills(this);
  }

  /**
   * Return all skills from disk (both enabled and disabled) for UI display.
   */
  /**
   * Return all skills from disk (both enabled and disabled) for UI display.
   */
  getAllSkillNames(): { name: string; description: string; enabled: boolean }[] {
    return getAllSkillNames(this);
  }

  /** 是否存在尚未通过 /reload 应用的 skill 变更。 */
  /** 是否存在尚未通过 /reload 应用的 skill 变更。 */
  get skillsDirty(): boolean {
    return skillsDirty(this);
  }

  /** Enable or disable a skill by name. The change applies on the next /reload. */
  /** Enable or disable a skill by name. The change applies on the next /reload. */
  setSkillEnabled(name: string, enabled: boolean): void {
    setSkillEnabled(this, name, enabled);
  }

  /**
   * Rescan skill directories, apply disabled filter, and rebuild
   * the skill tool definition. Explicit /reload only.
   * Returns change report for callers that need it (e.g. /skills command).
   */
  /**
   * Rescan skill directories, apply disabled filter, and rebuild
   * the skill tool definition. Explicit /reload only.
   * Returns change report for callers that need it (e.g. /skills command).
   */
  reloadSkills(): { added: string[]; removed: string[]; total: number } {
    return reloadSkills(this);
  }

  /**
   * Build the fixed `skill` tool definition.
   *
   * skills 列表位于 system prompt；工具的 description 不随 skills 集合变化，
   * 从而保持 tools 段字节稳定。
   */
  /**
   * Build the fixed `skill` tool definition.
   *
   * skills 列表位于 system prompt；工具的 description 不随 skills 集合变化，
   * 从而保持 tools 段字节稳定。
   */
  private _ensureSkillTool(): void {
    ensureSkillToolForSession(this);
  }

  /**
   * Refresh skills from disk. Called during prompt/tool reload so installed,
   * removed, or modified skills update the dynamic skill tool definition.
   */
  /**
   * Refresh skills from disk. Called during prompt/tool reload so installed,
   * removed, or modified skills update the dynamic skill tool definition.
   */
  private _refreshSkills(): void {
    refreshSkills(this);
  }

  /** Execute the `skill` tool —load and return skill instructions. */
  /** Execute the `skill` tool —load and return skill instructions. */
  private _execSkill(
    args: Record<string, unknown>,
  ): ToolResult {
    return execSkill(this, args);
  }

  // ==================================================================
  // Shared helpers
  // ==================================================================

  _sortedUnique(values: Iterable<string | undefined | null>): string[] {
    return [...new Set([...values].filter((v): v is string => typeof v === "string" && v.length > 0))]
      .sort((a, b) => a.localeCompare(b));
  }

  /** Scan-once helper: do the given entries contain a delivered real user
   * message? Used only to seed _conversationStarted on restore —the live guard
   * reads the cached flag, not this. */
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
   * Reload MCP servers from settings. Reads global + local settings,
   * reconfigures the MCPClientManager, and notifies the TUI.
   * Returns a human-readable summary of what changed.
   */
  /**
   * Reload MCP servers from settings. Reads global + local settings,
   * reconfigures the MCPClientManager, and notifies the TUI.
   * Returns a human-readable summary of what changed.
   */
  async reloadMcp(options?: { notice?: boolean; reason?: string }): Promise<string> {
    return reloadMcp(this, options);
  }

  async reconnectMcpServer(serverName: string): Promise<boolean> {
    return reconnectMcpServer(this, serverName);
  }

  // Command-facing MCP mutation: acquire the turn lock so the connect/disconnect
  // (and the ride-along notice it queues) cannot overlap a turn's tool snapshot.
  // The bare reloadMcp/reconnectMcpServer stay lock-free on purpose —the reload
  // path that needs them runs either inside a turn's tool execution or wrapped by
  // a command-side _withTurnLock, and _withTurnLock is not reentrant, so
  // re-locking there would deadlock.
  // Command-facing MCP mutation: acquire the turn lock so the connect/disconnect
  // (and the ride-along notice it queues) cannot overlap a turn's tool snapshot.
  // The bare reloadMcp/reconnectMcpServer stay lock-free on purpose —the reload
  // path that needs them runs either inside a turn's tool execution or wrapped by
  // a command-side _withTurnLock, and _withTurnLock is not reentrant, so
  // re-locking there would deadlock.
  async reloadMcpFromCommand(reason: string): Promise<string> {
    return reloadMcpFromCommand(this, reason);
  }

  async reconnectMcpServerFromCommand(serverName: string): Promise<boolean> {
    return reconnectMcpServerFromCommand(this, serverName);
  }

  // The /mcp command warms up MCP status before showing the picker. That ensure
  // can connect servers (mutating agent.tools), so it must serialize against
  // turns just like the reload/reconnect variants —no MCP connection work on
  // the command side may run concurrently with a turn's tool snapshot.
  // The /mcp command warms up MCP status before showing the picker. That ensure
  // can connect servers (mutating agent.tools), so it must serialize against
  // turns just like the reload/reconnect variants —no MCP connection work on
  // the command side may run concurrently with a turn's tool snapshot.
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

    // 1. Reload skills + system prompt
    const skillResult = this.reloadSkills();
    report.push(
      `Skills: ${skillResult.total} loaded` +
      (skillResult.added.length ? `, +${skillResult.added.join(", ")}` : "") +
      (skillResult.removed.length ? `, -${skillResult.removed.join(", ")}` : ""),
    );

    // 2. Rebuild system prompt
    this._rebuildSystemPrompt();
    report.push("System prompt: rebuilt");

    // 3. Reload MCP
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

  // ==================================================================
  // Session title
  // ==================================================================

  setTitle(title: string): void {
    this._title = title || undefined;
    // No onSaveRequest —renaming should not update last_active_at.
    // The caller (store:renameSession) writes title to disk directly.
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
  // Thinking level + cache hit
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

  /** The model name from the primary agent's config. */
  get currentModelName(): string {
    return this.primaryAgent.modelConfig.model;
  }

  /** The config name for the current model (e.g., "my-claude"). */
  get currentModelConfigName(): string {
    return this.primaryAgent.modelConfig.name;
  }

  /**
   * Switch the primary agent to a different model config.
   * Only callable between turns (not while a turn is in progress).
   */
  /**
   * Switch the primary agent to a different model config.
   * Only callable between turns (not while a turn is in progress).
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

  /** Input tokens from the most recent provider response. */
  get lastInputTokens(): number {
    return this._lastInputTokens;
  }

  set lastInputTokens(value: number) {
    this._lastInputTokens = value;
  }

  /** Total tokens (input + output) from the most recent provider response. */
  get lastTotalTokens(): number {
    return this._lastTotalTokens;
  }

  set lastTotalTokens(value: number) {
    this._lastTotalTokens = value;
  }

  /** Cache-read tokens from the most recent provider response. */
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

  // 鈹€鈹€ Cumulative usage stats (derived from log token_update entries) 鈹€鈹€

  /**
   * Estimate token counts for each section of the system prompt using
   * gpt-tokenizer. Cached until prompt/skills/tools reload.
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
   * Recompute cumulative usage by summing every token_update entry in the log.
   * Memoized by log length: the result only changes when entries are appended
   * (live turn) or the log is replaced (restore / new session).
   */
  private _computeUsageStats(): UsageStats {
    const logLen = this._log.length;
    const cached = this._usageStatsCache;
    if (cached && cached.logLen === logLen) return cached.stats;

    const agg = aggregateTokenUsage(this._log);
    const systemPromptTotal = Math.max(0, agg.firstInput - agg.firstUserMessageTokens);
    const est = this._getPromptSectionEstimates();

    const stats: UsageStats = {
      cumulativeInput: agg.cumulativeInput,
      cumulativeOutput: agg.cumulativeOutput,
      cumulativeCacheRead: agg.cumulativeCacheRead,
      cumulativeUncached: agg.cumulativeUncached,
      systemPromptTotal,
      systemPromptBreakdown: scalePromptBreakdown(est, systemPromptTotal),
    };
    this._usageStatsCache = { logLen, stats };
    return stats;
  }

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

  /** Effective context budget: contextLength 脳 context budget percent. */
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
      // The catch must live INSIDE the lock: the failure flags are reset per
      // lock acquisition, and a queued claimant resumes before an outside
      // catch would run —double-writing or suppressing the entry.
      try {
        this._ensureSessionStorageReady();
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

  /** Body of runManualCompact. Caller holds the turn lock. */
  /** Body of runManualCompact. Caller holds the turn lock. */
  async _runManualCompactBody(
    instruction?: string,
    options?: { signal?: AbortSignal; completionDisplay?: string },
  ): Promise<void> {
    return runManualCompactBody(this, instruction, options);
  }

  // ==================================================================
  // Ask state
  // ==================================================================

  /**
   * Restore ask state from log entries.
   * Scans for unclosed ask_request (no matching ask_resolution).
   */
  /**
   * Restore ask state from log entries.
   * Scans for unclosed ask_request (no matching ask_resolution).
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

  /** Returns true if the path is strictly inside the session artifacts dir. */
  /** Returns true if the path is strictly inside the session artifacts dir. */
  _isInsideArtifactsDir(rawPath: unknown): boolean {
    return isInsideArtifactsDir(this, rawPath);
  }

  _beforeToolExecute = (ctx: ToolPreflightContext): Promise<ToolPreflightDecision | void> =>
    beforeToolExecute(this, ctx);


  // ==================================================================
  // Main turn loop
  // ==================================================================

  async resumePendingTurn(options?: { signal?: AbortSignal }): Promise<string> {
    return this._withTurnLock(async () => {
      if (this._activeAsk) {
        throw new Error("Cannot resume while an ask is still pending approval.");
      }
      const pending = this._pendingTurnState;
      if (!pending) return "";

      this._pendingTurnState = null;
      if (pending.stage === "pre_user_input") {
        // Already inside the lock —call the inner turn logic directly
        return this._turnInner(pending.userInput ?? "", options);
      }

      return this._resumeActivationStage(options);
    });
  }

  /**
   * Continue a turn that suspended mid-activation (approval resolved, question
   * answered). Single canonical resume path —turn() and resumePendingTurn()
   * both land here, so pending approved tool_calls always execute and queued
   * messages are always delivered, whichever entry point the UI used.
   * Caller must hold the turn lock and have cleared _pendingTurnState.
   */
  async _resumeActivationStage(options?: { signal?: AbortSignal }): Promise<string> {
    // 恢复路径会绕过 _turnInner；同样保证 SessionStart 上下文只执行一次。
    await this._ensureSessionStartHooks();
    // The suspended turn never closed its work, so the previous turn's end
    // status is stale here; null it like every other turn entry point so the
    // error path below can tell whether work still needs closing.
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
    // Install the turn signal early so that _drainPendingToolCalls can
    // pass it to tool executors (e.g. client-side web_search).
    const turnSignalState = this._installCurrentTurnSignal(options?.signal);

    const interruptionStartIdx = this._findEarliestPendingToolCallLogIndex();

    try {
      // Drain any pending tool_calls (including the just-approved one and any
      // siblings that were emitted in parallel but never reached). This is the
      // single, canonical execution path post-approval. Stops on suspension.
      const drainResult = await this._drainPendingToolCalls(turnSignalState.signal);
      if (drainResult.kind === "suspended") {
        return "";
      }
      if (drainResult.kind === "interrupted") {
        this._finalizeDrainInterruptedWork(interruptionStartIdx);
        return "";
      }

      // Post-resume activation boundary drain: tool_results from the
      // just-resolved approval are in the log; drain any queued inbox
      // messages before the model sees them in the next activation.
      if (this._hasInboxMessages()) {
        this._drainInboxAsEntries();
      }
    } finally {
      this._restoreCurrentTurnSignal(turnSignalState);
    }

    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    const result = await this._runTurnActivationLoop(options?.signal, textAccumulator, reasoningAccumulator);
    // Notify parent of the resumed turn's output. Without this, post-approval
    // assistant_text is lost and agent_result.content shows "(no output)".
    if (!this._activeAsk) {
      this._turnOutputTarget?.(result?.trim() || "");
      if (result?.trim()) this._recordSessionEvent("returned output");
    }
    return result;
  }

  /**
   * Resume-drain interruption starts from the earliest unresolved tool_call in
   * the active window, not from the current log tail: orphan tool_calls were
   * emitted before the approval ask and must be visible to interruption cleanup.
   * Scanned window-wide (not per-turn): the turn counter may have advanced
   * while the work was suspended, but its orphans still need completion.
   */
  /**
   * Scan the active window for the first tool_call without a matching
   * tool_result anywhere in the window. Single implementation shared by the
   * index- and object-shaped callers. Two-pass on purpose: a merged
   * single-pass with a pending map measured ~2.8x slower in
   * scripts/bench-log-hotpaths.ts (Map insert/delete churn beats the
   * second pass's early exit).
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
   * Drain pending tool_calls in the current turn (in emission order).
   * For each: gate →execute →append tool_result, updating tool_call meta.
   * Returns a structured result so approval suspension and interruption are
   * not collapsed into the same empty-string resume path.
   *
   * This is the single canonical path for executing tool_calls outside of
   * the streaming tool-loop —used after approval resume and to handle
   * orphan parallel tool_calls.
   */
  /**
   * Drain pending tool_calls in the current turn (in emission order).
   * For each: gate →execute →append tool_result, updating tool_call meta.
   * Returns a structured result so approval suspension and interruption are
   * not collapsed into the same empty-string resume path.
   *
   * This is the single canonical path for executing tool_calls outside of
   * the streaming tool-loop —used after approval resume and to handle
   * orphan parallel tool_calls.
   */
  async _drainPendingToolCalls(signal?: AbortSignal): Promise<DrainPendingToolCallsResult> {
    return drainPendingToolCalls(this, signal);
  }

  /**
   * Find the next pending tool_call in the active window (no matching result),
   * in log/emission order. Returns null when all are resolved.
   * Window-wide rather than per-turn: an approved tool_call must execute on
   * resume even if the turn counter advanced while the ask was pending.
   */
  /**
   * Find the next pending tool_call in the active window (no matching result),
   * in log/emission order. Returns null when all are resolved.
   * Window-wide rather than per-turn: an approved tool_call must execute on
   * resume even if the turn counter advanced while the ask was pending.
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

  /** Update tool_call entry's toolExecState meta in-place. */
  /** Update tool_call entry's toolExecState meta in-place. */
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

  async turn(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
    const turnLog = getLogger("session.turn");
    turnLog.info("turn:enter", { len: userInput.length, hasSignal: Boolean(options?.signal) });
    return this._withTurnLock(async () => {
      try {
        const result = await this._turnInner(userInput, options);
        turnLog.info("turn:exit:ok");
        return result;
      } catch (err) {
        turnLog.error("turn:exit:err", { err: err instanceof Error ? err.message : String(err) });
        // Catch-all for failures _turnInner's own catch doesn't reach
        // (storage/MCP/attachments/before-turn compact). Idempotent against
        // the inner layers via the per-lock once-flags.
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

  /** Inner turn logic, called from within the turn lock. */
  async _turnInner(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
    // A pending ask owns the conversation: the turn cannot run until the user
    // answers. New input is queued (Q5) and delivered when work resumes —    // never dropped, never run into the suspended round's bookkeeping.
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

    this._ensureSessionStorageReady();
    await this._ensureSessionStartHooks();

    const signal = options?.signal;
    if (this._pendingTurnState) {
      // Already inside the lock via turn() —resume inline (calling turn()
      // here would deadlock on the turn lock).
      const pending = this._pendingTurnState;
      this._pendingTurnState = null;
      if (pending.stage === "pre_user_input") {
        return this._turnInner(pending.userInput ?? "", options);
      }
      // New input arriving through turn() while work waits to continue:
      // queue it first so the canonical resume path delivers it (Q5).
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

    // skipUserInput path: auto-resume from idle. Drain inbox as individual
    // entries instead of writing a synthetic empty user input.
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
      // Fire UserPromptSubmit hooks (can deny or modify the prompt)
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
      // Merge inline images (clipboard paste) into multimodal content
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

      // display = original user input (what they typed); content = expanded for API
      const displayText = userInput;
      // For the log entry, replace inline base64 images with image_ref file paths
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

    // Ensure MCP is connected (after user message is displayed).
    if (this._mcpManager) {
      await this._ensureMcp();
    }

    // Before-turn auto-compact: if last known usage + estimated new tokens
    // exceeds the threshold, compact now so the activation runs in fresh context.
    if (this._capabilities.includeSpawnTool && !this._compactInProgress) {
      const { budget } = this._contextBudgetInfo();
      if (budget > 0) {
        const estimatedTokens = this._lastInputTokens + gptEncode(userInput).length;
        const beforeTurnRatio = this._thresholds.compact_before_turn / 100;
        if (estimatedTokens > beforeTurnRatio * budget) {
          const logLenBefore = this._log.length;
          try {
            await this._doAutoCompact("before_turn", signal);
          } catch (compactErr) {
            this._discardCompactAttemptEntries(logLenBefore);
            if (signal?.aborted || this._isCompactAbortError(compactErr)) {
              this._beginWorkIfNeeded();
              this._appendInterruptionSystemMessage([], true);
              this._recordSessionEvent("interrupted by user");
              this._finishCurrentWork("interrupted");
            }
            throw compactErr;
          }
          // Messages held back during compact (Q6) land after the marker.
          if (this._hasInboxMessages()) {
            this._drainInboxAsEntries();
          }
          this.onSaveRequest?.();
        }
      }
    }

    // Track streamed content for abort recovery
    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    try {
      const result = await this._runTurnActivationLoop(signal, textAccumulator, reasoningAccumulator);
      // Always notify parent —even for empty results.
      if (!this._activeAsk) {
        this._turnOutputTarget?.(result?.trim() || "");
        if (result?.trim()) this._recordSessionEvent("returned output");
      }
      return result;
    } catch (err) {
      // Deliver error to parent so it's never silently lost
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

  /** True when the error is a user interrupt rather than a real failure. */
  /** True when the error is a user interrupt rather than a real failure. */
  _isTurnAbortError(err: unknown, signal?: AbortSignal): boolean {
    return isTurnAbortError(this, err, signal);
  }

  /**
   * Internal compact code uses this exact message for a deliberate stop. A
   * provider may also throw an AbortError, but without this marker it is a
   * transport failure and must remain visible as an error.
   */
  _isCompactAbortError(err: unknown): boolean {
    return (err as { name?: unknown })?.name === "AbortError"
      && (err as { message?: unknown })?.message === "Compact phase aborted.";
  }

  // Set while the current turn-lock execution has already written its error
  // log entry; reset on every lock acquisition. Multiple catch layers
  // (entry-point wrappers, resume stage, manual context commands) can then
  // call _recordTurnErrorEntry without double-writing.
  _turnErrorEntryWritten = false;

  // Whether the current turn-lock execution emitted a lifecycle "ended"
  // event (set by _runTurnActivationLoop's finally). Failure paths that die
  // before the activation loop use this to emit the missing ended(error)
  // exactly once. Reset on every lock acquisition.
  _lifecycleEndedEmitted = false;

  /**
   * Write the user-visible error log entry for a failed turn —at most once
   * per turn-lock execution, and never for user interrupts. The runtime owns
   * error visibility: all UIs see the entry via log projection. (Historically
   * the TUI's catch wrote this entry, which left server-mode UIs blind to
   * turn errors.)
   */
  /**
   * Write the user-visible error log entry for a failed turn —at most once
   * per turn-lock execution, and never for user interrupts. The runtime owns
   * error visibility: all UIs see the entry via log projection. (Historically
   * the TUI's catch wrote this entry, which left server-mode UIs blind to
   * turn errors.)
   */
  _recordTurnErrorEntry(err: unknown, signal?: AbortSignal): void {
    recordTurnErrorEntry(this, err, signal);
  }

  /**
   * Full failure surface for a turn that died anywhere inside (or just
   * outside) the turn lock: error log entry + a lifecycle ended(error) event
   * if the activation loop never got to emit one (pre-loop failures:
   * storage, MCP, attachments, before-turn compact, manual-command
   * validation). Both halves are idempotent per lock execution, so every
   * catch layer can call this unconditionally.
   */
  /**
   * Full failure surface for a turn that died anywhere inside (or just
   * outside) the turn lock: error log entry + a lifecycle ended(error) event
   * if the activation loop never got to emit one (pre-loop failures:
   * storage, MCP, attachments, before-turn compact, manual-command
   * validation). Both halves are idempotent per lock execution, so every
   * catch layer can call this unconditionally.
   */
  _recordTurnFailure(err: unknown, signal?: AbortSignal): void {
    recordTurnFailure(this, err, signal);
  }

  /**
   * Handle interruption using structured log (v2).
   *
   * Rules:
   * - Keep completed reasoning, drop incomplete reasoning of the currently interrupted round
   * - Materialize partial streamed text as assistant_text
   * - For each complete tool_call lacking result, append contextual tool_result
   * - For partial (unclosed) tool_calls visible only in TUI, append a user-role
   *   system-message explaining their absence from the API context
   * - Inject a single user-role system-message about the interruption
   */
  /**
   * Handle interruption using structured log (v2).
   *
   * Rules:
   * - Keep completed reasoning, drop incomplete reasoning of the currently interrupted round
   * - Materialize partial streamed text as assistant_text
   * - For each complete tool_call lacking result, append contextual tool_result
   * - For partial (unclosed) tool_calls visible only in TUI, append a user-role
   *   system-message explaining their absence from the API context
   * - Inject a single user-role system-message about the interruption
   */
  _handleInterruption(
    logLenBefore: number,
    accumulatedText: string,
    opts?: { activationCompleted?: boolean },
  ): void {
    handleInterruption(this, logLenBefore, accumulatedText, opts);
  }

  /**
   * Scan the current turn's log entries to collect human-readable interrupt hints.
   * Called after _handleInterruption, before writing turn_end.
   */
  /**
   * Scan the current turn's log entries to collect human-readable interrupt hints.
   * Called after _handleInterruption, before writing turn_end.
   */
  _collectInterruptHints(): string[] {
    return collectInterruptHints(this);
  }

  _completeMissingToolResultsFromLog(fromIdx: number): void {
    completeMissingToolResultsInLog(this._logSurgeryView(), fromIdx);
  }

  // ==================================================================
  // Activation
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
  // Ask tool
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
      // Show question with all options, marking the selected one
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
   * Resolve a permission approval ask.
   * @param askId  The ask ID to resolve.
   * @param choiceIndex  Index into the ask's options array. Last option is always "Deny".
   */
  /**
   * Resolve a permission approval ask.
   * @param askId  The ask ID to resolve.
   * @param choiceIndex  Index into the ask's options array. Last option is always "Deny".
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
   * Route an ask operation to the correct session (self or child).
   * If the ask belongs to this session, runs onSelf. If it belongs to a
   * child, runs onChild then resumes the child's pending turn.
   */
  /**
   * Route an ask operation to the correct session (self or child).
   * If the ask belongs to this session, runs onSelf. If it belongs to a
   * child, runs onChild then resumes the child's pending turn.
   */
  _withAskRouting<T>(
    askId: string,
    onSelf: () => T,
    onChild: (child: ChildSessionHandle) => T,
  ): T {
    return withAskRouting(this, askId, onSelf, onChild);
  }

  // ==================================================================
  // Tool call visibility
  // ==================================================================

  /**
   * Hook to override a tool call's TUI visibility. Returning "hide" suppresses
   * the call entirely —the runtime "hide" machinery is retained for future use,
   * but nothing uses it right now.
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
  // Path variable resolution
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
   * Assemble the full system prompt using the layered assembler.
   * Called by _reloadPromptAndTools(), not per-call.
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
   * Get the cached system prompt. Computed once and reused across API calls
   * for prompt cache stability. Refreshed only by _reloadPromptAndTools().
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
   * Reload skills and rebuild the system snapshot.
   * Called at session init and by explicit /reload only; file edits and
   * store binding do not change the cached prefix.
   */
  _reloadPromptAndTools(): void {
    this._refreshSkills();
    this._rebuildSystemPrompt();
  }

  /** Rebuild the cached system snapshot after tools/skills/memory change. */
  _rebuildSystemPrompt(): void {
    this._cachedSystemPrompt = this._assembleSystemPrompt();
    this._promptSectionEstimates = null;
  }

  // ==================================================================
  // Auto-compact
  // ==================================================================

  _buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
    return buildCompactCheck(this);
  }

  /**
   * Run the compact phase: inject compact prompt, let the Agent produce
   * a continuation prompt (possibly using tools), then return it.
   */
  /**
   * Run the compact phase: inject compact prompt, let the Agent produce
   * a continuation prompt (possibly using tools), then return it.
   */
  async _runCompactPhase(
    scenario: "before_turn" | "mid_turn",
    promptOverride?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return runCompactPhase(this, scenario, promptOverride, signal);
  }

  /**
   * Execute auto-compact: run compact phase, then reconstruct conversation
   * with marker + system prompt + continuation prompt.
   */
  /**
   * Execute auto-compact: run compact phase, then reconstruct conversation
   * with marker + system prompt + continuation prompt.
   */
  async _doAutoCompact(
    scenario: "before_turn" | "mid_turn",
    signal?: AbortSignal,
    promptOverride?: string,
    hideCompactMarker = false,
  ): Promise<void> {
    return doAutoCompact(this, scenario, signal, promptOverride, hideCompactMarker);
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
  // Sub-agent spawn / cancel / lifecycle
  // ==================================================================

  private _saveChildSession(handle: ChildSessionHandle): boolean {
    if (!handle.session) return true; // released —already persisted at settle
    try {
      const logData = handle.session.getLogForPersistence();
      saveLog(handle.sessionDir, logData.meta, [...logData.entries]);
      return true;
    } catch (e) {
      console.warn(`Failed to save child session '${handle.id}':`, e);
      return false;
    }
  }

  /** @internal Kept as a stable test/runtime hook around ChildSessionManager. */
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
  // send tool —async message to interactive/team agent
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
  // await_event —blocking wait for sub-agent completion or new messages
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
      // Child-private access wrappers: same-class private access is legal
      // here in Session, and routing through the instance keeps test stubs
      // (e.g. a mocked _saveChildSession) effective.
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
        // Bubble child ask changes to this session (and transitively to the
        // root): child asks live in the child's log, so without this hook
        // out-of-process UIs (which only subscribe to the root) never learn
        // that a sub-agent is waiting for approval.
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

  // _waitForAnyAgent removed —await_event uses 1s polling now, and the
  // activation loop no longer does implicit waits. Model should call
  // await_event explicitly to wait for sub-agent completion.

  // ==================================================================
  // Image file storage (v2 —image_ref)
  // ==================================================================

  private _imageCounter = 0;

  // ==================================================================
  // 附件处理（实现见 ./session/attachments.ts）
  // ==================================================================


  private _extractAndSaveImages(
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
  // MCP integration
  // ==================================================================

  async _ensureMcp(): Promise<void> {
    return ensureMcp(this);
  }

  // ==================================================================
  // Persistence
  // ==================================================================

  // getStateForPersistence() and restoreFromPersistence() removed.
  // All persistence is now via getLogForPersistence() / restoreFromLog().

  _generateSummary(): string {
    for (const entry of this._log) {
      if (entry.type !== "user_message") continue;
      // 切换类/注入类命令回显使用 user_message 作为日志载体，但
      // apiRole 为 null，不能成为会话自动标题或摘要。
      if (entry.apiRole !== "user") continue;
      if (entry.discarded) continue;
      const display = entry.display;
      if (!display) continue;
      if (SYSTEM_PREFIXES.some((prefix) => display.startsWith(prefix))) continue;
      // 每次从真实用户消息重新校验，避免旧版本把 command_echo 写进
      // meta.summary 后，恢复会话时继续沿用错误的自动标题。
      this._cachedSummary = stripContextTags(display).slice(0, 100).trim();
      return this._cachedSummary;
    }
    this._cachedSummary = undefined;
    return "New session";
  }

  // ==================================================================
  // Resource cleanup
  // ==================================================================

  async close(): Promise<void> {
    return closeSession(this);
  }
}
