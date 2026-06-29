/**
 * 多轮对话会话与上下文管理。
 *
 * 提供 Session 类——核心运行时编排器。
 * 管理主 Agent 的对话、
 * 自动压缩和子代理生命周期。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
// child_process —now only used by BackgroundShellManager
import * as yaml from "js-yaml";

import { assembleSystemPrompt, getPromptLayers } from "./templates/loader.js";

import { Agent, isNoReply, NO_REPLY_MARKER } from "./agents/agent.js";
import type {
  ToolLoopResult,
  ToolExecutor,
  ToolPreflightContext,
  ToolPreflightDecision,
  ResolveToolCallVisibilityCallback,
} from "./agents/tool-loop.js";
import { createEphemeralLogState } from "./context/ephemeral-log.js";
import { isCompactMarker, allocateContextId, stripContextTags, ContextTagStripBuffer } from "./context/context-rendering.js";
import { estimateEntryTokens, generateShowContext } from "./context/show-context.js";
import { getThinkingLevels, getModelMaxOutputTokens, type Config, type ModelConfig } from "./config/config.js";
import type { MCPClientManager } from "./clients/mcp-client.js";
import { ProgressEvent, type ProgressLevel, type ProgressReporter } from "./lib/progress.js";
import { ToolResult } from "./providers/base.js";
import type { ToolDef } from "./providers/base.js";
import {
  SPAWN_TOOL,

  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  AWAIT_EVENT_TOOL,
  SHOW_CONTEXT_TOOL,
  SUMMARIZE_CONTEXT_TOOL,
  ASK_TOOL,
} from "./tools/comm.js";
import {
  BASH_BACKGROUND_TOOL,
  BASH_OUTPUT_TOOL,
  KILL_SHELL_TOOL,
  executeTool,
} from "./tools/basic.js";
import type { FileMutation } from "./tools/basic.js";
import type { RewindPlan, RewindApplyResult } from "./ui/contracts.js";
import { RewindEngine } from "./session/rewind-engine.js";
import {
  ChildSessionManager,
  type ChildSessionHandle,
  type PreparedChildRestore,
} from "./session/child-session-manager.js";
import {
  beginWorkIfNeededIn,
  completeMissingToolResultsInLog,
  discardInterruptedRoundReasoningInLog,
  finishWorkInLog,
  normalizeInterruptedTurnInLog,
  parseRestoredState,
  type LogSurgery,
  type RestoredSessionState,
} from "./session/session-persistence.js";
import { SessionLog, type TurnListing } from "./session/session-log.js";
import { ContextManager } from "./session/context-manager.js";
import { SubAgentFactory } from "./session/subagent-factory.js";
import {
  COMPACT_PROMPT_OUTPUT,
  COMPACT_PROMPT_TOOLCALL,
  appendManualInstruction,
} from "./session/compact-prompts.js";
import { buildActiveContextView } from "./context/active-context.js";
import { execSummarizeContextOnLog } from "./context/summarize-context.js";
import { resolveSkillContent, loadSkillsMulti, type SkillMeta } from "./skills/loader.js";
import { toolBuiltinWebSearchPassthrough } from "./tools/web-search.js";
import {
  processFileAttachments,
  hasFiles as fileAttachHasFiles,
  hasImages as fileAttachHasImages,
  parseReferences,
} from "./lib/file-attach.js";
import { SafePathError, safePath } from "./security/path.js";
import { parsePlanFile, formatPlanSnapshot, PLAN_FILENAME, type PlanCheckpoint } from "./lib/plan-state.js";
import {
  buildToolExecutors,
  ensureCommTools,
  ensureSkillTool,
  buildSkillToolDef,
  registerMcpTools,
  ToolGate,
  type GateAdvisor,
} from "./lib/tool-runtime.js";
import { BackgroundShellManager, type BackgroundShellSnapshot, type BackgroundShellDetail } from "./lib/background-shell-manager.js";
import { PermissionAdvisor, PermissionRuleStore, initBashParser, type PermissionMode, type PermissionRule, type ApprovalOffer } from "./permissions/index.js";
import { HookRuntime, type HookEvent, type HookPayload } from "./hooks/index.js";
import type { HookManifest } from "./hooks/types.js";
import { assembleFullSystemPrompt, readAgentsMemory } from "./lib/prompt-assembler.js";
import { shell } from "./platform/index.js";
import { buildShellNotes } from "./tools/shell-notes.js";
import {
  argOptionalString,
  argOptionalPath,
  argRequiredString,
  argRequiredStringArray,
  toolArgError,
} from "./tools/arg-helpers.js";
import {
  AskPendingError,
  ASK_CUSTOM_OPTION_LABEL,
  ASK_DISCUSS_FURTHER_GUIDANCE,
  ASK_DISCUSS_OPTION_LABEL,
  isAskPendingError,
  toPendingAskUi,
  type AgentQuestion,
  type AgentQuestionItem,
  type AgentQuestionAnswer,
  type AgentQuestionDecision,
  type ApprovalRequest,
  type AskAuditRecord,
  type AskRequest,
  type PendingAskUi,
  type PendingTurnState,
} from "./ask.js";
import {
  LogIdAllocator,
  type LogEntry,
  createSystemPrompt,
  createInputReceived,
  type TurnKind,
  createUserMessage as createUserMessageEntry,
  createAssistantText,
  createReasoning,
  createToolCall,
  createToolResult as createToolResultEntry,
  createNoReply,
  createCompactMarker,
  createCompactContext,
  createSummary,
  createStatus,
  createError as createErrorEntry,
  createTokenUpdate,
  createAskRequest,
  createAskResolution,
} from "./context/log-entry.js";
import { projectToApiMessages } from "./context/log-projection.js";
import {
  archiveEntryContents,
  archiveWindow,
  createGlobalTuiPreferences,
  createLogSessionMeta,
  loadArchiveFile,
  restoreArchiveToEntries,
  saveLog,
  loadGlobalSettings,
  loadLocalSettings,
  mergeSettings,
  settingsToConfigInputs,
  type GlobalTuiPreferences,
  type LogSessionMeta,
  type SwarmflowSettings,
  type ModelSelectionState,
} from "./config/persistence.js";
import {
  CHILD_SESSION_CAPABILITIES,
  ROOT_SESSION_CAPABILITIES,
  type SessionCapabilities,
} from "./session-capabilities.js";
import {
  migrateMessageEnvelope,
  type ArchivedChildRecord,
  type ChildSessionLifecycle,
  type ChildSessionMetaRecord,
  type ChildSessionMode,
  type ChildSessionPhase,
  type ChildSessionSnapshot,
  type DeliverMessageResult,
  type MessageEnvelope,
} from "./session-tree-types.js";
import {
  resolveAgentModelEntry,
  resolveModelTierEntry,
  resolvePersistedModelSelection,
  type PersistedModelSelection,
} from "./models/selection.js";
import { describeModel } from "./models/presentation.js";
import {
  type ContextThresholds,
  validateSummarizeHintLevels,
} from "./config/settings.js";
import { encode as gptEncode } from "gpt-tokenizer/model/gpt-5";
// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const MAX_ACTIVATIONS_PER_TURN = 30;
const MAX_COMPACT_PHASE_ROUNDS = 10;       // max activations during compact phase

const SYSTEM_PREFIXES = [
  "[AUTO-COMPACT]",
  "[Context After Auto-Compact]",
  "[MASTER PLAN:",
  "[PHASE PLAN:",
  "[SUB-AGENT UPDATE]",
  "[SESSION INTERRUPTED]",
  "[SKILL:",
];

type DrainPendingToolCallsResult =
  | { kind: "drained" }
  | { kind: "suspended"; ask: AskRequest; toolCallId: string }
  | { kind: "interrupted" };

// ------------------------------------------------------------------
// InlineImageInput —clipboard / drag-drop image passed to turn()
// ------------------------------------------------------------------

export interface InlineImageInput {
  id: string;
  base64: string;
  mediaType: string;
}

// ------------------------------------------------------------------
// TurnLifecycleEvent —runtime-emitted turn start/end notifications
// ------------------------------------------------------------------

/** Terminal status of a turn. `waiting` = parked on a pending ask (not done). */
export type TurnLifecycleStatus = "completed" | "interrupted" | "error" | "waiting";

/**
 * Emitted by the Session around every activation-loop run —including
 * auto-resume and post-approval resume turns that have no external caller.
 * Subscribed by the RPC layer (forwarded as `turn.started` / `turn.ended`
 * wire events) and available to in-process UIs.
 */
export type TurnLifecycleEvent =
  | { phase: "started"; turnIndex: number }
  | { phase: "ended"; turnIndex: number; status: TurnLifecycleStatus; error?: string };

// ------------------------------------------------------------------
// MessageEnvelope —typed message envelope (see session-tree-types.ts)
// ------------------------------------------------------------------


// ChildSessionHandle / PreparedChildRestore —moved to ./session/child-session-manager.ts
// BackgroundShellEntry —moved to ./background-shell-manager.ts

interface PreparedSessionRestore {
  rootState: RestoredSessionState;
  children: PreparedChildRestore[];
  archivedRecords?: ArchivedChildRecord[];
  rootInbox?: MessageEnvelope[];
  warnings: string[];
}

// ------------------------------------------------------------------
// NoReplyStreamBuffer
// ------------------------------------------------------------------

class NoReplyStreamBuffer {
  private static readonly MARKER = "<NO_REPLY>";
  private static readonly MARKER_LEN = 10;

  private _downstream: (chunk: string) => void;
  private _buffer = "";
  private _phase: "detect" | "forwarding" | "suppressed" = "detect";
  detectedNoReply = false;

  constructor(downstream: (chunk: string) => void) {
    this._downstream = downstream;
  }

  feed(chunk: string): void {
    if (this._phase === "forwarding") {
      this._downstream(chunk);
      return;
    }
    if (this._phase === "suppressed") {
      return;
    }

    this._buffer += chunk;
    const stripped = this._buffer.trimStart();

    if (stripped && !stripped.startsWith("<")) {
      this._flushAndForward();
      return;
    }

    if (stripped.length < NoReplyStreamBuffer.MARKER_LEN) {
      if (stripped && !NoReplyStreamBuffer.MARKER.startsWith(stripped)) {
        this._flushAndForward();
      }
      return;
    }

    if (stripped.startsWith(NoReplyStreamBuffer.MARKER)) {
      this.detectedNoReply = true;
      this._buffer = "";
      this._phase = "suppressed";
    } else {
      this._flushAndForward();
    }
  }

  private _flushAndForward(): void {
    this._phase = "forwarding";
    if (this._buffer) {
      this._downstream(this._buffer);
      this._buffer = "";
    }
  }
}

// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------

/** Cumulative usage figures derived from the log's token_update entries. */
interface UsageStats {
  /** 危 inputTokens across every provider call (billed input, re-sent each call). */
  cumulativeInput: number;
  /** 危 output tokens (totalTokens 鈭?inputTokens) across every provider call. */
  cumulativeOutput: number;
  /** 危 cacheReadTokens (the cached slice of cumulativeInput). */
  cumulativeCacheRead: number;
  /** 危 (inputTokens 鈭?cacheReadTokens) (the uncached slice of cumulativeInput). */
  cumulativeUncached: number;
  /** Estimated fixed prompt: first call's input minus the first user message. */
  systemPromptTotal: number;
  /** Per-section breakdown of systemPromptTotal (ratio-scaled estimates). */
  systemPromptBreakdown: ContextBreakdown;
}

/** Per-section token estimates for the context breakdown. */
interface ContextBreakdown {
  systemPrompt: number;
  tools: number;
  agentsMd: number;
  skills: number;
  messages: number;
}

interface McpAvailabilitySnapshot {
  servers: string[];
  tools: string[];
}

interface ToolAvailabilityNotice {
  reason: string;
  skillsEnabled?: string[];
  skillsDisabled?: string[];
  skillsAdded?: string[];
  skillsRemoved?: string[];
  mcpServersConnected?: string[];
  mcpServersDisconnected?: string[];
  mcpServersChanged?: string[];
  mcpToolsAdded?: string[];
  mcpToolsRemoved?: string[];
}

export class Session {
  primaryAgent: Agent;
  config: Config;
  agentTemplates: Record<string, Agent>;
  private _promptsDirs?: string[];

  private _progress?: ProgressReporter;
  private _mcpManager?: MCPClientManager;
  private _mcpConnected = false;
  private _mcpReadyPromise?: Promise<void>;

  /** Tool permission gate —add advisors to control tool execution. */
  readonly toolGate = new ToolGate();

  /** Permission advisor —classifies tools and enforces permission mode. */
  private _permissionAdvisor!: PermissionAdvisor;
  private _permissionRuleStore!: PermissionRuleStore;

  /** Hook runtime —fires events and evaluates hook commands. */
  readonly hookRuntime = new HookRuntime();

  private _createdAt: string;
  /** Model identity snapshot taken at session creation. Stable across resumes and /model switches. */
  private _initialModel: string;
  private _title: string | undefined;
  private _cachedSummary: string | undefined;

  // Structured log —entries, revision, listeners, and id allocation live in
  // SessionLog (src/session/session-log.ts); these accessors keep the many
  // Session-internal `_log` / `_idAllocator` call sites unchanged.
  private _logStore = new SessionLog();

  private get _log(): LogEntry[] {
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
  private _lastInputTokens = 0;
  private _lastTotalTokens = 0;
  private _lastCacheReadTokens = 0;

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
  private _compactInProgress = false;

  // Context-pressure state (thresholds, hint state machine, budget percent)
  // lives in ContextManager (src/session/context-manager.ts); the accessors
  // below keep Session-internal call sites stable.
  private _contextManager!: ContextManager;

  private get _thresholds(): ContextThresholds {
    return this._contextManager.thresholds;
  }

  private get _contextBudgetPercent(): number {
    return this._contextManager.budgetPercent;
  }

  private get _hintState(): "none" | "level1_sent" | "level2_sent" {
    return this._contextManager.hintState;
  }

  private set _hintState(value: "none" | "level1_sent" | "level2_sent") {
    this._contextManager.hintState = value;
  }

  // /summarize tool whitelist mode
  private _summarizeToolWhitelist: Set<string> | null = null;
  private _manualSummarizeExactRange: { from: string; to: string; contextIds: string[] } | null = null;

  // Pending summary entries to flush after tool_result is appended
  private _pendingSummaryEntries: LogEntry[] = [];

  // Skills
  private _skills = new Map<string, SkillMeta>();
  private _skillRoots: string[] = [];
  private _disabledSkills = new Set<string>();

  // Cached system prompt (static between reloads for prompt cache stability)
  private _cachedSystemPrompt: string | null = null;

  // Artifacts / persistence
  private _store: any;

  // Path variables
  private _projectRoot: string;
  private _sessionArtifactsOverride: string;
  private _systemData: string;

  // Plan state (parsed from {SESSION_ARTIFACTS}/plan.md)
  private _planState: PlanCheckpoint[] = [];
  private _planListeners: (() => void)[] = [];

  // File/bash rewind planning + application (owns the crash journal).
  private _rewindEngine!: RewindEngine;

  // Builds Agent instances for child sessions (templates + model resolution).
  // Lazily constructed so prototype-based test doubles get a working factory
  // wired to their own stubbed fields on first use.
  private _subAgentFactory?: SubAgentFactory;

  // Session tree / child sessions —state lives in ChildSessionManager.
  // Same-name private accessors below keep internal call sites and tests stable.
  private _childSessionManager?: ChildSessionManager;
  private _shellManager!: BackgroundShellManager;

  // Session capabilities / routing
  private _capabilities: SessionCapabilities = ROOT_SESSION_CAPABILITIES;
  private _turnOutputTarget?: (text: string) => void;
  private _deferQueuedMessageInjectionOnTurnExit = false;
  private _selfPhase: ChildSessionPhase = "idle";
  private _lifetimeToolCallCount = 0;
  private _lastToolCallSummary = "";
  private _recentSessionEvents: string[] = [];

  // Active entry tracker —tracks which log entry is currently "live"
  private _activeLogEntryId: string | null = null;

  /** Update the active entry tracker; implicitly marks previous reasoning as complete. */
  private _setActiveLogEntry(entryId: string | null): void {
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
  private _lastTurnEndStatus: "completed" | "interrupted" | "error" | null = null;

  // Thinking level + accent
  private _persistedModelSelection: PersistedModelSelection = {};
  private _preferredThinkingLevel = "";
  private _preferredAccentColor?: string;
  private _thinkingLevel = "none";

  /** Stable key for OpenAI prompt cache routing affinity. */
  private _promptCacheKey: string;

  // Agent runtime state (for message delivery mode selection)
  private _agentState: "working" | "idle" | "waiting" = "idle";

  // Inbox: holds messages for push delivery into tool results.
  // Typed message inbox —all messages flow through _deliverMessage.
  private _inbox: MessageEnvelope[] = [];
  // True once a real user message has driven an activation (or was loaded from
  // a restored log). Gates tool-availability notices: skill/MCP changes made
  // before the first user message never queue a ride-along notice. Flipped in
  // _beginActiveInput; seeded on restore in _applyRestoredState.
  private _conversationStarted = false;
  private _currentTurnSignal: AbortSignal | null = null;
  private _currentTurnAbortController: AbortController | null = null;

  // Turn serialization —prevents concurrent turn() calls from corrupting state
  private _turnInFlight: Promise<string | void> | null = null;

  /** Callback for incremental persistence —called at save-worthy checkpoints. */
  onSaveRequest?: () => void;
  /** Callback for MCP connection status —called after initial connect or reload. */
  onMcpStatus?: (statuses: Array<{ name: string; state: string; toolCount: number; error?: string }>) => void;

  // Counters
  private _turnCount = 0;
  private _workCount = 0;
  private _currentWorkId: string | null = null;
  private _currentWorkStartedAt = 0;
  private _compactCount = 0;
  private _usedContextIds = new Set<string>();

  // Last time we ran a sync GC at idle (ms epoch). Used to throttle the
  // turn-end Bun.gc(true) call so back-to-back work boundaries don't burn
  // CPU on repeated full-heap collections.
  private _lastIdleGcAt = 0;

  // Tool executors
  private _toolExecutors: Record<string, ToolExecutor>;
  private _toolExecutorOverrides: Record<string, ToolExecutor> = {};

  // Ask state. All reads/writes go through the `_activeAsk` accessor pair so
  // every transition (suspend/resolve/restore/reset) notifies ask subscribers —  // including sites added in the future.
  private _activeAskValue: AskRequest | null = null;
  private _askHistory: AskAuditRecord[] = [];
  private _pendingTurnState: PendingTurnState | null = null;

  private get _activeAsk(): AskRequest | null {
    return this._activeAskValue;
  }

  private set _activeAsk(value: AskRequest | null) {
    if (this._activeAskValue === value) return;
    this._activeAskValue = value;
    this._notifyAskChanged();
  }

  // Ask / turn-lifecycle subscribers (UI + RPC layer). Log subscription alone
  // cannot observe child-session asks (they live in the child's log), so ask
  // state gets its own channel; child asks bubble to the root via the
  // createChildSession wiring.
  private _askListeners = new Set<() => void>();
  private _turnLifecycleListeners = new Set<(event: TurnLifecycleEvent) => void>();

  /**
   * Subscribe to pending-ask changes (own asks and child-session asks).
   * Listeners receive no payload; call `getPendingAsk()` for current state.
   */
  subscribeAsk(listener: () => void): () => void {
    this._askListeners.add(listener);
    return () => {
      this._askListeners.delete(listener);
    };
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

  private _notifyAskChanged(): void {
    // Prototype-based test doubles (Object.create(Session.prototype)) have no
    // field initializers; tolerate a missing listener set.
    if (!this._askListeners) return;
    for (const listener of this._askListeners) {
      try {
        listener();
      } catch {
        // Subscriber errors must never break the turn loop.
      }
    }
  }

  private _emitTurnLifecycle(event: TurnLifecycleEvent): void {
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
  private _allocateContextId(): string {
    return allocateContextId(this._usedContextIds);
  }

  private _setSelfPhase(phase: ChildSessionPhase): void {
    this._selfPhase = phase;
  }

  private _recordSessionEvent(summary: string): void {
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
  private get _childSessionManagerInstance(): ChildSessionManager {
    return this._childSessionManager ??= this._buildChildSessionManager();
  }

  private get _childSessions(): Map<string, ChildSessionHandle> {
    return this._childSessionManagerInstance.handles;
  }

  private get _archivedChildren(): Map<string, ArchivedChildRecord> {
    return this._childSessionManagerInstance.archived;
  }

  private get _subAgentCounter(): number {
    return this._childSessionManagerInstance.counter;
  }

  private set _subAgentCounter(value: number) {
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
    sessionArtifactsDir?: string;
    capabilities?: SessionCapabilities;
    onTurnOutput?: (text: string) => void;
    toolExecutorOverrides?: Record<string, ToolExecutor>;
    deferQueuedMessageInjectionOnTurnExit?: boolean;
    /** Stable key for OpenAI prompt cache routing affinity. Auto-generated if omitted. */
    promptCacheKey?: string;
    /** Permission mode for this session. Default: "reversible". */
    permissionMode?: PermissionMode;
    /** Shared rule store for child sessions. If omitted, a new store is created. */
    permissionRuleStore?: PermissionRuleStore;
    /** Pre-loaded hook manifests. Each session keeps its own runtime; hooks are copied in. */
    hooks?: readonly HookManifest[];
  }) {
    this.primaryAgent = opts.primaryAgent;
    // Default thinking level: highest available for this model (or "none" for non-thinking).
    // Resolves once at construction so the field is consistent before any setter call.
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      "",
    );
    this.config = opts.config;
    this.agentTemplates = opts.agentTemplates ?? {};
    this._skills = opts.skills ?? new Map();
    this._skillRoots = opts.skillRoots ?? [];
    this._progress = opts.progress;
    this._mcpManager = opts.mcpManager;
    this._mcpReadyPromise = opts.mcpReadyPromise;
    this._promptsDirs = opts.promptsDirs;
    this._capabilities = opts.capabilities ?? ROOT_SESSION_CAPABILITIES;
    this._turnOutputTarget = opts.onTurnOutput;
    this._toolExecutorOverrides = opts.toolExecutorOverrides ?? {};
    this._deferQueuedMessageInjectionOnTurnExit = opts.deferQueuedMessageInjectionOnTurnExit ?? false;

    this._contextManager = new ContextManager({
      getModelConfig: () => this.primaryAgent.modelConfig,
      getBudgetCalcMode: () =>
        (this.primaryAgent as unknown as { _provider?: { budgetCalcMode?: string } })._provider?.budgetCalcMode,
      isCompactInProgress: () => this._compactInProgress,
      canAutoCompact: () => this._capabilities.includeSpawnTool,
      getLastInputTokens: () => this._lastTotalTokens,
      deliverSystemNotice: (content) => {
        this._deliverMessage({ type: "system_notice", sender: "system", content, timestamp: Date.now() });
      },
    });

    // Apply context budget percentage.
    if (opts.contextBudgetPercent !== undefined) {
      this._contextManager.setBudgetPercent(opts.contextBudgetPercent);
    }

    // Attach store if provided (must be set before _initConversation)
    if (opts.store) {
      this._store = opts.store;
    }

    // Resolve path variables
    this._projectRoot = opts.projectRoot ?? process.cwd();
    this._sessionArtifactsOverride = opts.sessionArtifactsDir ?? "";
    this._systemData = "";
    this._shellManager = new BackgroundShellManager({
      projectRoot: this._projectRoot,
      getSessionArtifactsDir: () => this._resolveSessionArtifacts(),
      deliverMessage: (msg) => this._deliverMessage(msg),
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
    if (opts.hooks && opts.hooks.length > 0) {
      this.hookRuntime.setHooks([...opts.hooks]);
    }
    this._initConversation();
    this._toolExecutors = this._buildToolExecutors();
    this._ensureCommTools();
    this._ensureSkillTool();
    this._persistedModelSelection = this._buildPersistedModelSelection();

    // Init tree-sitter bash parser (async, non-blocking)
    initBashParser();

    // Fire SessionStart hook (fire-and-forget)
    this.hookRuntime.fireAndForget("SessionStart", {
      event: "SessionStart",
      timestamp: Date.now(),
    });
  }

  private _buildPersistedModelSelection(
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
  private _appendEntry(entry: LogEntry, save = true): void {
    this._logStore.append(entry);
    if (save) this.onSaveRequest?.();
  }

  private _touchLog(): void {
    this._logStore.touch();
  }

  private _bumpLogRevision(): void {
    this._logStore.bumpRevision();
  }

  private _notifyLogListeners(): void {
    this._logStore.notifyListeners();
  }

  /** Allocate the next log entry ID for a given type. */
  private _nextLogId(type: LogEntry["type"]): string {
    return this._logStore.nextId(type);
  }

  /** Live-session view for the shared log-surgery functions (session-persistence.ts). */
  private _logSurgeryView(): LogSurgery {
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

  private _beginWorkIfNeeded(): string {
    return beginWorkIfNeededIn(this._logSurgeryView());
  }

  private _finishCurrentWork(
    status: "completed" | "interrupted" | "error",
    interruptHints?: string[],
  ): void {
    finishWorkInLog(this._logSurgeryView(), status, interruptHints);
    this.onSaveRequest?.();
    this._maybeRunIdleGc();
  }

  /**
   * Run a synchronous Bun.gc at work boundaries to keep saw-tooth heap
   * growth in check during long sessions. Throttled to once per 10s so
   * rapid interrupt/restart cycles don't pile up GC pauses, and only on
   * "completed" status —interrupted/error paths may be followed by an
   * immediate restart where pausing is more visible to the user.
   */
  private _maybeRunIdleGc(): void {
    if (this._lastTurnEndStatus !== "completed") return;
    if (typeof (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc !== "function") return;
    const now = Date.now();
    if (now - this._lastIdleGcAt < 10_000) return;
    this._lastIdleGcAt = now;
    try {
      (globalThis as { Bun: { gc: (sync: boolean) => void } }).Bun.gc(true);
    } catch {
      // GC is best-effort; never let a failure surface to the user.
    }
  }

  private _appendInterruptionSystemMessage(
    partialToolNames: readonly string[] = [],
    compactWasInterrupted = false,
  ): void {
    const msgParts: string[] = ["Last turn was interrupted by the user."];
    for (const name of partialToolNames) {
      msgParts.push(`You tried to use tool \`${name}\` but the call was interrupted before completion. The tool call is not visible in your context because it was not fully transmitted.`);
    }
    if (compactWasInterrupted) {
      msgParts.push("Context compaction was in progress and has been canceled due to this interruption.");
    }
    const interruptionContent = `<system-message>\n${msgParts.join("\n")}\n</system-message>`;
    const interruptionCtxId = this._allocateContextId();
    const interruptionEntry = createUserMessageEntry(
      this._nextLogId("user_message"),
      this._turnCount,
      "",
      interruptionContent,
      interruptionCtxId,
    );
    interruptionEntry.tuiVisible = false;
    interruptionEntry.displayKind = null;
    this._appendEntry(interruptionEntry, false);
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
  private _recordInputReceived(
    inputKind: "user" | "summarize" | "compact",
    display: string,
    content: unknown,
    contextId?: string,
  ): { inputIndex: number; inputId: string; contextId: string } {
    let maxInputIndex = this._turnCount;
    for (const entry of this._log) {
      if (entry.discarded) continue;
      if (entry.type === "input_received" && entry.turnIndex > maxInputIndex) {
        maxInputIndex = entry.turnIndex;
      }
    }
    const inputIndex = maxInputIndex + 1;
    const inputId = this._nextLogId("input_received");
    const inputContextId = contextId ?? this._allocateContextId();
    // Advance the current input index only when nothing is in flight or
    // suspended: a pending ask / pending resume still owns the current turn,
    // and its bookkeeping (tool_calls awaiting results) must keep pairing up.
    if (this._agentState === "idle" && !this._activeAsk && !this._pendingTurnState) {
      this._turnCount = inputIndex;
    }
    this._appendEntry(
      createInputReceived(
        inputId,
        inputIndex,
        inputId,
        inputKind,
        display,
        content,
        inputContextId,
        { tuiVisible: true, sender: "user" },
      ),
      false,
    );
    return { inputIndex, inputId, contextId: inputContextId };
  }

  private _appendDeliveredUserMessage(
    inputIndex: number,
    inputId: string,
    inputKind: "user" | "summarize" | "compact",
    display: string,
    content: unknown,
    contextId: string,
    tuiVisible = true,
  ): void {
    // The canonical point a real user message enters the model log —every
    // active-input and drain path funnels here. Mark the conversation started so
    // tool-availability notices are suppressed only before the first user
    // message, regardless of which path delivered it.
    if (inputKind === "user") this._conversationStarted = true;
    this._appendEntry(
      createUserMessageEntry(
        this._nextLogId("user_message"),
        inputIndex,
        display,
        content,
        contextId,
        { tuiVisible, inputId, inputKind },
      ),
      false,
    );
  }

  /** Compute the next roundIndex for the given turn based on existing entries. */
  private _computeNextRoundIndex(turnIndex: number = this._turnCount): number {
    let maxRound = -1;
    for (let i = this._log.length - 1; i >= 0; i--) {
      const e = this._log[i];
      if (e.turnIndex !== turnIndex) break;
      if (e.roundIndex !== undefined && e.roundIndex > maxRound) {
        maxRound = e.roundIndex;
      }
    }
    return maxRound + 1;
  }

  private _findRoundContextId(turnIndex: number, roundIndex: number): string | undefined {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.turnIndex < turnIndex) break;
      if (entry.discarded) continue;
      if (entry.turnIndex !== turnIndex) continue;
      if (entry.roundIndex !== roundIndex) continue;
      const contextId = (entry.meta as Record<string, unknown>)["contextId"];
      if (typeof contextId === "string" && contextId.trim()) {
        return contextId;
      }
    }
    return undefined;
  }



  private _resolveOutputRoundContextId(turnIndex: number, roundIndex: number): string {
    const roundContextId = this._findRoundContextId(turnIndex, roundIndex);
    return roundContextId ?? this._allocateContextId();
  }

  private _retagRoundEntries(turnIndex: number, roundIndex: number, contextId: string): void {
    let changed = false;
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.turnIndex < turnIndex) break;
      if (entry.discarded) continue;
      if (entry.turnIndex !== turnIndex) continue;
      if (entry.roundIndex !== roundIndex) continue;
      if (
        entry.type !== "assistant_text" &&
        entry.type !== "reasoning" &&
        entry.type !== "no_reply"
      ) {
        continue;
      }
      if ((entry.meta as Record<string, unknown>)["contextId"] === contextId) continue;
      (entry.meta as Record<string, unknown>)["contextId"] = contextId;
      changed = true;
    }
    if (changed) this._touchLog();
  }

  /** Index of the first entry after the last live compact_marker (active window start). */
  private _activeWindowStartIdx(): number {
    return this._logStore.activeWindowStartIdx();
  }

  /**
   * Find a tool_call entry by id within the active window (newest first).
   * Not scoped to the current turn: ask bookkeeping must keep pairing with
   * its tool_call even when the turn counter has moved on.
   */
  private _findToolCallEntry(toolCallId: string): LogEntry | undefined {
    if (!toolCallId) return undefined;
    const windowStart = this._activeWindowStartIdx();
    for (let i = this._log.length - 1; i >= windowStart; i--) {
      const entry = this._log[i];
      if (entry.discarded) continue;
      if (entry.type !== "tool_call") continue;
      if (String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "") !== toolCallId) continue;
      return entry;
    }
    return undefined;
  }

  /** Turn/round anchor for ask bookkeeping, derived from the gated tool_call. */
  private _toolCallAnchor(toolCallId: string, ask?: AskRequest | null): { turnIndex: number; roundIndex: number } {
    const entry = this._findToolCallEntry(toolCallId);
    const turnIndex = ask?.turnIndex ?? entry?.turnIndex ?? this._turnCount;
    const roundIndex = ask?.roundIndex ?? entry?.roundIndex ?? this._computeNextRoundIndex(turnIndex);
    return { turnIndex, roundIndex };
  }

  private _findToolCallContextId(toolCallId: string, roundIndex?: number): string | undefined {
    const entry = this._findToolCallEntry(toolCallId);
    const contextId = entry ? (entry.meta as Record<string, unknown>)["contextId"] : undefined;
    if (typeof contextId === "string" && contextId.trim()) {
      return contextId;
    }
    if (typeof roundIndex === "number") {
      return this._findRoundContextId(entry?.turnIndex ?? this._turnCount, roundIndex);
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // Unified message delivery (v2 architecture)
  // ------------------------------------------------------------------

  /**
   * Unified message delivery entry point.
   * All states push to inbox. Idle state also schedules auto-resume.
   * Working/waiting: the activation boundary or await_event poll drains.
   */
  private _deliverMessage(msg: MessageEnvelope): DeliverMessageResult {
    // Compacting rewrites the conversation; user input arriving mid-compact
    // would be folded behind the marker and effectively vanish. Reject it
    // (Q6) —automatic messages still queue and are delivered after compact.
    if (msg.type === "user_input" && this._compactInProgress) {
      return { accepted: false, reason: "compact_in_progress" };
    }
    if (msg.type === "user_input" && msg.sender === "user") {
      const queued = this._getQueuedUserInputs();
      if (queued.length > 0) {
        return { accepted: false, reason: "queued_user_input_pending" };
      }
    }
    if (msg.type === "user_input" && msg.inputIndex === undefined) {
      const received = this._recordInputReceived("user", msg.content, msg.content);
      msg = {
        ...msg,
        inputId: received.inputId,
        inputIndex: received.inputIndex,
        contextId: received.contextId,
        tuiVisible: true,
      };
      this.onSaveRequest?.();
    }
    this._inbox.push(msg);
    // Ride-along messages (wake === false) never start a turn from idle;
    // they wait in the inbox and are drained when something else wakes the
    // agent (user input or a waking message).
    if (this._agentState === "idle" && msg.wake !== false) {
      this._scheduleAutoResume();
    }
    return { accepted: true };
  }

  /**
   * Public wrapper for TUI / GUI to deliver messages.
   * Preserves the original (source, content) signature for external callers.
   */
  deliverMessage(source: "user" | "system", content: string): DeliverMessageResult {
    return this._deliverMessage({
      type: source === "user" ? "user_input" : "system_notice",
      sender: source,
      content,
      timestamp: Date.now(),
    });
  }

  private _getQueuedUserInputs(): Array<{
    inputId: string;
    inboxIndex: number;
    message: MessageEnvelope;
    inputEntry: LogEntry;
  }> {
    const deliveredInputIds = new Set<string>();
    for (const entry of this._log) {
      if (entry.discarded || entry.type !== "user_message") continue;
      const inputId = entry.meta["inputId"];
      if (typeof inputId === "string" && inputId.trim()) {
        deliveredInputIds.add(inputId);
      }
    }

    const queued: Array<{
      inputId: string;
      inboxIndex: number;
      message: MessageEnvelope;
      inputEntry: LogEntry;
    }> = [];
    for (let inboxIndex = 0; inboxIndex < this._inbox.length; inboxIndex++) {
      const message = this._inbox[inboxIndex];
      if (message.type !== "user_input" || message.sender !== "user") continue;
      if (!message.inputId || deliveredInputIds.has(message.inputId)) continue;
      const inputEntry = this._log.find((entry) => {
        if (entry.discarded || entry.type !== "input_received") return false;
        if (entry.meta["inputKind"] !== "user") return false;
        return entry.meta["inputId"] === message.inputId;
      });
      if (!inputEntry) continue;
      queued.push({ inputId: message.inputId, inboxIndex, message, inputEntry });
    }
    return queued;
  }

  private _maxLiveInputIndex(): number {
    let max = 0;
    for (const entry of this._log) {
      if (entry.discarded) continue;
      if (entry.type !== "input_received" && entry.type !== "turn_start") continue;
      max = Math.max(max, entry.turnIndex);
    }
    return max;
  }

  restoreQueuedUserInput(): string | null {
    const queued = this._getQueuedUserInputs();
    if (queued.length !== 1) return null;

    const item = queued[0];
    if (!item) return null;
    this._inbox.splice(item.inboxIndex, 1);
    item.inputEntry.discarded = true;
    if (this._turnCount === item.inputEntry.turnIndex) {
      this._turnCount = this._maxLiveInputIndex();
    }
    this._touchLog();
    this.onSaveRequest?.();
    return item.message.content;
  }

  private _autoResumeScheduled = false;

  /**
   * Schedule an auto-resume turn for the idle state. Used when messages arrive
   * (sub-agent completion, shell exit, etc.) while the parent agent has no
   * active turn. Without this, the queued messages would sit in the log
   * unprocessed until the user manually starts a new turn.
   */
  private _scheduleAutoResume(): void {
    if (this._autoResumeScheduled) return;
    if (this._activeAsk) return;
    if (this._pendingTurnState) return;
    this._autoResumeScheduled = true;
    queueMicrotask(() => {
      this._autoResumeScheduled = false;
      // The rejection itself is intentionally dropped (no caller awaits), but
      // the failure is NOT silent: _turnInner's catch already wrote the error
      // log entry and the turn-lifecycle "ended" event carried the error.
      void this._autoResumeFromIdle().catch(() => { /* rejection consumed; error already surfaced via log + lifecycle */ });
    });
  }

  /**
   * Run a turn that drains queued messages without taking new user input.
   * Acquires the turn lock to serialize with normal turn() calls.
   */
  private async _autoResumeFromIdle(): Promise<void> {
    await this._withTurnLock(async () => {
      if (this._agentState !== "idle") return;
      if (this._activeAsk) return;
      if (this._pendingTurnState) return;
      // Skip if there's nothing to process: no inbox messages AND no recent
      // user_message entry awaiting a response.
      if (this._inbox.length === 0 && !this._hasUnprocessedUserMessage()) return;
      try {
        await this._turnInner("", { skipUserInput: true });
      } catch (err) {
        // Same catch-all as turn(): without it, pre-loop failures in an
        // auto-resume turn would be fully invisible (no caller awaits this).
        this._recordTurnFailure(err);
        throw err;
      }
    });
  }

  /**
   * Scan the log backward to find whether the most recent turn-relevant entry
   * is a user_message that hasn't been responded to (no assistant_text/tool_call/
   * reasoning after it). Used by auto-resume to decide whether to fire a new
   * turn after a finally-block drain wrote messages without the model seeing
   * them.
   */
  private _hasUnprocessedUserMessage(): boolean {
    const delivered = new Set<string>();
    for (const entry of this._log) {
      if (entry.discarded) continue;
      if (entry.type !== "user_message") continue;
      const inputId = entry.meta["inputId"];
      if (typeof inputId === "string") delivered.add(inputId);
    }
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.discarded) continue;
      if (entry.type !== "input_received") continue;
      const inputKind = entry.meta["inputKind"];
      // "compact" inputs are consumed by the compact phase itself and never
      // await a model reply —counting them here would schedule ghost
      // auto-resume turns after every /compact.
      if (inputKind !== "user" && inputKind !== "summarize") continue;
      const inputId = entry.meta["inputId"];
      return typeof inputId === "string" && !delivered.has(inputId);
    }
    return false;
  }

  /**
   * Check whether the inbox has pending messages.
   */
  private _hasInboxMessages(): boolean {
    return this._inbox.length > 0;
  }

  /**
   * Check whether the inbox has pending WAKING messages. Ride-along messages
   * (wake === false) don't block manual context commands —they are passive
   * records (e.g. user-initiated kill notices) that wait for the next turn.
   */
  private _hasWakingInboxMessages(): boolean {
    return this._inbox.some((msg) => msg.wake !== false);
  }

  /**
   * Pre-activation prelude shared by every entry that records a NEW active
   * input (user message, /summarize, /compact). The single choke point that
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
  private _beginActiveInput(
    inputKind: "user" | "summarize" | "compact",
    display: string,
    content: unknown,
  ): { inputIndex: number; inputId: string; contextId: string } {
    this._drainInboxAsEntries();
    return this._recordInputReceived(inputKind, display, content);
  }

  private _hasTrackedShells(): boolean {
    return this._shellManager.hasTrackedShells();
  }

  private _hasRunningShells(): boolean {
    return this._shellManager.hasRunningShells();
  }

  private _buildShellReport(): string {
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
  private _drainInboxAsEntries(): number {
    if (this._inbox.length === 0) return 0;
    const messages = [...this._inbox];
    this._inbox = [];

    for (const msg of messages) {
      switch (msg.type) {
        case "user_input": {
          // Invariant: _deliverMessage populates these fields synchronously
          // when user_input arrives. Drain should never see an unprepared one.
          if (msg.inputIndex === undefined || !msg.inputId || !msg.contextId) {
            throw new Error(
              "user_input must have inputId/inputIndex/contextId by drain time " +
              "(set in _deliverMessage). Got: " + JSON.stringify({
                inputId: msg.inputId,
                inputIndex: msg.inputIndex,
                contextId: msg.contextId,
              }),
            );
          }
          this._turnCount = Math.max(this._turnCount, msg.inputIndex);
          this._appendDeliveredUserMessage(
            msg.inputIndex,
            msg.inputId,
            "user",
            msg.content,
            msg.content,
            msg.contextId,
          );
          break;
        }
        case "peer_message": {
          const ctxId = this._allocateContextId();
          const entry = createUserMessageEntry(
            this._nextLogId("user_message"),
            this._turnCount,
            `[Agent ${msg.sender}]`,
            `<system-message>\n${msg.content}\n</system-message>`,
            ctxId,
            { tuiVisible: false, inputKind: "peer" },
          );
          entry.tuiVisible = false;
          this._appendEntry(entry, false);
          break;
        }
        case "system_notice": {
          const ctxId = this._allocateContextId();
          const display = msg.tuiVisible ? msg.content : "[System]";
          const entry = createUserMessageEntry(
            this._nextLogId("user_message"),
            this._turnCount,
            display,
            `<system-message>\n${msg.content}\n</system-message>`,
            ctxId,
            { tuiVisible: Boolean(msg.tuiVisible), inputKind: "system" },
          );
          if (!msg.tuiVisible) entry.tuiVisible = false;
          this._appendEntry(entry, false);
          break;
        }
      }
    }
    return messages.length;
  }

  private _makeAbortPromise(signal: AbortSignal | null | undefined): Promise<"aborted"> | null {
    if (!signal) return null;
    if (signal.aborted) return Promise.resolve("aborted");
    return new Promise<"aborted">((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
  }

  private _installCurrentTurnSignal(signal?: AbortSignal): {
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

  private _restoreCurrentTurnSignal(state: {
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
  async waitForTurnComplete(): Promise<void> {
    while (this._turnInFlight) {
      try { await this._turnInFlight; } catch { /* ignore errors from aborted turns */ }
    }
  }

  /**
   * Promise-based turn lock. Ensures at most one turn entry point executes
   * at a time. Callers are serialized: if a turn is in flight, the next
   * caller waits for it to finish (which happens quickly after abort).
   */
  private async _withTurnLock<T>(fn: () => Promise<T>): Promise<T> {
    // Claim the lock SYNCHRONOUSLY (before any await): the old
    // check-then-claim around an await let two same-tick callers both see a
    // free lock and run concurrently —e.g. two fire-and-forget submitTurn
    // frames arriving in one stdin chunk. Everything layered on this lock
    // (turn serialization, the error-entry once-flag, lifecycle pairing)
    // assumes real mutual exclusion.
    const prev = this._turnInFlight;
    let release!: () => void;
    const myGate = new Promise<void>((resolve) => { release = resolve; });
    // _turnInFlight resolves when the LAST queued claimant releases. Gate
    // promises only ever resolve (fn errors propagate to the caller, not the
    // gate), so the .then chain needs no rejection arm.
    const tail = prev ? prev.then(() => myGate) : myGate;
    this._turnInFlight = tail;
    if (prev) {
      await prev;
    }
    this._turnErrorEntryWritten = false;
    this._lifecycleEndedEmitted = false;
    try {
      return await fn();
    } finally {
      // Only the last claimant clears the field; intermediate finishes leave
      // it pointing at the still-pending tail so waitForTurnComplete works.
      if (this._turnInFlight === tail) {
        this._turnInFlight = null;
      }
      release();
    }
  }

  /**
   * Prepare and execute interruption cleanup for the current turn.
   *
   * This captures a non-destructive delivery snapshot first, then kills active
   * workers and drops unconsumed runtime state.
   */
  requestTurnInterrupt(): { accepted: true } {
    // Abort main turn ONLY. Sub-agents and background shells are independent
    // background work —they continue running. Explicit Ctrl+X / Ctrl+K
    // kills them separately.
    //
    // A pending ask means there is no live turn to abort —the turn already
    // returned when it suspended. Every stop entry point resolves the ask as
    // deny-and-stop (Q9) so the log gets a definite outcome instead of an
    // orphan ask_request + unresolved tool_call.
    if (this._activeAsk) {
      const decision = this.denyAndInterruptPendingAsk();
      if (decision.accepted) return { accepted: true };
    }
    this._currentTurnAbortController?.abort();
    if (this._pendingTurnState) {
      // Suspended-but-resolved work (approval granted, resume not started):
      // finalize it so no approved-but-unexecuted tool_call survives as an
      // orphan that would poison every later API projection.
      const startIdx = this._findEarliestPendingToolCallLogIndex();
      this._pendingTurnState = null;
      this._finalizeDrainInterruptedWork(startIdx);
    }
    return { accepted: true };
  }

  denyAndInterruptPendingAsk(): { accepted: boolean; reason?: string; turnFinished?: boolean } {
    const ask = this._activeAsk;
    if (!ask) {
      const pendingAsk = this.getPendingAsk();
      if (!pendingAsk) return { accepted: false, reason: "no_pending_ask" };
      const child = this._findChildWithPendingAsk(pendingAsk.id);
      if (!child?.session) return { accepted: false, reason: "ask_owner_not_found" };

      const decision = child.session.denyAndInterruptPendingAsk();
      if (!decision.accepted) return decision;

      child.terminationCause = "user_targeted_kill";
      this._finishChildTurn(child);
      this._notifyLogListeners();
      this.onSaveRequest?.();
      // Root turn is still running (child was killed, root continues with its result).
      return { accepted: true, turnFinished: false };
    }

    const interruptionStartIdx = this._findEarliestPendingToolCallLogIndex();
    if (!this.denyPendingAsk()) {
      return { accepted: false, reason: "deny_failed" };
    }
    this._currentTurnAbortController?.abort();
    this._finalizeDrainInterruptedWork(interruptionStartIdx);
    return { accepted: true, turnFinished: true };
  }

  /**
   * Cascade-kill all running child agents and background shells.
   * Called by TUI on Ctrl+X.
   */
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
  denyPendingAsk(): boolean {
    const ask = this._activeAsk;
    if (!ask) {
      // Find the child that owns the visible ask and deny via routing
      const pendingAsk = this.getPendingAsk();
      if (!pendingAsk) return false;
      const child = this._findChildWithPendingAsk(pendingAsk.id);
      if (!child?.session) return false;
      child.session.denyPendingAsk();
      this._resumeChildPendingTurn(child);
      this._notifyLogListeners();
      this.onSaveRequest?.();
      return true;
    }

    if (ask.kind === "approval") {
      const denyIndex = ask.options.length - 1;
      this._resolveOwnApprovalAsk(ask.id, denyIndex);
      return true;
    }

    // agent_question: synthesize decline resolution + error tool_result.
    const toolCallId = (ask.payload as Record<string, unknown>)["toolCallId"] as string ?? "ask";
    const anchor = this._toolCallAnchor(toolCallId, ask);
    this._appendEntry(createAskResolution(
      this._nextLogId("ask_resolution"),
      anchor.turnIndex,
      { declined: true },
      ask.id,
      "agent_question",
    ), false);

    const contextId = this._findToolCallContextId(toolCallId, ask.roundIndex)
      ?? this._allocateContextId();
    this._appendEntry(createToolResultEntry(
      this._nextLogId("tool_result"),
      anchor.turnIndex,
      anchor.roundIndex,
      {
        toolCallId,
        toolName: "ask",
        content: "ERROR: User declined to answer the question.",
        toolSummary: "ask declined",
      },
      { isError: true, contextId },
    ), false);

    this._askHistory.push({
      askId: ask.id,
      kind: ask.kind,
      summary: ask.summary,
      decidedAt: new Date().toISOString(),
      decision: "declined",
      source: ask.source,
    });
    if (this._askHistory.length > 100) {
      this._askHistory = this._askHistory.slice(-100);
    }

    this._activeAsk = null;
    this._emitAskResolvedProgress(ask.id, "declined", "agent_question");
    this._pendingTurnState = { stage: "activation" };
    this.onSaveRequest?.();
    return true;
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
    this._usageStatsCache = null;
    this._promptSectionEstimates = null;
    this._compactInProgress = false;
    this._hintState = "none";
    this._agentState = "idle";
    this._inbox = [];
    this._currentWorkId = null;
    this._currentWorkStartedAt = 0;
    // _waitHandle removed —await_event uses polling now
    this._activeAsk = null;
    this._askHistory = [];
    this._pendingTurnState = null;
    if (this._childSessions.size > 0) {
      this._archiveAllChildSessions();
    }
    if (this._shellManager.hasTrackedShells()) {
      this._forceKillAllShells();
    }
    this._subAgentCounter = 0;
    this._shellManager.resetCounter();
    this._pendingSummaryEntries = [];
    this._manualSummarizeExactRange = null;
  }

  // ------------------------------------------------------------------
  // Log accessors (v2)
  // ------------------------------------------------------------------

  /** Read-only snapshot of the structured log. */
  get log(): readonly LogEntry[] {
    return this._log;
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
  // Turn listing (shared by /summarize picker and /rewind picker)
  // ------------------------------------------------------------------

  /**
   * Return metadata for every turn in the log (see SessionLog.listTurns).
   * Shared by the /summarize and /rewind pickers.
   */
  listTurns(): TurnListing[] {
    return this._logStore.listTurns();
  }

  // ------------------------------------------------------------------
  // Rewind
  // ------------------------------------------------------------------

  /**
   * Get the list of turn boundaries available for rewind.
   * Only shows real user turns (not injected/compact/summarize turns).
   * Includes turns before compact markers (rewind undoes compacts).
   * Returns turns in reverse chronological order (most recent first).
   */
  getRewindTargets(): Array<{
    turnIndex: number;
    entryIndex: number;
    preview: string;
    timestamp: number;
    fileCount: number;
    additions: number;
    deletions: number;
    filesReverted: boolean;
  }> {
    const userTurns = this.listTurns().filter(t => t.turnKind === "user" || t.turnKind === "summarize");

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
   * Release the full content of entries covered by a freshly landed summary:
   * the API projection already replaces them with the summary, and the TUI
   * scrollback renders from `display`, so the only consumer of the original
   * content from here on is a rewind that rescinds the summary —which
   * restores it from the archive file written here. Without this, both the
   * summary and all covered content stay resident until the next compaction.
   */
  private _archiveSummaryCoveredEntries(summaryEntry: LogEntry): void {
    const sessionDir = this._store?.sessionDir as string | undefined;
    if (!sessionDir) return;
    const covered = (summaryEntry.meta as Record<string, unknown>)["coveredContextIds"];
    if (!Array.isArray(covered) || covered.length === 0) return;
    const coveredSet = new Set(covered.filter((v): v is string => typeof v === "string"));
    const targets: LogEntry[] = [];
    for (const e of this._log) {
      if (e === summaryEntry || e.discarded) continue;
      const ctx = (e.meta as Record<string, unknown>)["contextId"];
      if (typeof ctx === "string" && coveredSet.has(ctx)) targets.push(e);
    }
    try {
      const archived = archiveEntryContents(sessionDir, `summary-${summaryEntry.id}.json.gz`, targets);
      if (archived > 0) {
        // Stripping content is TUI-projection-visible (tool args / full
        // text render from entry.content) —bump the revision so memoized
        // projections recompute.
        this._touchLog();
      }
    } catch {
      // Disk error —write-then-strip left every content in place; the next
      // compaction's archiveWindow picks the same entries up.
    }
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
      this._refreshPlanState();
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
    this._summarizeToolWhitelist = null;
    this._hintState = "none";
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

    this._refreshPlanState();
    this._bumpLogRevision();
    this._notifyLogListeners();
    this.onSaveRequest?.();
  }

  /**
   * Check for and recover from a crashed rewind on session restore.
   */
  recoverRewindIfNeeded(): void {
    this._rewindEngine.recoverJournalIfNeeded();
  }

  /**
   * Restore session from a loaded log.
   */
  prepareRestoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    idAllocator: LogIdAllocator,
  ): PreparedSessionRestore {
    if ((meta.childSessions?.length ?? 0) > 0 && !this._sessionArtifactsOverride && !this._getArtifactsDirIfAvailable()) {
      throw new Error(
        "Cannot restore child sessions before the session store is bound to the target session directory.",
      );
    }

    // Parse on cloned data —everything that can fail (model resolution, log
    // surgery) happens here, so a failed restore never pollutes the live
    // session (see session-persistence.ts).
    const clonedEntries = structuredClone(entries) as LogEntry[];
    const clonedAllocator = new LogIdAllocator();
    clonedAllocator.restoreFrom(clonedEntries);
    const rootState = parseRestoredState(
      {
        resolveModelSelection: (m) => resolvePersistedModelSelection(this, {
          modelConfigName: m.modelConfigName || undefined,
          modelProvider: m.modelProvider,
          modelSelectionKey: m.modelSelectionKey,
          modelId: m.modelId,
        }),
        getModelConfig: (configName) => this.config.getModel(configName),
        resolveThinkingLevel: (modelName, preferred) => this._resolveThinkingLevelForModel(modelName, preferred),
        describeInitialModelFallback: () => this._describeInitialModel(),
        fallbackCreatedAt: this._createdAt,
        agentName: this.primaryAgent.name,
      },
      meta,
      clonedEntries,
      clonedAllocator,
    );

    const warnings: string[] = [];
    const allChildMeta = meta.childSessions ?? [];
    // Restore ALL children as full Session instances (including archived) so
    // TUI can display them and read their logs. _archivedChildren is only
    // populated on close/reset, not on restore.
    const children = this._childSessionManagerInstance.prepareChildRestores(allChildMeta, warnings);

    // Root inbox from meta
    const rootInbox = (meta.inbox ?? []).map((raw) => migrateMessageEnvelope(raw as unknown as Record<string, unknown>));

    return { rootState, children, rootInbox, warnings };
  }

  commitPreparedRestore(prepared: PreparedSessionRestore): string[] {
    const warnings = [...prepared.warnings];

    this._resetTransientState();
    this._mcpConnected = false;
    this._currentTurnSignal = null;
    this._currentTurnAbortController = null;
    this._turnInFlight = null;
    this._applyRestoredState(prepared.rootState);

    this._childSessionManagerInstance.clearTables();
    this._subAgentCounter = 0;
    warnings.push(...this._childSessionManagerInstance.commitPreparedChildren(prepared.children));

    // Restore root inbox from meta
    if (prepared.rootInbox && prepared.rootInbox.length > 0) {
      this._inbox = [...prepared.rootInbox];
    }

    // Restore plan state from plan.md if it exists
    this._refreshPlanState();

    this._bumpLogRevision();
    this._notifyLogListeners();
    return warnings;
  }

  restoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    idAllocator: LogIdAllocator,
  ): void {
    const prepared = this.prepareRestoreFromLog(meta, entries, idAllocator);
    this.commitPreparedRestore(prepared);
  }

  /** Single assignment pass for a parsed restore (no failure paths in here). */
  private _applyRestoredState(state: RestoredSessionState): void {
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
    this._title = state.title;
    this._cachedSummary = state.cachedSummary;
    this._usedContextIds = new Set(state.usedContextIds);
    this._lastInputTokens = state.lastInputTokens;
    this._lastTotalTokens = state.lastTotalTokens;
    this._lastCacheReadTokens = state.lastCacheReadTokens;
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
  getLogForPersistence(): { meta: LogSessionMeta; entries: readonly LogEntry[] } {
    // Include both active and archived children in persistence meta
    const childSessionsMeta: ChildSessionMetaRecord[] = [
      ...[...this._childSessions.values()].map((handle) => ({
        id: handle.id,
        numericId: handle.numericId,
        template: handle.template,
        mode: handle.mode,
        lifecycle: handle.lifecycle,
        outcome: handle.lastOutcome,
        order: handle.order,
        // Released one-shots have no Session (and by definition no live
        // inbox) —this read must tolerate null or every root save after
        // the first settled one-shot would throw.
        inbox: handle.session && handle.session._inbox.length > 0
          ? [...handle.session._inbox]
          : undefined,
      })),
      ...[...this._archivedChildren.values()].map((record) => ({
        id: record.id,
        numericId: record.numericId,
        template: record.template,
        mode: record.mode,
        lifecycle: "archived" as ChildSessionLifecycle,
        outcome: record.outcome,
        order: record.order,
      })),
    ];
    return {
      meta: createLogSessionMeta({
        createdAt: this._createdAt,
        initialModel: this._initialModel,
        projectPath: this._projectRoot,
        modelConfigName: this._persistedModelSelection.modelConfigName ?? "",
        modelProvider: this._persistedModelSelection.modelProvider,
        modelSelectionKey: this._persistedModelSelection.modelSelectionKey,
        modelId: this._persistedModelSelection.modelId,
        turnCount: this._turnCount,
        compactCount: this._compactCount,
        thinkingLevel: this._thinkingLevel,
        title: this._title,
        summary: this._generateSummary(),
        childSessions: childSessionsMeta,
        inbox: this._inbox.length > 0 ? [...this._inbox] : undefined,
      }),
      entries: this._log,
    };
  }

  setStore(store: any): void {
    this._store = store;
    // Re-render system prompt in conversation to reflect correct paths
    this._refreshSystemPromptPaths();
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
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      this._preferredThinkingLevel,
    );

    // 5. Reset MCP connection flag (will reconnect on next turn)
    this._mcpConnected = false;

    // 6. Clear plan state
    if (this._planState.length > 0) {
      this._planState = [];
      this._notifyPlanListeners();
    }

    // 7. /new must start from a truly fresh session tree. _resetTransientState()
    // archives existing children so they can be saved before teardown, but those
    // archived handles must not leak into the next root session's persisted meta.
    this._childSessionManagerInstance.clearTables();

    // 8. Re-init conversation LAST (fresh session state, storage may still be lazy)
    // _initConversation also resets _log and _idAllocator
    this._initConversation();
  }

  private _buildToolExecutors(): Record<string, ToolExecutor> {
    return buildToolExecutors({
      projectRoot: this._projectRoot,
      getSessionArtifactsDir: () => this._resolveSessionArtifacts(),
      supportsMultimodal: this.primaryAgent.modelConfig.supportsMultimodal,
      commExecutors: {
        bash_background: (args) => this._shellManager.execBashBackground(args),
        bash_output: (args) => this._shellManager.execBashOutput(args),
        kill_shell: (args) => this._shellManager.execKillShell(args),
        spawn: (args) => this._execSpawn(args),
        kill_agent: (args) => this._execKillAgent(args),
        check_status: (args) => this._execCheckStatus(args),
        await_event: (args) => this._execAwaitEvent(args),
        show_context: (args) => this._execShowContext(args),
        summarize_context: (args) => this._execSummarizeContextTool(args),
        ask: (args) => this._execAsk(args),
        skill: (args) => this._execSkill(args),
        send: (args) => this._execSend(args),
        reload: () => this._execReload(),
        $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
      },
      overrides: this._toolExecutorOverrides,
      onFileWrite: undefined,
      isPlanFile: (filePath) => this._isPlanFilePath(filePath),
      onPlanFileWrite: () => this._refreshPlanState(),
      getApprovedExternalPrefixes: () => {
        if (this._permissionAdvisor.sessionMode === "yolo") return ["/"];
        return this._permissionRuleStore.getApprovedExternalPrefixes();
      },
      adoptShell: (req) => {
        const entry = this._shellManager.adoptRunningProcess(req);
        return { id: entry.id, logPath: entry.logPath };
      },
    });
  }

  private _ensureCommTools(): void {
    ensureCommTools(this.primaryAgent.tools, this._capabilities);
  }

  // ==================================================================
  // Skills
  // ==================================================================

  /** Read-only access to loaded skills (for command registration). */
  get skills(): ReadonlyMap<string, SkillMeta> {
    return this._skills;
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
    return this._mcpManager;
  }

  async ensureMcpReady(): Promise<void> {
    await this._ensureMcp();
  }

  /** Read-only access to disabled skill names. */
  get disabledSkills(): ReadonlySet<string> {
    return this._disabledSkills;
  }

  /**
   * Return all skills from disk (both enabled and disabled) for UI display.
   */
  getAllSkillNames(): { name: string; description: string; enabled: boolean }[] {
    const allOnDisk = loadSkillsMulti(this._skillRoots);
    return [...allOnDisk.values()].map((s) => ({
      name: s.name,
      description: s.description,
      enabled: !this._disabledSkills.has(s.name),
    }));
  }

  /** Enable or disable a skill by name. Call reloadSkills() afterwards. */
  setSkillEnabled(name: string, enabled: boolean): void {
    if (enabled) {
      this._disabledSkills.delete(name);
    } else {
      this._disabledSkills.add(name);
    }
  }

  notifySkillAvailabilityChanged(changes: {
    enabled?: string[];
    disabled?: string[];
  }): void {
    this._queueToolAvailabilityNotice({
      reason: "the user updated skill availability",
      skillsEnabled: changes.enabled,
      skillsDisabled: changes.disabled,
    });
  }

  /**
   * Rescan skill directories, apply disabled filter, and rebuild
   * the skill tool definition. Returns change report for callers
   * that need it (e.g. /skills command).
   */
  reloadSkills(): { added: string[]; removed: string[]; total: number } {
    const oldNames = new Set(this._skills.keys());
    this._refreshSkills();
    const newNames = new Set(this._skills.keys());

    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));

    return { added, removed, total: this._skills.size };
  }

  /**
   * Build the `skill` tool definition dynamically from loaded skills.
   * Returns null if no skills are available for the agent.
   */
  private _ensureSkillTool(): void {
    this.primaryAgent.tools = ensureSkillTool(
      this.primaryAgent.tools,
      this._capabilities,
      this._skills,
    );
  }

  /**
   * Refresh skills from disk. Called during prompt/tool reload so installed,
   * removed, or modified skills update the dynamic skill tool definition.
   */
  private _refreshSkills(): void {
    if (this._skillRoots.length === 0) return;
    const freshAll = loadSkillsMulti(this._skillRoots);
    const filtered = new Map<string, SkillMeta>();
    for (const [name, skill] of freshAll) {
      if (!this._disabledSkills.has(name)) {
        filtered.set(name, skill);
      }
    }
    this._skills = filtered;
    this._ensureSkillTool();
  }

  /** Execute the `skill` tool —load and return skill instructions. */
  private _execSkill(
    args: Record<string, unknown>,
  ): ToolResult {
    const name = ((args["name"] as string) ?? "").trim();
    if (!name) {
      return new ToolResult({ content: "Error: 'name' parameter is required." });
    }

    const skill = this._skills.get(name);
    if (!skill) {
      const available = [...this._skills.keys()].join(", ");
      return new ToolResult({
        content: `Error: Unknown skill "${name}". Available: ${available || "(none)"}`,
      });
    }

    if (skill.disableModelInvocation) {
      return new ToolResult({
        content: `Error: Skill "${name}" can only be invoked by the user via /${name}.`,
      });
    }

    const skillArgs = ((args["arguments"] as string) ?? "").trim();
    const content = resolveSkillContent(skill, skillArgs);

    return new ToolResult({
      content:
        `[SKILL: ${skill.name}]\n` +
        `Skill directory: ${skill.dir}\n\n` +
        content,
    });
  }

  // ==================================================================
  // reload tool executor
  // ==================================================================

  private _sortedUnique(values: Iterable<string | undefined | null>): string[] {
    return [...new Set([...values].filter((v): v is string => typeof v === "string" && v.length > 0))]
      .sort((a, b) => a.localeCompare(b));
  }

  /** Scan-once helper: do the given entries contain a delivered real user
   * message? Used only to seed _conversationStarted on restore —the live guard
   * reads the cached flag, not this. */
  private _entriesHaveRealUserMessage(entries: Iterable<LogEntry>): boolean {
    for (const entry of entries) {
      if (entry.discarded || entry.type !== "user_message") continue;
      if ((entry.meta as Record<string, unknown>)["inputKind"] === "user") {
        return true;
      }
    }
    return false;
  }

  private _diffNames(before: Iterable<string>, after: Iterable<string>): { added: string[]; removed: string[] } {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    return {
      added: this._sortedUnique([...afterSet].filter((name) => !beforeSet.has(name))),
      removed: this._sortedUnique([...beforeSet].filter((name) => !afterSet.has(name))),
    };
  }

  private _snapshotMcpAvailability(): McpAvailabilitySnapshot {
    const manager = this._mcpManager;
    if (!manager) return { servers: [], tools: [] };

    const toolNames: string[] = [];
    const serverNames: string[] = [];

    try {
      if (typeof manager.getAllTools === "function") {
        for (const tool of manager.getAllTools()) {
          if (typeof tool.name !== "string") continue;
          toolNames.push(tool.name);
          const parts = tool.name.split("__");
          if (parts.length >= 3 && parts[0] === "mcp") {
            const serverName = parts[1];
            if (serverName) serverNames.push(serverName);
          }
        }
      }
    } catch { /* best effort */ }

    try {
      if (typeof manager.getServerStatuses === "function") {
        for (const status of manager.getServerStatuses()) {
          if (status.state === "connected") serverNames.push(status.name);
        }
      }
    } catch { /* best effort */ }

    return {
      servers: this._sortedUnique(serverNames),
      tools: this._sortedUnique(toolNames),
    };
  }

  private _queueToolAvailabilityNotice(notice: ToolAvailabilityNotice): void {
    if (!this._conversationStarted) return;

    const sections: string[] = [
      `Tool availability changed because ${notice.reason}.`,
      "This is normal runtime behavior; do not infer from this change alone that your earlier answer or reasoning was wrong. Use the skills and MCP tools currently available in this turn.",
    ];

    const addList = (label: string, items: string[] | undefined): void => {
      const values = this._sortedUnique(items ?? []);
      if (values.length === 0) return;
      sections.push("", `${label}:`);
      for (const value of values) sections.push(`- ${value}`);
    };

    addList("Skills enabled", notice.skillsEnabled);
    addList("Skills disabled", notice.skillsDisabled);
    addList("Skills now available after reload", notice.skillsAdded);
    addList("Skills no longer available after reload", notice.skillsRemoved);
    addList("MCP servers connected", notice.mcpServersConnected);
    addList("MCP servers disconnected", notice.mcpServersDisconnected);
    addList("MCP servers reconnected or changed", notice.mcpServersChanged);
    addList("MCP tools now available", notice.mcpToolsAdded);
    addList("MCP tools no longer available", notice.mcpToolsRemoved);

    if (sections.length <= 2) return;

    this._deliverMessage({
      type: "system_notice",
      sender: "system",
      timestamp: Date.now(),
      content: sections.join("\n"),
      wake: false,
      tuiVisible: false,
    });
  }

  /**
   * Reload MCP servers from settings. Reads global + local settings,
   * reconfigures the MCPClientManager, and notifies the TUI.
   * Returns a human-readable summary of what changed.
   */
  async reloadMcp(options?: { notice?: boolean; reason?: string }): Promise<string> {
    const before = this._snapshotMcpAvailability();
    const globalSettings = loadGlobalSettings();
    const localSettings = loadLocalSettings(this._projectRoot);
    const effective = Object.keys(localSettings).length > 0
      ? mergeSettings(globalSettings, localSettings)
      : globalSettings;
    const { mcpServers } = settingsToConfigInputs(effective);

    if (this._mcpManager) {
      const mcpResult = await this._mcpManager.reconfigure(mcpServers);

      this._mcpConnected = false;
      await this._ensureMcp();

      const changes: string[] = [];
      if (mcpResult.added.length) changes.push(`+${mcpResult.added.join(", ")}`);
      if (mcpResult.removed.length) changes.push(`-${mcpResult.removed.join(", ")}`);
      if (mcpResult.changed.length) changes.push(`~${mcpResult.changed.join(", ")}`);

      const allTools = this._mcpManager.getAllTools();
      const after = this._snapshotMcpAvailability();
      const serverDiff = this._diffNames(before.servers, after.servers);
      const toolDiff = this._diffNames(before.tools, after.tools);
      if (options?.notice !== false) {
        this._queueToolAvailabilityNotice({
          reason: options?.reason ?? "MCP configuration was reloaded",
          mcpServersConnected: serverDiff.added,
          mcpServersDisconnected: serverDiff.removed,
          mcpServersChanged: mcpResult.changed,
          mcpToolsAdded: toolDiff.added,
          mcpToolsRemoved: toolDiff.removed,
        });
      }

      if (this.onMcpStatus && typeof this._mcpManager.getServerStatuses === "function") {
        this.onMcpStatus(this._mcpManager.getServerStatuses());
      }

      return `MCP: ${allTools.length} tool(s)` +
        (changes.length ? ` (${changes.join("; ")})` : " (no changes)");
    }

    if (mcpServers.length > 0) {
      const { MCPClientManager } = await import("./clients/mcp-client.js");
      this._mcpManager = new MCPClientManager(mcpServers) as unknown as MCPClientManager;
      this._mcpConnected = false;
      await this._ensureMcp();
      const allTools = this._mcpManager!.getAllTools();
      const after = this._snapshotMcpAvailability();
      const serverDiff = this._diffNames(before.servers, after.servers);
      const toolDiff = this._diffNames(before.tools, after.tools);
      if (options?.notice !== false) {
        this._queueToolAvailabilityNotice({
          reason: options?.reason ?? "MCP configuration was reloaded",
          mcpServersConnected: serverDiff.added,
          mcpServersDisconnected: serverDiff.removed,
          mcpToolsAdded: toolDiff.added,
          mcpToolsRemoved: toolDiff.removed,
        });
      }

      if (this.onMcpStatus && typeof this._mcpManager!.getServerStatuses === "function") {
        this.onMcpStatus(this._mcpManager!.getServerStatuses());
      }

      return `MCP: initialized ${mcpServers.length} server(s), ${allTools.length} tool(s)`;
    }

    return "MCP: no servers configured";
  }

  async reconnectMcpServer(serverName: string): Promise<boolean> {
    if (!this._mcpManager || typeof this._mcpManager.reconnectServer !== "function") return false;
    const before = this._snapshotMcpAvailability();
    const ok = await this._mcpManager.reconnectServer(serverName);
    this._mcpConnected = false;
    await this._ensureMcp();
    const after = this._snapshotMcpAvailability();
    const serverDiff = this._diffNames(before.servers, after.servers);
    const toolDiff = this._diffNames(before.tools, after.tools);
    this._queueToolAvailabilityNotice({
      reason: `the user reconnected MCP server '${serverName}'`,
      mcpServersConnected: serverDiff.added,
      mcpServersDisconnected: serverDiff.removed,
      mcpServersChanged: [serverName],
      mcpToolsAdded: toolDiff.added,
      mcpToolsRemoved: toolDiff.removed,
    });
    if (this.onMcpStatus && typeof this._mcpManager.getServerStatuses === "function") {
      this.onMcpStatus(this._mcpManager.getServerStatuses());
    }
    return ok;
  }

  // Command-facing MCP mutation: acquire the turn lock so the connect/disconnect
  // (and the ride-along notice it queues) cannot overlap a turn's tool snapshot.
  // The bare reloadMcp/reconnectMcpServer stay lock-free on purpose —the reload
  // TOOL (_execReload) already runs inside the turn lock, and _withTurnLock is
  // not reentrant, so re-locking there would deadlock.
  async reloadMcpFromCommand(reason: string): Promise<string> {
    return this._withTurnLock(() => this.reloadMcp({ reason }));
  }

  async reconnectMcpServerFromCommand(serverName: string): Promise<boolean> {
    return this._withTurnLock(() => this.reconnectMcpServer(serverName));
  }

  // The /mcp command warms up MCP status before showing the picker. That ensure
  // can connect servers (mutating agent.tools), so it must serialize against
  // turns just like the reload/reconnect variants —no MCP connection work on
  // the command side may run concurrently with a turn's tool snapshot.
  async ensureMcpReadyFromCommand(): Promise<void> {
    return this._withTurnLock(() => this.ensureMcpReady());
  }

  private async _execReload(): Promise<ToolResult> {
    const report: string[] = [];

    // 1. Reload skills + system prompt
    const skillResult = this.reloadSkills();
    report.push(
      `Skills: ${skillResult.total} loaded` +
      (skillResult.added.length ? `, +${skillResult.added.join(", ")}` : "") +
      (skillResult.removed.length ? `, -${skillResult.removed.join(", ")}` : ""),
    );

    // 2. Rebuild system prompt
    this._cachedSystemPrompt = this._assembleSystemPrompt();
    this._promptSectionEstimates = null;
    report.push("System prompt: rebuilt");

    // 3. Reload MCP
    const mcpBefore = this._snapshotMcpAvailability();
    try {
      report.push(await this.reloadMcp({
        notice: false,
        reason: "the reload tool refreshed MCP configuration",
      }));
    } catch (err) {
      report.push(`MCP: reload failed —${err instanceof Error ? err.message : String(err)}`);
    }
    const mcpAfter = this._snapshotMcpAvailability();
    const mcpServerDiff = this._diffNames(mcpBefore.servers, mcpAfter.servers);
    const mcpToolDiff = this._diffNames(mcpBefore.tools, mcpAfter.tools);

    this._queueToolAvailabilityNotice({
      reason: "the reload tool refreshed skills, MCP servers, and the system prompt",
      skillsAdded: skillResult.added,
      skillsRemoved: skillResult.removed,
      mcpServersConnected: mcpServerDiff.added,
      mcpServersDisconnected: mcpServerDiff.removed,
      mcpToolsAdded: mcpToolDiff.added,
      mcpToolsRemoved: mcpToolDiff.removed,
    });

    return new ToolResult({ content: report.join("\n") });
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
  // Plan state
  // ==================================================================

  getPlanState(): PlanCheckpoint[] {
    return this._planState;
  }

  subscribePlan(listener: () => void): () => void {
    this._planListeners.push(listener);
    return () => {
      const idx = this._planListeners.indexOf(listener);
      if (idx !== -1) this._planListeners.splice(idx, 1);
    };
  }

  private _notifyPlanListeners(): void {
    for (const listener of this._planListeners) {
      listener();
    }
  }

  /**
   * Resolve the plan file path. Returns undefined if artifacts dir
   * is not yet available (session storage not created).
   */
  private _getPlanFilePath(): string | undefined {
    const dir = this._sessionArtifactsOverride
      || this._getArtifactsDirIfAvailable();
    if (!dir) return undefined;
    return join(dir, PLAN_FILENAME);
  }

  /**
   * Read and parse the plan file if it exists.
   * Updates _planState and notifies listeners if changed.
   */
  private _refreshPlanState(): void {
    const planPath = this._getPlanFilePath();
    if (!planPath || !existsSync(planPath)) {
      if (this._planState.length > 0) {
        this._planState = [];
        this._notifyPlanListeners();
      }
      return;
    }
    try {
      const content = readFileSync(planPath, "utf-8");
      this._planState = parsePlanFile(content);
      this._notifyPlanListeners();
    } catch {
      // File read error —leave state unchanged.
    }
  }

  // ==================================================================
  // Thinking level + cache hit
  // ==================================================================

  get thinkingLevel(): string {
    return this._thinkingLevel;
  }

  set thinkingLevel(value: string) {
    this._preferredThinkingLevel = value;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      value,
    );
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
  switchModel(modelConfigName: string): void {
    const newModelConfig = this.config.getModel(modelConfigName);
    this.primaryAgent.replaceModelConfig(newModelConfig);
    this._persistedModelSelection = this._buildPersistedModelSelection({
      modelConfigName,
      modelProvider: newModelConfig.provider,
      modelSelectionKey: newModelConfig.model,
      modelId: newModelConfig.model,
    });
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      newModelConfig.model,
      this._preferredThinkingLevel,
    );
  }

  reloadCurrentModelConfig(): void {
    const modelConfigName = this.currentModelConfigName;
    this.config.invalidateModel(modelConfigName);
    const newModelConfig = this.config.getModel(modelConfigName);
    this.primaryAgent.replaceModelConfig(newModelConfig);
    this._persistedModelSelection = this._buildPersistedModelSelection({
      modelConfigName,
      modelProvider: newModelConfig.provider,
      modelSelectionKey: newModelConfig.model,
      modelId: newModelConfig.model,
    });
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      newModelConfig.model,
      this._preferredThinkingLevel,
    );
  }

  applyGlobalPreferences(preferences: GlobalTuiPreferences): void {
    const prefs = createGlobalTuiPreferences(preferences);
    this._preferredThinkingLevel = prefs.thinkingLevel;
    this._preferredAccentColor = prefs.accentColor;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      prefs.thinkingLevel,
    );

    // Restore disabled skills
    if (prefs.disabledSkills && prefs.disabledSkills.length > 0) {
      this._disabledSkills = new Set(prefs.disabledSkills);
      this.reloadSkills();
    }

    // Restore permission mode
    if (prefs.permissionMode && ["read_only", "reversible", "yolo"].includes(prefs.permissionMode)) {
      this._permissionAdvisor.sessionMode = prefs.permissionMode as PermissionMode;
    }
  }

  /**
   * Apply settings from the new SwarmflowSettings + ModelSelectionState system.
   * This replaces applyGlobalPreferences for the new config architecture.
   */
  applySettings(settings: SwarmflowSettings, modelState: ModelSelectionState): void {
    const thinkingLevel = modelState.thinking_level ?? settings.thinking_level ?? "";
    this._preferredThinkingLevel = thinkingLevel;
    this._preferredAccentColor = settings.accent_color;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      thinkingLevel,
    );
    if (settings.context_budget_percent !== undefined) {
      this._contextManager.setBudgetPercent(settings.context_budget_percent);
    }

    // Two-tier summarize hints: on/off + trigger levels. Invalid levels are
    // ignored (defaults stay); the /summarize_hint command validates on input.
    if (settings.summarize_hint) {
      const hint = settings.summarize_hint;
      const level1 = hint.level1 ?? this._thresholds.context_hint_level1;
      const level2 = hint.level2 ?? this._thresholds.context_hint_level2;
      const levelsValid = validateSummarizeHintLevels(level1, level2) === null;
      this.setSummarizeHintConfig({
        enabled: hint.enabled,
        ...(levelsValid ? { level1, level2 } : {}),
      });
    }

    // Restore disabled skills
    if (settings.disabled_skills && settings.disabled_skills.length > 0) {
      this._disabledSkills = new Set(settings.disabled_skills);
      this.reloadSkills();
    }

    // Restore permission mode
    if (settings.permission_mode && ["read_only", "reversible", "yolo"].includes(settings.permission_mode)) {
      this._permissionAdvisor.sessionMode = settings.permission_mode as PermissionMode;
    }
  }

  /** Current two-tier summarize hint configuration. */
  getSummarizeHintConfig(): { enabled: boolean; level1: number; level2: number } {
    return this._contextManager.getSummarizeHintConfig();
  }

  /**
   * Update the two-tier summarize hint configuration (takes effect live).
   * Levels must be pre-validated by the caller (validateSummarizeHintLevels).
   */
  setSummarizeHintConfig(config: { enabled?: boolean; level1?: number; level2?: number }): void {
    this._contextManager.setSummarizeHintConfig(config);
  }

  getGlobalPreferences(): GlobalTuiPreferences {
    return createGlobalTuiPreferences({
      modelConfigName: this._persistedModelSelection.modelConfigName ?? undefined,
      modelProvider: this._persistedModelSelection.modelProvider ?? undefined,
      modelSelectionKey: this._persistedModelSelection.modelSelectionKey ?? undefined,
      modelId: this._persistedModelSelection.modelId ?? undefined,
      thinkingLevel: this._preferredThinkingLevel,
      accentColor: this._preferredAccentColor,
      disabledSkills: this._disabledSkills.size > 0
        ? [...this._disabledSkills]
        : undefined,
      permissionMode: this._permissionAdvisor.sessionMode,
    });
  }

  private _resolveThinkingLevelForModel(modelName: string, preferredLevel: string): string {
    const levels = getThinkingLevels(modelName);
    const highest = levels.length > 0 ? levels[levels.length - 1] : undefined;
    // Non-thinking model —no thinking level to set
    if (!highest) return "none";
    // No preference or legacy "default" —use highest
    if (!preferredLevel || preferredLevel === "default") return highest;
    // Preferred level valid for this model —use it
    if (levels.includes(preferredLevel)) return preferredLevel;
    // Preferred level not available on this model —use highest
    return highest;
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

  set lastCacheReadTokens(value: number) {
    this._lastCacheReadTokens = value;
  }

  // 鈹€鈹€ Cumulative usage stats (derived from log token_update entries) 鈹€鈹€

  /**
   * Estimate token counts for each section of the system prompt using
   * gpt-tokenizer. Cached until prompt/skills/tools reload.
   */
  private _getPromptSectionEstimates(): { systemPrompt: number; tools: number; agentsMd: number; skills: number } {
    if (this._promptSectionEstimates) return this._promptSectionEstimates;

    const recipe = this.primaryAgent.promptRecipe;

    // System Prompt (role body + knowledge —NOT tool docs)
    let estSystemPrompt = 0;
    let estToolDocs = 0;
    if (recipe) {
      const layers = getPromptLayers(recipe);
      estSystemPrompt = gptEncode(layers.roleBody).length + gptEncode(layers.knowledge).length;
      estToolDocs = gptEncode(layers.toolDocs).length;
    } else {
      estSystemPrompt = gptEncode(this.primaryAgent.systemPrompt).length;
    }

    // Tool schemas (ToolDef[] serialized as provider would)
    let estToolSchemas = 0;
    for (const tool of this.primaryAgent.tools) {
      if (tool.name === "skill") continue; // counted separately
      estToolSchemas += gptEncode(
        JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
      ).length;
    }

    // AGENTS.md
    const agentsMdText = readAgentsMemory(this._projectRoot);
    const estAgentsMd = agentsMdText ? gptEncode(agentsMdText).length : 0;

    // Skill tool (description embeds the skill listing)
    const skillDef = buildSkillToolDef(this._skills);
    const estSkills = skillDef
      ? gptEncode(JSON.stringify({ name: skillDef.name, description: skillDef.description, parameters: skillDef.parameters })).length
      : 0;

    // Tools = tool docs (inline in prompt) + tool schemas (API tools[])
    const tools = estToolDocs + estToolSchemas;

    this._promptSectionEstimates = { systemPrompt: estSystemPrompt, tools, agentsMd: estAgentsMd, skills: estSkills };
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

    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCacheRead = 0;
    let cumulativeUncached = 0;
    let firstInput = 0;
    let firstUserMessageTokens = 0;
    let sawFirstUserMessage = false;

    for (const entry of this._log) {
      if (entry.type === "token_update") {
        const meta = entry.meta as Record<string, unknown>;
        const input = meta["inputTokens"] as number;
        if (!Number.isFinite(input) || input <= 0) continue;
        const total = (meta["totalTokens"] as number | undefined) ?? input;
        const cacheRead = (meta["cacheReadTokens"] as number | undefined) ?? 0;
        cumulativeInput += input;
        cumulativeOutput += Math.max(0, total - input);
        cumulativeCacheRead += cacheRead;
        cumulativeUncached += Math.max(0, input - cacheRead);
        if (firstInput === 0) firstInput = input;
      } else if (
        !sawFirstUserMessage &&
        entry.type === "user_message" &&
        (entry.meta as Record<string, unknown>)["inputKind"] === "user"
      ) {
        firstUserMessageTokens = estimateEntryTokens(entry);
        sawFirstUserMessage = true;
      }
    }

    const systemPromptTotal = Math.max(0, firstInput - firstUserMessageTokens);

    // Scale gpt-tokenizer estimates by the ratio between the provider's actual
    // system prompt size and our total estimate, so the per-section numbers add
    // up to the provider-reported figure.
    const est = this._getPromptSectionEstimates();
    const estTotal = est.systemPrompt + est.tools + est.agentsMd + est.skills;
    const ratio = estTotal > 0 ? systemPromptTotal / estTotal : 0;

    const stats: UsageStats = {
      cumulativeInput,
      cumulativeOutput,
      cumulativeCacheRead,
      cumulativeUncached,
      systemPromptTotal,
      systemPromptBreakdown: {
        systemPrompt: Math.round(est.systemPrompt * ratio),
        tools: Math.round(est.tools * ratio),
        agentsMd: Math.round(est.agentsMd * ratio),
        skills: Math.round(est.skills * ratio),
        messages: 0, // filled by the panel from context - systemPromptTotal
      },
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

  computeGlobalTokenStats(): import("./config/persistence.js").GlobalTokenStats {
    return (this._store as import("./config/persistence.js").SessionStore)?.computeGlobalTokenStats?.()
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

  appendErrorMessage(text: string, errorType?: string): void {
    this._appendEntry(
      createErrorEntry(this._nextLogId("error"), this._turnCount, text, errorType),
      true,
    );
  }

  private _getManualContextCommandBlocker(command: "/summarize" | "/compact"): string | null {
    if (this._compactInProgress) {
      return `Cannot run ${command} while compact is in progress.`;
    }
    if (this._agentState !== "idle") {
      return `Cannot run ${command} while the current turn is still running.`;
    }
    if (this._activeAsk) {
      return `Cannot run ${command} while an ask is pending.`;
    }
    if (this._pendingTurnState) {
      return `Cannot run ${command} while a turn is waiting to resume.`;
    }
    if (this._hasActiveAgents()) {
      return `Cannot run ${command} while sub-agents are still running.`;
    }
    if (this._hasRunningShells()) {
      return [
        `Cannot run ${command} while background shells are still running.`,
        this._buildShellReport(),
        "Stop the shells you no longer need (open the Shells panel or run /shells), then retry.",
      ].filter(Boolean).join("\n");
    }
    if (this._hasWakingInboxMessages()) {
      return `Cannot run ${command} while queued messages are waiting to be delivered.`;
    }
    return null;
  }

  private async _runInjectedTurn(
    displayText: string,
    content: string,
    opts?: { signal?: AbortSignal; turnKind?: TurnKind },
  ): Promise<string> {
    this._lastTurnEndStatus = null;
    const inputKind = opts?.turnKind ?? "summarize";
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
        return await this._runInjectedTurn(displayText, content, {
          signal: options?.signal,
          turnKind: "user",
        });
      } catch (err) {
        this._recordTurnFailure(err, options?.signal);
        throw err;
      }
    });
  }

  /**
   * Return the list of items available for the /summarize picker.
   * The picker is a pure turn list: summaries belong to their assigned turn
   * (the nearest preceding surviving user message), so selecting a turn also
   * selects the summaries assigned to it, and turns whose user messages were
   * folded into a summary no longer appear. The /summarize operation's own
   * (future) turn is excluded; the just-finished turn is a valid target.
   */
  getSummarizeTargets(): Array<{
    kind: "turn" | "summary";
    turnIndex: number;
    preview: string;
    timestamp: number;
    contextId?: string;
  }> {
    const view = buildActiveContextView(this._log, { includeCompactContext: false });
    const groupOrder = new Map<string, number>();
    view.groups.forEach((group, index) => groupOrder.set(group.contextId, index));

    const items: Array<{
      kind: "turn" | "summary";
      turnIndex: number;
      preview: string;
      timestamp: number;
      contextId?: string;
      sortKey: number;
    }> = [];

    const visibleGroupsByTurn = new Map<number, number>();
    const markTurn = (turn: number, order: number): void => {
      const current = visibleGroupsByTurn.get(turn);
      if (current === undefined || order < current) {
        visibleGroupsByTurn.set(turn, order);
      }
    };
    for (const group of view.groups) {
      const order = groupOrder.get(group.contextId) ?? Number.MAX_SAFE_INTEGER;
      if (group.isSummary) {
        markTurn(group.assignedTurn, order);
        continue;
      }
      for (let turn = group.turnStart; turn <= group.turnEnd; turn++) {
        markTurn(turn, order);
      }
    }

    // Includes both "user" and "summarize" turns, matching rewind's filter.
    // /summarize injection turns ARE user-triggered actions and may
    // accumulate non-trivial procedural overhead (show_context output,
    // agent's reply, the summarize_context tool call/result); allowing
    // them as direct picker targets lets users summarize that overhead
    // without having to sweep over surrounding turns.
    for (const t of this.listTurns()) {
      if (!t.inActiveWindow) continue;
      if (t.turnKind !== "user" && t.turnKind !== "summarize") continue;
      if (t.turnIndex > this._turnCount) continue;
      const sortKey = visibleGroupsByTurn.get(t.turnIndex);
      if (sortKey === undefined) continue;
      items.push({
        kind: "turn",
        turnIndex: t.turnIndex,
        preview: t.preview,
        timestamp: t.timestamp,
        sortKey,
      });
    }

    items.sort((a, b) => a.sortKey - b.sortKey);
    return items.map(({ sortKey: _, ...rest }) => rest);
  }

  /**
   * Map a turn range to the set of visible (non-covered) context IDs.
   * Only includes context IDs in the active window that are not already
   * covered by a later summary. Summaries count as their assigned turn,
   * so selecting a turn includes the summaries that belong to it.
   */
  getContextIdsForTurnRange(startTurn: number, endTurn: number): string[] {
    const view = buildActiveContextView(this._log, { includeCompactContext: false });
    return view.groups
      .filter((group) => {
        const turnStart = group.isSummary ? group.assignedTurn : group.turnStart;
        const turnEnd = group.isSummary ? group.assignedTurn : group.turnEnd;
        return turnEnd >= startTurn && turnStart <= endTurn;
      })
      .map((group) => group.contextId);
  }

  static readonly SUMMARIZE_TOOL_WHITELIST = new Set([
    "show_context", "summarize_context", "read_file", "grep", "glob", "list_dir",
  ]);

  async runManualSummarize(
    options?: {
      signal?: AbortSignal;
      targetContextIds?: string[];
      focusPrompt?: string;
    },
  ): Promise<string> {
    return this._withTurnLock(async () => {
      // In-lock catch —see runInjectedCommand for why it cannot sit outside.
      try {
        return await this._runManualSummarizeBody(options);
      } catch (err) {
        this._recordTurnFailure(err, options?.signal);
        throw err;
      }
    });
  }

  /** Body of runManualSummarize. Caller holds the turn lock. */
  private async _runManualSummarizeBody(
    options?: {
      signal?: AbortSignal;
      targetContextIds?: string[];
      focusPrompt?: string;
    },
  ): Promise<string> {
    {
      this._ensureSessionStorageReady();
      await this._ensureMcp();

      const blocker = this._getManualContextCommandBlocker("/summarize");
      if (blocker) throw new Error(blocker);

      const targetIds = options?.targetContextIds;
      if (!targetIds || targetIds.length === 0) {
        throw new Error("/summarize requires selecting target turns first.");
      }

      const rangeFrom = targetIds[0];
      const rangeTo = targetIds[targetIds.length - 1];
      const currentView = buildActiveContextView(this._log, { includeCompactContext: false });
      const fromIdx = currentView.order.indexOf(rangeFrom);
      const toIdx = currentView.order.indexOf(rangeTo);
      if (fromIdx < 0 || toIdx < 0 || fromIdx > toIdx) {
        throw new Error("/summarize selected range is no longer available in the active context.");
      }
      const exactContextIds = currentView.order.slice(fromIdx, toIdx + 1);
      const rangeLabel = rangeFrom === rangeTo ? rangeFrom : `${rangeFrom}..${rangeTo}`;
      const groupWord = exactContextIds.length === 1 ? "group" : "groups";
      const displayText = options?.focusPrompt?.trim()
        ? `/summarize ${options.focusPrompt.trim()}`
        : `/summarize ${rangeLabel}`;
      const focusTail = options?.focusPrompt?.trim()
        ? `\n\nUser's additional focus: ${options.focusPrompt.trim()}`
        : "";
      const prompt = [
        displayText,
        ``,
        `<system-message>`,
        `The user invoked the /summarize command, manually requesting summarization of context range ${rangeFrom}..${rangeTo} (${exactContextIds.length} ${groupWord}). For this turn only, the rule "do not summarize ranges containing user messages" is lifted for the specified range.`,
        ``,
        `Instructions for this turn:`,
        `1. Call \`show_context\` to inspect the content and size of the range.`,
        `2. You may call \`read_file\`, \`grep\`, \`glob\`, or \`list_dir\` to verify details before writing the summary content.`,
        `3. Call \`summarize_context\` exactly once, with from="${rangeFrom}" and to="${rangeTo}". Do not split, shrink, or expand this range.`,
        `4. If the range contains user messages —or summaries carrying <user-message> blocks —reproduce the user's original words verbatim inside a <user-message> block in your summary content, as a numbered list in chronological order. Never paraphrase, tighten, or omit any part of them. Two clarifications:`,
        `   - File contents attached to user messages (e.g., inlined via @file references, pasted code blocks, or other resolved file refs) are not the user's words —they are data. Summarize them under the normal "preserve concrete facts" rules. The user's surrounding prose, including the @-reference itself, still goes verbatim into the <user-message> block.`,
        `   - Only an explicit user instruction (e.g., in the focus prompt below) may relax verbatim preservation.`,
        `5. For non-user-message content, match the information density of the original —preserve file paths with line numbers, key decisions and why, unresolved issues, code references you'd look back at, and any constraints the user stated.`,
        `6. After summarizing, reply with a one-line description of what was summarized (e.g. "Summarized turns 3-5: auth exploration and test results"). Do not repeat the summary content.`,
        ``,
        `Do NOT continue the main task.`,
        `</system-message>${focusTail}`,
      ].join("\n");

      // Enable tool whitelist for this turn
      this._summarizeToolWhitelist = (this.constructor as typeof Session).SUMMARIZE_TOOL_WHITELIST;
      this._manualSummarizeExactRange = {
        from: rangeFrom,
        to: rangeTo,
        contextIds: exactContextIds,
      };
      try {
        return await this._runInjectedTurn(
          displayText,
          prompt,
          { signal: options?.signal, turnKind: "summarize" },
        );
      } finally {
        this._summarizeToolWhitelist = null;
        this._manualSummarizeExactRange = null;
      }
    }
  }

  async runManualCompact(instruction?: string, options?: { signal?: AbortSignal }): Promise<void> {
    return this._withTurnLock(async () => {
      // In-lock catch —see runInjectedCommand for why it cannot sit outside.
      try {
        return await this._runManualCompactBody(instruction, options);
      } catch (err) {
        this._recordTurnFailure(err, options?.signal);
        throw err;
      }
    });
  }

  /** Body of runManualCompact. Caller holds the turn lock. */
  private async _runManualCompactBody(instruction?: string, options?: { signal?: AbortSignal }): Promise<void> {
    {
      this._ensureSessionStorageReady();

      const blocker = this._getManualContextCommandBlocker("/compact");
      if (blocker) throw new Error(blocker);

      this._lastTurnEndStatus = null;
      const displayText = instruction?.trim() ? `/compact ${instruction.trim()}` : "/compact";
      this._beginActiveInput("compact", displayText, displayText);
      this._appendEntry(
        createStatus(
          this._nextLogId("status"),
          this._turnCount,
          "[Manual compact requested]",
          "manual_compact",
        ),
        false,
      );
      this.onSaveRequest?.();

      const prompt = appendManualInstruction(
        COMPACT_PROMPT_OUTPUT,
        instruction,
        "compact",
      );
      const prevAgentState = this._agentState;
      const turnSignalState = this._installCurrentTurnSignal(options?.signal);
      this._agentState = "working";
      this._beginWorkIfNeeded();
      const logLenBeforeCompact = this._log.length;
      try {
        await this._doAutoCompact("before_turn", turnSignalState.signal, prompt);
        this._hintState = "none";
        this.onSaveRequest?.();
        this._finishCurrentWork("completed");
      } catch (err) {
        if (turnSignalState.signal.aborted || (err as { name?: string })?.name === "AbortError") {
          for (let ci = logLenBeforeCompact; ci < this._log.length; ci++) {
            this._log[ci].discarded = true;
          }
          this._appendInterruptionSystemMessage([], true);
          this._recordSessionEvent("interrupted by user");
          this._finishCurrentWork("interrupted");
        } else {
          this._recordTurnFailure(err, turnSignalState.signal);
          this._finishCurrentWork("error");
        }
        throw err;
      } finally {
        this._restoreCurrentTurnSignal(turnSignalState);
        this._agentState = prevAgentState;
      }
      // Waking messages held back during compact (Q6) get their delivery turn
      // now that the session is idle again.
      if (this._hasWakingInboxMessages()) {
        this._scheduleAutoResume();
      }
    }
  }

  // ==================================================================
  // Ask state
  // ==================================================================

  /**
   * Restore ask state from log entries.
   * Scans for unclosed ask_request (no matching ask_resolution).
   */
  getPendingAsk(): PendingAskUi | null {
    const ownAsk = toPendingAskUi(this._activeAsk);
    if (ownAsk) return ownAsk;
    for (const handle of this._childSessions.values()) {
      const childAsk = handle.session?.getPendingAsk();
      if (childAsk) return childAsk;
    }
    return null;
  }

  hasPendingTurnToResume(): boolean {
    return this._pendingTurnState !== null;
  }

  private _emitAskRequestedProgress(ask: AskRequest): void {
    if (!this._progress) return;
    this._progress.emit({
      step: this._turnCount,
      agent: ask.source.agentName || this.primaryAgent.name,
      action: "ask_requested",
      message: `  [ask] ${ask.summary}`,
      level: "normal" as ProgressLevel,
      timestamp: Date.now() / 1000,
      usage: {},
      extra: { ask: toPendingAskUi(ask) },
    });
  }

  private _emitAskResolvedProgress(askId: string, decision: string, askKind?: string): void {
    if (!this._progress) return;
    this._progress.emit({
      step: this._turnCount,
      agent: this.primaryAgent.name,
      action: "ask_resolved",
      message: `  [ask] resolved: ${decision}`,
      level: "normal" as ProgressLevel,
      timestamp: Date.now() / 1000,
      usage: {},
      extra: { askId, decision, askKind },
    });
  }

  /** Returns true if the path is strictly inside the session artifacts dir. */
  private _isInsideArtifactsDir(rawPath: unknown): boolean {
    if (typeof rawPath !== "string" || !rawPath) return false;
    const artifactsDir = this._getArtifactsDirIfAvailable();
    if (!artifactsDir) return false;
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(this._projectRoot, rawPath);
    const rel = relative(artifactsDir, absPath);
    if (!rel) return false; // exact match means writing the artifacts dir itself
    if (rel.startsWith("..")) return false;
    if (isAbsolute(rel)) return false;
    return true;
  }

  private _beforeToolExecute = async (
    ctx: ToolPreflightContext,
  ): Promise<ToolPreflightDecision | void> => {
    // 0a. /summarize tool whitelist: reject tools not in the whitelist
    if (this._summarizeToolWhitelist) {
      if (!this._summarizeToolWhitelist.has(ctx.toolName)) {
        return {
          kind: "deny",
          message: `Tool "${ctx.toolName}" is not available during /summarize. Allowed: ${[...this._summarizeToolWhitelist].join(", ")}.`,
        };
      }
    }

    // 0b. Artifacts-dir bypass: file tools (read/write/edit/list/glob/grep)
    //    operating inside session artifacts/ don't need approval (agent-owned
    //    scratch space). Bash is excluded —its cwd-tracking is a separate gate.
    const ARTIFACTS_BYPASS_TOOLS = new Set([
      "read_file", "write_file", "edit_file", "list_dir", "glob", "grep",
    ]);
    const skipPermissionGate =
      ARTIFACTS_BYPASS_TOOLS.has(ctx.toolName) &&
      this._isInsideArtifactsDir((ctx.toolArgs as Record<string, unknown>)["path"]);

    // 1. Permission gate check (skip for artifacts-dir file ops)
    if (!skipPermissionGate) {
      const decision = await this.toolGate.evaluate(ctx);
      switch (decision.kind) {
        case "deny":
          return { kind: "deny", message: decision.message };
        case "ask": {
          const options = decision.offers.map((o) => o.label);
          options.push("Deny");

          const BROAD_RULE_COMMANDS = new Set(["cp", "mv", "rm", "chmod", "chown"]);
          const hasPersistent = decision.offers.some(o => o.type === "tool_pattern");
          const pattern = decision.assessment.canonicalPattern ?? "";
          const persistentWarning = hasPersistent && BROAD_RULE_COMMANDS.has(pattern)
            ? `Persistent rules below will apply to ALL "${pattern}" commands, which may cause DANGER.`
            : undefined;

          const ask: ApprovalRequest = {
            id: `approval-${randomUUID().slice(0, 8)}`,
            kind: "approval",
            createdAt: new Date().toISOString(),
            source: { agentId: ctx.agentName },
            summary: decision.question,
            roundIndex: undefined,
            payload: {
              toolCallId: ctx.toolCallId,
              toolName: ctx.toolName,
              toolSummary: ctx.summary,
              permissionClass: decision.assessment.permissionClass,
              offers: decision.offers.map((o) => ({
                type: o.type,
                label: o.label,
                scope: o.scope,
                rule: o.rule as Record<string, unknown> | undefined,
              })),
              persistentWarning,
            },
            options,
          };
          return { kind: "ask", ask };
        }
      }
    }

    // 2. PreToolUse hooks (run after permission gate allows)
    if (this.hookRuntime.hooks.length > 0) {
      const hookPayload: HookPayload = {
        event: "PreToolUse",
        timestamp: Date.now(),
        toolName: ctx.toolName,
        toolArgs: ctx.toolArgs,
        toolCallId: ctx.toolCallId,
      };
      const hookResult = await this.hookRuntime.evaluate("PreToolUse", hookPayload);
      if (hookResult.decision === "deny") {
        return { kind: "deny", message: hookResult.denyReason ?? "Denied by hook" };
      }
      // Apply updatedInput from hooks (merge into tool args)
      if (hookResult.updatedInput) {
        Object.assign(ctx.toolArgs, hookResult.updatedInput);
      }
    }

    return undefined;
  };


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
  private async _resumeActivationStage(options?: { signal?: AbortSignal }): Promise<string> {
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

  private async _resumeActivationStageInner(options?: { signal?: AbortSignal }): Promise<string> {
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
  private _firstPendingToolCall(): { index: number; entry: LogEntry } | null {
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

  private _findEarliestPendingToolCallLogIndex(): number {
    return this._firstPendingToolCall()?.index ?? this._log.length;
  }

  private _finalizeDrainInterruptedWork(fromLogIndex: number): void {
    this._handleInterruption(fromLogIndex, "", { activationCompleted: false });

    for (let index = fromLogIndex; index < this._log.length; index += 1) {
      const entry = this._log[index]!;
      if (entry.type !== "tool_call") continue;
      if (entry.turnIndex !== this._turnCount) continue;
      const meta = entry.meta as Record<string, unknown>;
      const execState = meta["toolExecState"];
      if (execState === "running" || execState === "not_started") {
        meta["toolExecState"] = "failed";
      }
    }

    this._agentState = "idle";
    this._activeLogEntryId = null;
    this._setSelfPhase("idle");
    if (!this._activeAsk && this._turnCount > 0) {
      this._finishCurrentWork("interrupted", this._collectInterruptHints());
    }
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
  private async _drainPendingToolCalls(signal?: AbortSignal): Promise<DrainPendingToolCallsResult> {
    while (true) {
      if (signal?.aborted) return { kind: "interrupted" };

      const next = this._findNextPendingToolCall();
      if (!next) return { kind: "drained" };

      // Mark as running in tool_call meta so the display shows shimmer.
      this._updateToolCallExecState(next.toolCallId, "running");

      const ctx: ToolPreflightContext = {
        agentName: next.agentName,
        toolName: next.toolName,
        toolArgs: next.toolArgs,
        toolCallId: next.toolCallId,
        summary: `${next.agentName} is calling ${next.toolName}`,
      };

      let denyMessage: string | undefined;
      let allowOnce = false;
      // Skip the permission gate if this tool_call was already approved
      // (allow-once grant was set in resolveApprovalAsk before resume).
      allowOnce = this._permissionAdvisor["_allowOnceGrants"].has(next.toolCallId);
      if (!allowOnce) {
        const decision = await this._beforeToolExecute(ctx);
        if (signal?.aborted) {
          this._updateToolCallExecState(next.toolCallId, "not_started");
          return { kind: "interrupted" };
        }
        if (decision && decision.kind === "ask") {
          const ask = decision.ask;
          ask.turnIndex = next.turnIndex;
          const askContextId = this._findToolCallContextId(next.toolCallId, next.roundIndex);
          this._updateToolCallExecState(next.toolCallId, "not_started");
          this._activeAsk = ask;
          this._agentState = "waiting";
          this._emitAskRequestedProgress(this._activeAsk);
          this._appendEntry(createAskRequest(
            this._nextLogId("ask_request"),
            next.turnIndex,
            this._activeAsk.payload,
            this._activeAsk.id,
            this._activeAsk.kind,
            next.toolCallId,
            next.roundIndex,
            askContextId,
          ), false);
          this._pendingTurnState = { stage: "activation" };
          this.onSaveRequest?.();
          return { kind: "suspended", ask, toolCallId: next.toolCallId };
        }
        if (decision && decision.kind === "deny") {
          denyMessage = decision.message;
        }
      } else {
        // Gate already passed; still run hooks
        if (this.hookRuntime.hooks.length > 0) {
          const hookResult = await this.hookRuntime.evaluate("PreToolUse", {
            event: "PreToolUse",
            timestamp: Date.now(),
            toolName: next.toolName,
            toolArgs: next.toolArgs,
            toolCallId: next.toolCallId,
          });
          if (signal?.aborted) {
            this._updateToolCallExecState(next.toolCallId, "not_started");
            return { kind: "interrupted" };
          }
          if (hookResult.decision === "deny") {
            denyMessage = hookResult.denyReason ?? "Denied by hook";
          } else if (hookResult.updatedInput) {
            Object.assign(next.toolArgs, hookResult.updatedInput);
          }
        }
      }

      // Execute (or deny)
      const contextId = this._findToolCallContextId(next.toolCallId, next.roundIndex)
        ?? this._allocateContextId();
      const execStartMs = Date.now();
      let resultContent = "";
      let isError = false;
      let toolMetadata: Record<string, unknown> = {};

      if (denyMessage) {
        resultContent = `ERROR: ${denyMessage}`;
        isError = true;
      } else {
        const executor = this._toolExecutors[next.toolName];
        try {
          if (signal?.aborted) {
            this._updateToolCallExecState(next.toolCallId, "not_started");
            return { kind: "interrupted" };
          }
          if (!executor) {
            resultContent = `ERROR: No executor for tool '${next.toolName}'`;
            isError = true;
          } else {
            const result = await executor(next.toolArgs, { signal });
            // Keep toolExecState as "running" here —_completeMissingToolResultsFromLog
            // uses it to distinguish "ran but interrupted" (partial effects) from "never ran".
            if (signal?.aborted) return { kind: "interrupted" };
            if (typeof result === "string") {
              resultContent = result;
            } else if (result instanceof ToolResult) {
              resultContent = result.content;
              toolMetadata = { ...result.metadata };
              if (result.contentBlocks) {
                toolMetadata._contentBlocks = result.contentBlocks;
              }
            } else {
              resultContent = String(result);
            }
            isError = resultContent.startsWith("ERROR:");
          }
        } catch (e) {
          if ((e as any)?.name === "AbortError" || signal?.aborted) {
            return { kind: "interrupted" };
          }
          resultContent = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }

      // Build preview (matches tool-loop's logic)
      const previewSrc = toolMetadata["tui_preview"];
      let previewText: string | undefined;
      let previewDim: boolean | undefined;
      if (previewSrc && typeof previewSrc === "object") {
        const text = (previewSrc as Record<string, unknown>)["text"];
        if (typeof text === "string" && text.trim()) {
          previewText = text;
          previewDim = (previewSrc as Record<string, unknown>)["dim"] === true ? true : undefined;
        }
      }
      if (!previewText && !isError) {
        const lines = resultContent.split("\n");
        previewText = lines.length > 20
          ? lines.slice(0, 20).join("\n") + `\n... (${lines.length - 20} more lines)`
          : resultContent;
        previewDim = true;
      }

      this._appendEntry(createToolResultEntry(
        this._nextLogId("tool_result"),
        next.turnIndex,
        next.roundIndex,
        {
          toolCallId: next.toolCallId,
          toolName: next.toolName,
          content: resultContent,
          toolSummary: `${next.toolName} ${isError ? "failed" : "completed"}`,
        },
        {
          isError,
          contextId,
          toolMetadata: Object.keys(toolMetadata).length > 0 ? toolMetadata : undefined,
          execStartMs,
          previewText,
          previewDim,
        },
      ));
      this._updateToolCallExecState(next.toolCallId, isError ? "failed" : "completed");

      if (this.hookRuntime.hooks.length > 0) {
        const event = isError ? "PostToolUseFailure" : "PostToolUse";
        this.hookRuntime.fireAndForget(event, {
          event,
          timestamp: Date.now(),
          toolName: next.toolName,
          toolCallId: next.toolCallId,
          agentId: next.agentName,
        });
      }

      this.onSaveRequest?.();
    }
  }

  /**
   * Find the next pending tool_call in the active window (no matching result),
   * in log/emission order. Returns null when all are resolved.
   * Window-wide rather than per-turn: an approved tool_call must execute on
   * resume even if the turn counter advanced while the ask was pending.
   */
  private _findNextPendingToolCall(): {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    turnIndex: number;
    roundIndex: number;
    agentName: string;
  } | null {
    const found = this._firstPendingToolCall();
    if (!found) return null;
    const entry = found.entry;
    const meta = entry.meta as Record<string, unknown>;
    const content = entry.content as { name?: string; arguments?: Record<string, unknown> };
    return {
      toolCallId: String(meta["toolCallId"] ?? ""),
      toolName: String(content.name ?? meta["toolName"] ?? ""),
      toolArgs: content.arguments ?? {},
      turnIndex: entry.turnIndex,
      roundIndex: entry.roundIndex ?? 0,
      agentName: String(meta["agentName"] ?? this.primaryAgent.name),
    };
  }

  /** Update tool_call entry's toolExecState meta in-place. */
  private _updateToolCallExecState(
    toolCallId: string,
    state: "not_started" | "running" | "completed" | "failed",
  ): void {
    const entry = this._logStore.findToolCallByCallId(toolCallId);
    if (!entry) return;
    (entry.meta as Record<string, unknown>)["toolExecState"] = state;
    this._touchLog();
  }

  private async _runTurnActivationLoop(
    signal: AbortSignal | undefined,
    textAccumulator: { text: string },
    reasoningAccumulator: { text: string },
  ): Promise<string> {
    let finalText = "";
    let turnEndStatus: "completed" | "interrupted" | "error" | null = null;
    let loopError: string | null = null;
    const turnSignalState = this._installCurrentTurnSignal(signal);
    const activeSignal = turnSignalState.signal;
    this._beginWorkIfNeeded();
    this._emitTurnLifecycle({ phase: "started", turnIndex: this._turnCount });
    try {
      let reachedLimit = true;
      for (let activationIdx = 0; activationIdx < MAX_ACTIVATIONS_PER_TURN; activationIdx++) {
        if (activeSignal.aborted) break;

        const t0 = performance.now();
        const logLenBeforeActivation = this._log.length;
        textAccumulator.text = "";
        reasoningAccumulator.text = "";
        this._agentState = "working";
        this._setSelfPhase("thinking");

        // Capture the turn index ONCE per activation. Every log entry produced
        // by this activation (streamed/finalized reasoning + text, tool calls,
        // ask, status) must share it. `this._turnCount` can advance mid-flight
        // when a queued user message is drained into this same work lifecycle;
        // reading it live would split a single provider round's reasoning from
        // its tool_calls across two turn indices (see projectToApiMessages
        // grouping), producing a degenerate assistant message.
        const activationTurnIndex = this._turnCount;

        if (this._progress) {
          this._progress.onAgentStart(activationTurnIndex, this.primaryAgent.name);
        }

        let result: ToolLoopResult;
        try {
          result = await this._runActivation(activationTurnIndex, activeSignal, textAccumulator, reasoningAccumulator);
        } catch (err: unknown) {
          if ((err as any)?.name === "AbortError" || activeSignal.aborted) {
            this._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
              activationCompleted: false,
            });
            this.onSaveRequest?.();
            finalText = textAccumulator.text.trim() || "";
            turnEndStatus = "interrupted";
            reachedLimit = false;
            break;
          }

          throw err;
        }

        // Check abort AFTER successful completion —handles providers that
        // don't throw AbortError (stream finishes before abort takes effect).
        if (activeSignal.aborted) {
          this._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
            activationCompleted: true,
          });
          this.onSaveRequest?.();
          finalText = textAccumulator.text.trim() || "";
          turnEndStatus = "interrupted";
          reachedLimit = false;
          break;
        }

        if (Number.isFinite(result.lastInputTokens) && result.lastInputTokens > 0) {
          this._lastInputTokens = result.lastInputTokens;
          this._lastTotalTokens = result.lastTotalTokens ?? result.lastInputTokens;
        }
        this._updateHintStateAfterApiCall();

        if (result.suspendedAsk) {
          result.suspendedAsk.ask.turnIndex = activationTurnIndex;
          const askContextId =
            this._findToolCallContextId(result.suspendedAsk.toolCallId, result.suspendedAsk.roundIndex);
          this._activeAsk = result.suspendedAsk.ask;
          this._emitAskRequestedProgress(this._activeAsk);
          this._appendEntry(createAskRequest(
            this._nextLogId("ask_request"),
            activationTurnIndex,
            this._activeAsk.payload,
            this._activeAsk.id,
            this._activeAsk.kind,
            result.suspendedAsk.toolCallId,
            result.suspendedAsk.roundIndex,
            askContextId,
          ), false);
          if (!result.compactNeeded) {
            this._checkAndInjectHint(result);
          }
          this.onSaveRequest?.();
          reachedLimit = false;
          break;
        }

        const elapsed = (performance.now() - t0) / 1000;
        let agentEndEmitted = false;

        const emitAgentEndOnce = () => {
          if (agentEndEmitted || !this._progress) return;
          this._progress.onAgentEnd(
            this._turnCount,
            this.primaryAgent.name,
            elapsed,
            result.totalUsage as Record<string, number>,
          );
          agentEndEmitted = true;
        };

        const _trimmedText = result.text.trimEnd();
        const _hasNoReply = isNoReply(result.text)
          || _trimmedText.endsWith(NO_REPLY_MARKER)
          || (!_trimmedText && result.toolHistory.length === 0);

        if (_hasNoReply) {
          // Strip the <NO_REPLY> marker (if present) —treat as empty response.
          // Emit progress event so TUI can show a status message.
          if (_trimmedText.endsWith(NO_REPLY_MARKER)) {
            result.text = _trimmedText
              .slice(0, _trimmedText.length - NO_REPLY_MARKER.length)
              .trim();
          }

          if (this._progress) {
            this._progress.onNoReplyClear(this.primaryAgent.name);
          }
          emitAgentEndOnce();
          if (this._progress) {
            this._progress.onAgentNoReply(this.primaryAgent.name);
          }
          // Fall through to normal response handling —turn ends naturally.
        }

        if (result.text) {
          finalText = result.text;

          // v2 log: create final assistant_text + optional reasoning entries
          {
            const finalRound = (result.textHandledInLog || result.reasoningHandledInLog)
              ? Math.max(0, this._computeNextRoundIndex(activationTurnIndex) - 1)
              : this._computeNextRoundIndex(activationTurnIndex);
            const finalContextId = this._resolveOutputRoundContextId(activationTurnIndex, finalRound);
            if (result.textHandledInLog || result.reasoningHandledInLog) {
              this._retagRoundEntries(activationTurnIndex, finalRound, finalContextId);
            }
            if (result.reasoningContent && !result.reasoningHandledInLog) {
              this._appendEntry(createReasoning(
                this._nextLogId("reasoning"),
                activationTurnIndex,
                finalRound,
                result.reasoningContent,
                result.reasoningContent,
                result.reasoningState,
                finalContextId,
                result.thinkingArtifact ?? null,
              ), false);
            }
            if (!result.textHandledInLog) {
              const displayText = stripContextTags(result.text);
              this._appendEntry(createAssistantText(
                this._nextLogId("assistant_text"),
                activationTurnIndex,
                finalRound,
                displayText,
                stripContextTags(result.text),
                finalContextId,
              ), false);
            }
          }
        }

        emitAgentEndOnce();
        this.onSaveRequest?.();

        if (result.compactNeeded && result.compactScenario) {
          if (this._hasInboxMessages()) {
            this._drainInboxAsEntries();
          }
          const logLenBefore = this._log.length;
          try {
            await this._doAutoCompact(result.compactScenario!, activeSignal);
          } catch (compactErr) {
            if ((compactErr as any)?.name === "AbortError" || activeSignal.aborted) {
              for (let ci = logLenBefore; ci < this._log.length; ci++) {
                this._log[ci].discarded = true;
              }
              this._appendInterruptionSystemMessage([], true);
              this._recordSessionEvent("interrupted by user");
              this.onSaveRequest?.();
              finalText = textAccumulator.text.trim() || "";
              turnEndStatus = "interrupted";
              reachedLimit = false;
              break;
            }
            throw compactErr;
          }
          // Messages held back during compact (Q6) land after the marker.
          if (this._hasInboxMessages()) {
            this._drainInboxAsEntries();
          }
          this.onSaveRequest?.();
          // Always continue after compact —fresh context, reset activation budget.
          activationIdx = -1;
          continue;
        }

        if (!result.compactNeeded && !result.endedWithoutToolCalls) {
          this._checkAndInjectHint(result);
        }

        // Messages typed while the assistant was producing a final text reply
        // become the next model input in the same work lifecycle.
        if (this._hasInboxMessages()) {
          this._drainInboxAsEntries();
          continue;
        }

        // Final output (no tool calls in the last provider call) →turn ends.
        // Sub-agent results are processed via auto-resume in a new turn.
        // Model should use await_event explicitly to wait for sub-agents.
        // Note: toolHistory.length is cumulative across all rounds in the tool
        // loop, so it can be > 0 even when the last call had no tool_calls.
        if (result.endedWithoutToolCalls) {
          reachedLimit = false;
          turnEndStatus = "completed";
          break;
        }
        // No explicit boundary drain here —the earlier drain check (above)
        // already handles inbox messages before this break decision.
      }

      if (reachedLimit && !activeSignal.aborted) {
        console.warn(`Turn reached activation limit (${MAX_ACTIVATIONS_PER_TURN})`);
        if (!finalText) {
          finalText =
            "[Turn terminated: reached maximum activation limit " +
            "without producing output. This may indicate a stuck loop.]";
        }
        turnEndStatus = "error";
      }
    } catch (err) {
      // Non-abort errors escaping the loop (provider failures, mid-turn
      // compact, drain) end the turn as "error". The visible error log entry
      // is written exactly once per escape path by the entry-point catches
      // (_turnInner / _resumeActivationStage / manual summarize).
      const aborted = (err as { name?: string })?.name === "AbortError" || activeSignal.aborted;
      if (!aborted) {
        loopError = err instanceof Error ? err.message : String(err);
        turnEndStatus = "error";
      }
      throw err;
    } finally {
      this._restoreCurrentTurnSignal(turnSignalState);
      if (turnEndStatus === "interrupted" && this._hasActiveAgents()) {
        await this._waitForAllChildTurnsSettled();
      }
      // A suspended ask keeps the session in "waiting" (Q1): the turn has not
      // ended, it is parked on the user's answer. Input arriving now must
      // queue without advancing the turn counter.
      this._agentState = this._activeAsk ? "waiting" : "idle";
      // Finalize tool_call entries stuck in non-terminal state (e.g. abort during await_event).
      // Scan backward: only the current round's tool_calls can be affected; stop at the first
      // non-tool_call entry after seeing at least one tool_call (entries are interleaved with
      // tool_result, token_update, etc. so we skip those).
      {
        let sawToolCall = false;
        for (let i = this._log.length - 1; i >= 0; i--) {
          const entry = this._log[i];
          if (entry.type !== "tool_call") {
            if (sawToolCall) break;
            continue;
          }
          sawToolCall = true;
          const execState = (entry.meta as Record<string, unknown>)["toolExecState"];
          if (execState === "running" || execState === "not_started") {
            (entry.meta as Record<string, unknown>)["toolExecState"] = "failed";
          }
        }
      }
      this._activeLogEntryId = null;
      this._setSelfPhase("idle");
      if (!this._activeAsk && this._turnCount > 0 && turnEndStatus) {
        let interruptHints: string[] | undefined;
        if (turnEndStatus === "interrupted") {
          interruptHints = this._collectInterruptHints();
        }
        this._finishCurrentWork(turnEndStatus, interruptHints);
      }
      // If the finally drain wrote messages to the log without the model
      // seeing them, schedule an auto-resume turn to process them.
      if (!this._activeAsk && this._hasUnprocessedUserMessage()) {
        this._scheduleAutoResume();
      }
      this._lifecycleEndedEmitted = true;
      this._emitTurnLifecycle({
        phase: "ended",
        turnIndex: this._turnCount,
        status: this._activeAsk
          ? "waiting"
          : turnEndStatus ?? (activeSignal.aborted ? "interrupted" : "completed"),
        ...(loopError !== null && !this._activeAsk ? { error: loopError } : {}),
      });
    }

    return finalText;
  }

  async turn(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
    return this._withTurnLock(async () => {
      try {
        return await this._turnInner(userInput, options);
      } catch (err) {
        // Catch-all for failures _turnInner's own catch doesn't reach
        // (storage/MCP/attachments/before-turn compact). Idempotent against
        // the inner layers via the per-lock once-flags.
        this._recordTurnFailure(err, options?.signal);
        throw err;
      }
    });
  }

  /** Inner turn logic, called from within the turn lock. */
  private async _turnInner(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
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
            if ((compactErr as any)?.name === "AbortError" || signal?.aborted) {
              for (let ci = logLenBefore; ci < this._log.length; ci++) {
                this._log[ci].discarded = true;
              }
              this._beginWorkIfNeeded();
              this._appendInterruptionSystemMessage([], true);
              this._recordSessionEvent("interrupted by user");
              this._finishCurrentWork("interrupted");
              throw compactErr;
            } else {
              throw compactErr;
            }
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
  private _isTurnAbortError(err: unknown, signal?: AbortSignal): boolean {
    return (err as { name?: string })?.name === "AbortError" || signal?.aborted === true;
  }

  // Set while the current turn-lock execution has already written its error
  // log entry; reset on every lock acquisition. Multiple catch layers
  // (entry-point wrappers, resume stage, manual context commands) can then
  // call _recordTurnErrorEntry without double-writing.
  private _turnErrorEntryWritten = false;

  // Whether the current turn-lock execution emitted a lifecycle "ended"
  // event (set by _runTurnActivationLoop's finally). Failure paths that die
  // before the activation loop use this to emit the missing ended(error)
  // exactly once. Reset on every lock acquisition.
  private _lifecycleEndedEmitted = false;

  /**
   * Write the user-visible error log entry for a failed turn —at most once
   * per turn-lock execution, and never for user interrupts. The runtime owns
   * error visibility: all UIs see the entry via log projection. (Historically
   * the TUI's catch wrote this entry, which left server-mode UIs blind to
   * turn errors.)
   */
  private _recordTurnErrorEntry(err: unknown, signal?: AbortSignal): void {
    if (this._turnErrorEntryWritten) return;
    if (this._isTurnAbortError(err, signal)) return;
    if (this._activeAsk) return;
    this._turnErrorEntryWritten = true;
    this.appendErrorMessage(err instanceof Error ? err.message : String(err), "turn");
  }

  /**
   * Full failure surface for a turn that died anywhere inside (or just
   * outside) the turn lock: error log entry + a lifecycle ended(error) event
   * if the activation loop never got to emit one (pre-loop failures:
   * storage, MCP, attachments, before-turn compact, manual-command
   * validation). Both halves are idempotent per lock execution, so every
   * catch layer can call this unconditionally.
   */
  private _recordTurnFailure(err: unknown, signal?: AbortSignal): void {
    this._recordTurnErrorEntry(err, signal);
    if (this._lifecycleEndedEmitted) return;
    if (this._isTurnAbortError(err, signal)) return;
    if (this._activeAsk) return;
    this._lifecycleEndedEmitted = true;
    this._emitTurnLifecycle({
      phase: "ended",
      turnIndex: this._turnCount,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
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
  private _handleInterruption(
    logLenBefore: number,
    accumulatedText: string,
    opts?: { activationCompleted?: boolean },
  ): void {
    const activationCompleted = opts?.activationCompleted ?? false;

    this._activeAsk = null;
    this._pendingTurnState = null;
    this._activeLogEntryId = null;
    // Summaries staged by a summarize_context whose tool_result never landed
    // must die with the interrupted turn —a later flush would append them
    // under the wrong turn.
    this._pendingSummaryEntries = [];

    if (!activationCompleted) {
      discardInterruptedRoundReasoningInLog(this._log, logLenBefore, this._turnCount);
    }

    // Materialize any unsaved partial text from mid-activation streaming.
    let hasAssistantInActivation = false;
    for (let i = logLenBefore; i < this._log.length; i++) {
      if (this._log[i].type === "assistant_text" && !this._log[i].discarded) {
        hasAssistantInActivation = true;
      }
    }
    if (!activationCompleted && !hasAssistantInActivation) {
      const partialText = stripContextTags(accumulatedText).trim();
      if (partialText) {
        const partialContextId = this._allocateContextId();
        this._appendEntry(createAssistantText(
          this._nextLogId("assistant_text"),
          this._turnCount,
          this._computeNextRoundIndex(),
          partialText,
          partialText,
          partialContextId,
        ), false);
      }
    }

    // Generate contextual tool_results for closed tool_calls without results.
    this._completeMissingToolResultsFromLog(logLenBefore);

    // Collect names of partial (unclosed) tool_calls —visible in TUI but
    // invisible in API context (apiRole=null). Agent needs to know about them.
    const partialToolNames: string[] = [];
    for (let i = logLenBefore; i < this._log.length; i++) {
      const e = this._log[i];
      if (e.type === "tool_call" && e.apiRole === null && !e.discarded) {
        const name = (e.meta as Record<string, unknown>)["toolName"];
        if (typeof name === "string") partialToolNames.push(name);
      }
    }

    // Build the interruption system-message (user role).
    this._recordSessionEvent("interrupted by user");
    const compactWasInterrupted = this._compactInProgress;
    this._appendInterruptionSystemMessage(partialToolNames, compactWasInterrupted);
  }

  /**
   * Scan the current turn's log entries to collect human-readable interrupt hints.
   * Called after _handleInterruption, before writing turn_end.
   */
  private _collectInterruptHints(): string[] {
    const hints: string[] = [];
    const turnIdx = this._turnCount;
    let hasDiscardedReasoning = false;
    let hasPartialEffects = false;
    let hasIncompleteArgs = false;

    for (const e of this._log) {
      if (e.turnIndex !== turnIdx) continue;
      if (e.type === "reasoning" && e.discarded) {
        hasDiscardedReasoning = true;
      }
      if (e.type === "tool_call" && e.apiRole === null && !e.discarded) {
        hasIncompleteArgs = true;
      }
      if (e.type === "tool_result") {
        const interrupt = (e.meta as Record<string, unknown>)["interrupt"] as Record<string, unknown> | undefined;
        if (interrupt?.["partialEffectsPossible"] === true) {
          hasPartialEffects = true;
        }
        if (interrupt?.["incompleteArguments"] === true) {
          hasIncompleteArgs = true;
        }
      }
      // Legacy string matching for log entries created before structured interrupt metadata.
      if (e.type === "tool_result" && typeof e.display === "string") {
        if (e.display.includes("may have had partial effects")) {
          hasPartialEffects = true;
        }
        if (e.display.includes("Incomplete arguments")) {
          hasIncompleteArgs = true;
        }
      }
    }

    if (hasDiscardedReasoning) {
      hints.push("Thinking was discarded and not transmitted to the model.");
    }
    if (hasPartialEffects) {
      hints.push("Some tools may have had partial effects.");
    }
    if (hasIncompleteArgs) {
      hints.push("Some tools had incomplete arguments and were not executed.");
    }
    return hints;
  }

  private _completeMissingToolResultsFromLog(fromIdx: number): void {
    completeMissingToolResultsInLog(this._logSurgeryView(), fromIdx);
  }

  private _getLastSendableRole(): string | null {
    const messages = projectToApiMessages(this._log, {
      systemPrompt: this._getSystemPrompt(),
      resolveImageRef: (refPath) => this._resolveImageRef(refPath),
      requiresAlternatingRoles: (this.primaryAgent as any)._provider?.requiresAlternatingRoles,
    });
    if (messages.length === 0) return null;
    const role = messages[messages.length - 1]["role"];
    return typeof role === "string" ? role : null;
  }

  private _isUserSideProtocolRole(role: string | null): boolean {
    if (!role) return true;
    if (role === "assistant") return false;
    return true;
  }

  // ==================================================================
  // Activation
  // ==================================================================

  private async _runActivation(
    activationTurnIndex: number,
    signal?: AbortSignal,
    textAccumulator?: { text: string },
    reasoningAccumulator?: { text: string },
    suppressStreaming?: boolean,
  ): Promise<ToolLoopResult> {
    const baseRoundIndex = this._computeNextRoundIndex(activationTurnIndex);
    const streamedAssistantEntries = new Map<number, LogEntry>();
    const streamedReasoningEntries = new Map<number, LogEntry>();
    const textBuffers = new Map<number, NoReplyStreamBuffer>();
    const roundContextIds = new Map<number, string>();
    const getRoundContextId = (roundIndex: number): string => {
      let contextId = roundContextIds.get(roundIndex);
      if (!contextId) {
        contextId = this._allocateContextId();
        roundContextIds.set(roundIndex, contextId);
      }
      return contextId;
    };

    let onTextChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;
    let onReasoningChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;

    if (suppressStreaming) {
      // During compact phase: accumulate text but don't stream to TUI
      if (textAccumulator) {
        const stripBuf = new ContextTagStripBuffer((chunk: string) => {
          textAccumulator.text += chunk;
        });
        const buf = new NoReplyStreamBuffer((chunk: string) => stripBuf.feed(chunk));
        onTextChunk = (_roundIndex: number, chunk: string) => {
          buf.feed(chunk);
          return false;
        };
      }
      if (reasoningAccumulator) {
        onReasoningChunk = (_roundIndex: number, chunk: string) => {
          reasoningAccumulator.text += chunk;
          return false;
        };
      }
    } else {
      const agentName = this.primaryAgent.name;
      const progress = this._progress;

      // Track the last chunk kind per round so that when the provider
      // interleaves reasoning and text items (e.g. Responses API),
      // each contiguous segment gets its own LogEntry instead of being
      // merged into a single sticky entry at the first-chunk position.
      let lastStreamKind: "reasoning" | "text" | null = null;
      let lastStreamRound = -1;

      onTextChunk = (roundIndex: number, chunk: string) => {
        // If switching from reasoning →text in same round, start fresh buffers + entry
        if (lastStreamRound === roundIndex && lastStreamKind === "reasoning") {
          streamedAssistantEntries.delete(roundIndex);
          textBuffers.delete(roundIndex);
        }
        lastStreamKind = "text";
        lastStreamRound = roundIndex;

        let roundBuffer = textBuffers.get(roundIndex);
        if (!roundBuffer) {
          const stripBuf = new ContextTagStripBuffer((cleanChunk: string) => {
            if (textAccumulator) textAccumulator.text += cleanChunk;
            if (progress) progress.onTextChunk(agentName, cleanChunk);
            this._setSelfPhase("generating");

            const entry = streamedAssistantEntries.get(roundIndex);
            if (!entry) {
              const nextEntry = createAssistantText(
                this._nextLogId("assistant_text"),
                activationTurnIndex,
                roundIndex,
                cleanChunk,
                cleanChunk,
                getRoundContextId(roundIndex),
              );
              this._appendEntry(nextEntry, false);
              streamedAssistantEntries.set(roundIndex, nextEntry);
              this._setActiveLogEntry(nextEntry.id);
            } else {
              entry.display += cleanChunk;
              entry.content = String(entry.content ?? "") + cleanChunk;
              if (this._activeLogEntryId !== entry.id) {
                this._setActiveLogEntry(entry.id);
              } else {
                this._touchLog();
              }
            }
          });
          roundBuffer = new NoReplyStreamBuffer((cleanChunk: string) => stripBuf.feed(cleanChunk));
          textBuffers.set(roundIndex, roundBuffer);
        }
        roundBuffer.feed(chunk);
        // Check if the streaming callback actually created/updated a log entry
        return streamedAssistantEntries.has(roundIndex);
      };

      onReasoningChunk = (roundIndex: number, chunk: string) => {
        if (reasoningAccumulator) reasoningAccumulator.text += chunk;
        if (progress) progress.onReasoningChunk(agentName, chunk);
        this._setSelfPhase("thinking");

        // If switching from text →reasoning in same round, start a new reasoning entry
        if (lastStreamRound === roundIndex && lastStreamKind === "text") {
          streamedReasoningEntries.delete(roundIndex);
        }
        lastStreamKind = "reasoning";
        lastStreamRound = roundIndex;

        const entry = streamedReasoningEntries.get(roundIndex);
        if (!entry) {
          const nextEntry = createReasoning(
            this._nextLogId("reasoning"),
            activationTurnIndex,
            roundIndex,
            chunk,
            chunk,
            undefined,
            getRoundContextId(roundIndex),
          );
          this._appendEntry(nextEntry, false);
          streamedReasoningEntries.set(roundIndex, nextEntry);
          this._setActiveLogEntry(nextEntry.id);
        } else {
          entry.display += chunk;
          entry.content = String(entry.content ?? "") + chunk;
          // Keep active tracker pointing to this reasoning entry
          if (this._activeLogEntryId !== entry.id) {
            this._setActiveLogEntry(entry.id);
          } else {
            this._touchLog();
          }
        }
        return true;
      };
    }

    // Mark reasoning entry as complete when the provider finishes streaming reasoning
    const onReasoningDone = (
      roundIndex: number,
      thinkingArtifact?: import("./lib/thinking-artifact.js").ThinkingArtifact | null,
      reasoningState?: unknown,
    ) => {
      const entry = streamedReasoningEntries.get(roundIndex);
      if (entry) {
        (entry.meta as Record<string, unknown>).reasoningComplete = true;
        if (reasoningState !== undefined) {
          (entry.meta as Record<string, unknown>).reasoningState = reasoningState;
        }
        if (thinkingArtifact) {
          (entry.meta as Record<string, unknown>).thinkingArtifact = thinkingArtifact;
        }
        if (this._activeLogEntryId === entry.id) {
          this._activeLogEntryId = null;
        }
        this._touchLog();
      }
    };

    let onToolCall: ((name: string, tool: string, args: Record<string, unknown>, summary: string) => void) | undefined;
    if (this._progress) {
      const step = this._turnCount;
      const progress = this._progress;

      onToolCall = (name: string, tool: string, args: Record<string, unknown>, summary: string) => {
        progress.onToolCall(step, name, tool, args, summary);
      };
    }
    const origOnToolCall = onToolCall;
    onToolCall = (name: string, tool: string, args: Record<string, unknown>, summary: string) => {
      origOnToolCall?.(name, tool, args, summary);
      this._setSelfPhase("tool_calling");
      this._lifetimeToolCallCount += 1;
      this._lastToolCallSummary = summary;
      this._recordSessionEvent(summary);
    };

    const onToolResult = (name: string, tool: string, toolCallId: string, isError: boolean, summary: string) => {
      // Flush deferred summary entries now that tool_result is in the log
      if (this._pendingSummaryEntries.length > 0) {
        const pending = this._pendingSummaryEntries.splice(0);
        for (const entry of pending) {
          this._appendEntry(entry, false);
          if (entry.type === "summary") {
            this._archiveSummaryCoveredEntries(entry);
          }
        }
      }
      if (this._progress) {
        this._progress.onToolResult(this._turnCount, name, tool, toolCallId, isError, summary);
      }
      // Fire PostToolUse / PostToolUseFailure hooks
      if (this.hookRuntime.hooks.length > 0) {
        const event = isError ? "PostToolUseFailure" : "PostToolUse";
        this.hookRuntime.fireAndForget(event, {
          event,
          timestamp: Date.now(),
          toolName: tool,
          toolCallId,
          agentId: name,
        });
      }
    };

    // Streaming tool call callbacks —set active entry for early display
    const onToolCallPartialCb = (_callId: string, _name: string, _rawArguments: string) => {
      // Active entry tracking happens in tool-loop via appendEntry →_appendEntry;
      // we find the just-appended pending tool_call entry and mark it active
      const lastEntry = this._log[this._log.length - 1];
      if (lastEntry && lastEntry.type === "tool_call") {
        this._setActiveLogEntry(lastEntry.id);
      }
    };

    // Token update callback: update _lastInputTokens after each provider call
    // so the TUI can display real-time context usage.
    const onTokenUpdate = (inputTokens: number, usage?: import("./providers/base.js").Usage) => {
      if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;
      this._lastInputTokens = inputTokens;
      this._lastTotalTokens = usage?.totalTokens ?? inputTokens;
      this._lastCacheReadTokens = usage?.cacheReadTokens ?? 0;
      // Cumulative stats are derived from the token_update entry appended below
      // (see _computeUsageStats), so there is nothing to accumulate here.
      this._appendEntry(
        createTokenUpdate(
          this._nextLogId("token_update"),
          activationTurnIndex,
          inputTokens,
          usage?.cacheReadTokens,
          usage?.cacheCreationTokens,
          usage?.totalTokens,
        ),
        false,
      );
      if (this._progress) {
        const extra: Record<string, unknown> = { input_tokens: inputTokens };
        if (usage) {
          extra["total_tokens"] = usage.totalTokens;
          if (usage.cacheReadTokens > 0) extra["cache_read_tokens"] = usage.cacheReadTokens;
          if (usage.cacheCreationTokens > 0) extra["cache_creation_tokens"] = usage.cacheCreationTokens;
        }
        this._progress.emit({
          step: this._turnCount,
          agent: this.primaryAgent.name,
          action: "token_update",
          message: "",
          level: "quiet" as ProgressLevel,
          timestamp: Date.now() / 1000,
          usage: { input_tokens: inputTokens },
          extra,
        });
      }
    };

    const agentName = this.primaryAgent.name;
    const emitRetryAttempt = (attempt: number, max: number, delaySec: number, errMsg: string) => {
      if (!this._compactInProgress) {
        this._appendEntry(
          createStatus(
            this._nextLogId("status"),
            activationTurnIndex,
            `[Network retry ${attempt}/${max}] waiting ${delaySec}s: ${errMsg}`,
            "retry_attempt",
          ),
          false,
        );
      }
      this._progress?.onRetryAttempt(agentName, attempt, max, delaySec, errMsg);
    };
    const emitRetrySuccess = (attempt: number) => {
      if (!this._compactInProgress) {
        this._appendEntry(
          createStatus(
            this._nextLogId("status"),
            activationTurnIndex,
            `[Network retry succeeded] attempt ${attempt}`,
            "retry_success",
          ),
          false,
        );
      }
      this._progress?.onRetrySuccess(agentName, attempt);
    };
    const emitRetryExhausted = (max: number, errMsg: string) => {
      if (!this._compactInProgress) {
        this._appendEntry(
          createErrorEntry(
            this._nextLogId("error"),
            activationTurnIndex,
            `[Network retry exhausted after ${max} attempts] ${errMsg}`,
            "retry_exhausted",
          ),
          false,
        );
      }
      this._progress?.onRetryExhausted(agentName, max, errMsg);
    };

    // v2: callback-based message management
    // getMessages projects from _log via projectToApiMessages.
    const getMessages = (): Array<Record<string, unknown>> => {
      return projectToApiMessages(this._log, {
        systemPrompt: this._getSystemPrompt(),
        resolveImageRef: (refPath) => this._resolveImageRef(refPath),
        requiresAlternatingRoles: (this.primaryAgent as any)._provider?.requiresAlternatingRoles,
        enforceToolCallProtocol: true,
      });
    };

    const appendEntry = (entry: LogEntry): void => {
      if (this._compactInProgress) {
        entry.tuiVisible = false;
        entry.displayKind = null;
        (entry.meta as Record<string, unknown>)["compactPhase"] = true;
      }
      this._appendEntry(entry, false);
      if (
        entry.type === "tool_call"
        && entry.tuiVisible
        && !this._compactInProgress
        && entry.meta["toolExecState"] !== "completed"
        && entry.meta["toolExecState"] !== "failed"
        && (entry.meta["toolExecState"] === "running"
          || entry.meta["toolExecState"] === "not_started"
          || entry.meta["toolStreamState"] === "partial"
          || entry.meta["toolStreamState"] === "closed")
      ) {
        this._setActiveLogEntry(entry.id);
      }
    };

    const allocId = (type: LogEntry["type"]): string => {
      return this._nextLogId(type);
    };

    /** Update an existing log entry in-place (for finalizing pending tool call entries). */
    const updateEntryFn = (entryId: string, patch: {
      apiRole?: LogEntry["apiRole"];
      content?: unknown;
      display?: string;
      tuiVisible?: boolean;
      displayKind?: LogEntry["displayKind"];
      meta?: Record<string, unknown>;
    }): void => {
      // Contract: the elapsed-pairing memo in log-projection folds each
      // entry once —timestamp, meta.toolCallId and meta.execStartMs are
      // fixed at append time and must not be patched here.
      const entry = this._logStore.findEntryById(entryId);
      if (!entry) return;
      if (patch.apiRole !== undefined) entry.apiRole = patch.apiRole;
      if (patch.content !== undefined) entry.content = patch.content;
      if (patch.display !== undefined) entry.display = patch.display;
      if (patch.tuiVisible !== undefined) entry.tuiVisible = patch.tuiVisible;
      if (patch.displayKind !== undefined) entry.displayKind = patch.displayKind;
      if (patch.meta !== undefined) entry.meta = patch.meta;
      if (entry.type === "tool_call" && !entry.tuiVisible) {
        if (this._activeLogEntryId === entry.id) {
          this._setActiveLogEntry(null);
        } else {
          this._touchLog();
        }
        return;
      }
      if (entry.type === "tool_call" && patch.meta) {
        const execState = patch.meta["toolExecState"];
        const streamState = patch.meta["toolStreamState"];
        // Check completion first —exec finished takes priority over stream state
        if (execState === "completed" || execState === "failed") {
          if (this._activeLogEntryId === entry.id) {
            this._setActiveLogEntry(null);
          } else {
            this._touchLog();
          }
          return;
        }
        if (
          execState === "running"
          || execState === "not_started"
          || streamState === "partial"
          || streamState === "closed"
        ) {
          if (this._activeLogEntryId !== entry.id) {
            this._setActiveLogEntry(entry.id);
          } else {
            this._touchLog();
          }
          return;
        }
      }
      this._touchLog();
    };

    /** Mark a log entry as discarded (for cleanup on retry). */
    const discardEntryFn = (entryId: string): void => {
      const entry = this._logStore.findEntryById(entryId);
      if (!entry) return;
      entry.discarded = true;
      entry.tuiVisible = false;
      this._touchLog();
    };

    return this.primaryAgent.asyncRunWithMessages({
      getMessages,
      appendEntry,
      allocId,
      turnIndex: activationTurnIndex,
      baseRoundIndex,
      toolExecutors: this._toolExecutors,
      onToolCall,
      onToolResult,
      onTextChunk,
      onReasoningChunk,
      onReasoningDone,
      signal,
      contextIdAllocator: (roundIndex) => getRoundContextId(roundIndex),
      toolContextIdAllocator: () => this._allocateContextId(),
      compactCheck: this._buildCompactCheck(),
      onTokenUpdate,
      thinkingLevel: this._thinkingLevel === "none" ? undefined : this._thinkingLevel,
      promptCacheKey: this._promptCacheKey,
      onSaveCheckpoint: this._compactInProgress ? undefined : (() => this.onSaveRequest?.()),
      beforeToolExecute: this._beforeToolExecute,
      getNotification: () => null,
      // Round-boundary inbox drain. Suppressed during compact: anything
      // drained mid-compact would land before the upcoming compact_marker
      // and be hidden from the model afterwards (Q6).
      onToolRoundComplete: () => {
        if (!this._compactInProgress) this._drainInboxAsEntries();
      },
      streamCallbacksOwnEntries: !suppressStreaming,
      onRetryAttempt: emitRetryAttempt,
      onRetrySuccess: emitRetrySuccess,
      onRetryExhausted: emitRetryExhausted,
      onToolCallPartial: onToolCallPartialCb,
      resolveToolCallVisibility: this._resolveToolCallVisibility,
      isPlanFilePath: (filePath) => this._isPlanFilePath(filePath),
      updateEntry: updateEntryFn,
      discardEntry: discardEntryFn,
    });
  }

  // ==================================================================
  // Tool argument helpers
  // ==================================================================

  // Arg-validation helpers —delegates to standalone functions in tools/arg-helpers.ts
  private _toolArgError(toolName: string, message: string): ToolResult {
    return toolArgError(toolName, message);
  }
  private _argOptionalString(toolName: string, args: Record<string, unknown>, key: string): string | undefined | ToolResult {
    return argOptionalString(toolName, args, key);
  }
  private _argRequiredString(toolName: string, args: Record<string, unknown>, key: string, opts?: { nonEmpty?: boolean }): string | ToolResult {
    return argRequiredString(toolName, args, key, opts);
  }
  private _argRequiredStringArray(toolName: string, args: Record<string, unknown>, key: string): string[] | ToolResult {
    return argRequiredStringArray(toolName, args, key);
  }

  // ==================================================================
  // Ask tool
  // ==================================================================

  private _execAsk(args: Record<string, unknown>): ToolResult {
    // Validate args
    const questions = args["questions"];
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) {
      return new ToolResult({
        content: "Error: 'questions' must be an array of 1-4 items.",
      });
    }
    const parsedQuestions: AgentQuestionItem[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i] as Record<string, unknown>;
      if (!q || typeof q["question"] !== "string") {
        return new ToolResult({
          content: `Error: questions[${i}].question must be a string.`,
        });
      }
      const opts = q["options"];
      if (!Array.isArray(opts) || opts.length === 0 || opts.length > 4) {
        return new ToolResult({
          content: `Error: questions[${i}].options must be an array of 1-4 items.`,
        });
      }
      const parsedOpts = [];
      for (let j = 0; j < opts.length; j++) {
        const o = opts[j] as Record<string, unknown>;
        if (!o || typeof o["label"] !== "string") {
          return new ToolResult({
            content: `Error: questions[${i}].options[${j}].label must be a string.`,
          });
        }
        parsedOpts.push({
          label: o["label"] as string,
          description: typeof o["description"] === "string" ? (o["description"] as string) : undefined,
          kind: "normal" as const,
        });
      }
      parsedOpts.push({
        label: ASK_CUSTOM_OPTION_LABEL,
        kind: "custom_input" as const,
        systemAdded: true,
      });
      parsedOpts.push({
        label: ASK_DISCUSS_OPTION_LABEL,
        kind: "discuss_further" as const,
        systemAdded: true,
      });
      parsedQuestions.push({
        question: q["question"] as string,
        options: parsedOpts,
      });
    }

    const ask: AgentQuestion = {
      id: randomUUID(),
      kind: "agent_question",
      createdAt: new Date().toISOString(),
      source: {
        agentId: this.primaryAgent.name,
        agentName: this.primaryAgent.name,
        toolName: "ask",
      },
      roundIndex: undefined,
      summary: `Agent asking: ${parsedQuestions[0].question}${parsedQuestions.length > 1 ? ` (+${parsedQuestions.length - 1} more)` : ""}`,
      payload: { questions: parsedQuestions, toolCallId: "" },
      options: [], // per-question options are in payload
    };
    throw new AskPendingError(ask);
  }

  private _buildAgentQuestionToolResult(
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

  private _buildAgentQuestionPreview(
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
    this._withAskRouting(
      askId,
      () => this._resolveOwnAgentQuestionAsk(askId, decision),
      (child) => child.session?.resolveAgentQuestionAsk(askId, decision),
    );
  }

  private _resolveOwnAgentQuestionAsk(askId: string, decision: AgentQuestionDecision): void {
    const ask = this._activeAsk!;
    if (ask.kind !== "agent_question") {
      throw new Error(`Ask kind mismatch (active=${ask.kind}, expected=agent_question).`);
    }

    const toolCallId = ask.payload.toolCallId || "ask";
    const anchor = this._toolCallAnchor(toolCallId, ask);

    // Create ask_resolution entry in log
    this._appendEntry(createAskResolution(
      this._nextLogId("ask_resolution"),
      anchor.turnIndex,
      { answers: decision.answers },
      askId,
      "agent_question",
    ), false);

    const toolResult = this._buildAgentQuestionToolResult(
      ask.payload.questions,
      decision,
    );
    const previewText = this._buildAgentQuestionPreview(
      ask.payload.questions,
      decision,
    );
    const toolResultContextId =
      this._findToolCallContextId(toolCallId, ask.roundIndex)
        ?? this._allocateContextId();
    this._appendEntry(createToolResultEntry(
      this._nextLogId("tool_result"),
      anchor.turnIndex,
      anchor.roundIndex,
      {
        toolCallId,
        toolName: "ask",
        content: toolResult.content,
        toolSummary: "ask resolved",
      },
      {
        isError: false,
        contextId: toolResultContextId,
        previewText,
      },
    ), false);

    this._askHistory.push({
      askId: ask.id,
      kind: ask.kind,
      summary: ask.summary,
      decidedAt: new Date().toISOString(),
      decision: "answered",
      source: ask.source,
    });
    if (this._askHistory.length > 100) {
      this._askHistory = this._askHistory.slice(-100);
    }

    this._activeAsk = null;
    this._emitAskResolvedProgress(askId, "answered", "agent_question");
    this._pendingTurnState = { stage: "activation" };

    this.onSaveRequest?.();
  }

  /**
   * Resolve a permission approval ask.
   * @param askId  The ask ID to resolve.
   * @param choiceIndex  Index into the ask's options array. Last option is always "Deny".
   */
  resolveApprovalAsk(askId: string, choiceIndex: number): void {
    this._withAskRouting(
      askId,
      () => this._resolveOwnApprovalAsk(askId, choiceIndex),
      (child) => child.session?.resolveApprovalAsk(askId, choiceIndex),
    );
  }

  private _resolveOwnApprovalAsk(askId: string, choiceIndex: number): void {
    const ask = this._activeAsk!;
    if (ask.kind !== "approval") throw new Error(`Ask kind mismatch (active=${ask.kind}, expected=approval).`);

    const payload = ask.payload as ApprovalRequest["payload"];
    const choiceLabel = ask.options[choiceIndex] ?? "Deny";
    const isDeny = choiceLabel === "Deny";
    const offer = !isDeny ? payload.offers[choiceIndex] : null;

    const anchor = this._toolCallAnchor(payload.toolCallId, ask);

    // Log the resolution
    this._appendEntry(createAskResolution(
      this._nextLogId("ask_resolution"),
      anchor.turnIndex,
      { choice: choiceLabel, toolName: payload.toolName },
      askId,
      "approval",
    ), false);

    if (isDeny) {
      // Inject a deny tool_result so the model knows
      const toolCallId = payload.toolCallId;
      const contextId = this._findToolCallContextId(toolCallId, ask.roundIndex)
        ?? this._allocateContextId();
      this._appendEntry(createToolResultEntry(
        this._nextLogId("tool_result"),
        anchor.turnIndex,
        anchor.roundIndex,
        {
          toolCallId,
          toolName: payload.toolName,
          content: `ERROR: Tool execution denied by user.`,
          toolSummary: `${payload.toolName} denied`,
        },
        { isError: true, contextId },
      ), false);
    } else {
      // Apply the offer. The approved tool_call's grant is consumed in
      // _drainPendingToolCalls during resume.
      if (offer?.type === "tool_once") {
        this._permissionAdvisor.grantAllowOnce(payload.toolCallId);
      } else if (offer?.type === "mode_upgrade") {
        this.permissionMode = "reversible";
        this._permissionAdvisor.grantAllowOnce(payload.toolCallId);
      } else if ((offer?.type === "tool_pattern" || offer?.type === "external_path") && offer.rule) {
        this._permissionAdvisor.acceptOffer({
          type: offer.type as ApprovalOffer["type"],
          label: offer.label,
          scope: offer.scope as ApprovalOffer["scope"],
          rule: offer.rule as unknown as PermissionRule,
        });
        this._permissionAdvisor.grantAllowOnce(payload.toolCallId);
      }
    }

    this._askHistory.push({
      askId: ask.id,
      kind: "approval",
      summary: ask.summary,
      decidedAt: new Date().toISOString(),
      decision: choiceLabel,
      source: ask.source,
    });

    this._activeAsk = null;
    this._emitAskResolvedProgress(askId, choiceLabel, "approval");
    this._pendingTurnState = { stage: "activation" };

    this.onSaveRequest?.();
  }

  private _findChildWithPendingAsk(askId: string): ChildSessionHandle | null {
    return this._childSessionManagerInstance.findChildWithPendingAsk(askId);
  }

  private _resumeChildPendingTurn(handle: ChildSessionHandle): void {
    this._childSessionManagerInstance.resumeChildPendingTurn(handle);
  }

  private _finishChildTurn(handle: ChildSessionHandle, error?: unknown): void {
    this._childSessionManagerInstance.finishChildTurn(handle, error);
  }

  /**
   * Route an ask operation to the correct session (self or child).
   * If the ask belongs to this session, runs onSelf. If it belongs to a
   * child, runs onChild then resumes the child's pending turn.
   */
  private _withAskRouting<T>(
    askId: string,
    onSelf: () => T,
    onChild: (child: ChildSessionHandle) => T,
  ): T {
    if (this._activeAsk?.id === askId) return onSelf();
    const child = this._findChildWithPendingAsk(askId);
    if (!child) throw new Error("No active ask to resolve.");
    const result = onChild(child);
    this._resumeChildPendingTurn(child);
    this._notifyLogListeners();
    this.onSaveRequest?.();
    return result;
  }

  private _execShowContext(_args: Record<string, unknown>): ToolResult {
    const { budget } = this._contextBudgetInfo();

    const contextMap = generateShowContext(this._log, this._lastInputTokens, budget);
    return new ToolResult({ content: contextMap });
  }

  private _execSummarizeContextTool(args: Record<string, unknown>): ToolResult {
    const result = execSummarizeContextOnLog(
      args,
      this._log,
      () => this._allocateContextId(),
      () => this._nextLogId("summary"),
      this._turnCount,
      this._manualSummarizeExactRange
        ? { origin: "manual", exactRange: this._manualSummarizeExactRange }
        : { origin: "agent" },
    );

    // Defer summary entries —they must appear AFTER the tool_result to avoid
    // breaking the tool_call →tool_result pairing in API projections.
    this._pendingSummaryEntries.push(...result.newEntries);

    this._annotateLatestSummarizeContextToolCall(result.results);

    this._touchLog();

    return new ToolResult({ content: result.output });
  }

  private _annotateLatestSummarizeContextToolCall(results: Array<{ success: boolean; newContextId?: string }>): void {
    const resolvedToolCallIds = new Set<string>();
    let summarizeContextEntry: LogEntry | null = null;

    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.discarded) continue;
      if (entry.type === "tool_result") {
        const toolCallId = (entry.meta as Record<string, unknown>)["toolCallId"];
        if (toolCallId) resolvedToolCallIds.add(String(toolCallId));
        continue;
      }
      if (entry.type !== "tool_call") continue;
      const toolCallId = String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "");
      if (resolvedToolCallIds.has(toolCallId)) continue;
      if ((entry.meta as Record<string, unknown>)["toolName"] !== "summarize_context") continue;
      summarizeContextEntry = entry;
      break;
    }

    if (!summarizeContextEntry) return;
    const content = summarizeContextEntry.content as Record<string, unknown>;
    const args = (content["arguments"] as Record<string, unknown>) ?? {};
    const operations = ((args["operations"] as Array<Record<string, unknown>>) ?? []).map((op) => ({ ...op }));

    for (let i = 0; i < operations.length && i < results.length; i++) {
      if (!results[i].success || !results[i].newContextId) continue;
      operations[i]["_result_context_id"] = results[i].newContextId;
    }

    summarizeContextEntry.content = {
      ...content,
      arguments: {
        ...args,
        operations,
      },
    };
  }

  // ==================================================================
  // AGENTS.md persistent memory
  // ==================================================================

  /** Check if a file path refers to the plan file (SESSION_ARTIFACTS/plan.md). */
  private _isPlanFilePath(filePath: string): boolean {
    const planPath = this._getPlanFilePath();
    if (!planPath) return false;
    return resolve(filePath) === resolve(planPath);
  }

  /**
   * Hook to override a tool call's TUI visibility. Returning "hide" suppresses
   * the call entirely —the runtime "hide" machinery is retained for future use,
   * but nothing uses it right now.
   *
   * Plan-file writes/edits are intentionally NOT hidden: they stay visible and
   * the presentation layer relabels them as an "Update Todos" step (clean on
   * success, with the error reason on failure). They are detected by exact path
   * via `isPlanFilePath` (see the asyncRunWithMessages wiring), not by filename.
   */
  private _resolveToolCallVisibility: ResolveToolCallVisibilityCallback = () => {
    return undefined;
  };


  private _getArtifactsDirIfAvailable(): string | undefined {
    if (!this._store) return undefined;
    const d = this._store.artifactsDir;
    if (d) return d;
    return undefined;
  }

  private _getPredictedArtifactsDirIfAvailable(): string | undefined {
    if (!this._store || typeof this._store.predictNextArtifactsDir !== "function") return undefined;
    try {
      return this._store.predictNextArtifactsDir();
    } catch {
      return undefined;
    }
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

  private _ensureSessionStorageReady(): void {
    if (this._sessionArtifactsOverride) {
      this._refreshSystemPromptPaths();
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
    this._refreshSystemPromptPaths();
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

  private _resolveSessionArtifacts(options?: { allowUnresolved?: boolean }): string {
    if (this._sessionArtifactsOverride) return this._sessionArtifactsOverride;
    const d = this._getArtifactsDirIfAvailable();
    if (d) return d;
    if (options?.allowUnresolved) return "{SESSION_ARTIFACTS}";
    return this._getArtifactsDir();
  }

  private _resolveSystemData(options?: { allowUnresolved?: boolean }): string {
    if (this._systemData) return this._systemData;
    if (this._store?.projectDir) return this._store.projectDir;
    if (options?.allowUnresolved) return "{SYSTEM_DATA}";
    const artifacts = this._getArtifactsDir();
    return join(artifacts, "..");
  }

  /**
   * Assemble the full system prompt using the layered assembler.
   * Called by _reloadPromptAndTools(), not per-call.
   */
  private _describeInitialModel(): string {
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
      sessionArtifacts: this._getPredictedArtifactsDirIfAvailable()
        ?? this._resolveSessionArtifacts({ allowUnresolved: true }),
      systemData: this._resolveSystemData({ allowUnresolved: true }),
      sessionStartedAt: this._createdAt,
      initialModel: this._initialModel,
      agentModels: this.config.agentModels,
      shellNotes: buildShellNotes(shell.kind),
    });
  }

  /**
   * Get the cached system prompt. Computed once and reused across API calls
   * for prompt cache stability. Refreshed only by _reloadPromptAndTools().
   */
  private _getSystemPrompt(): string {
    if (!this._cachedSystemPrompt) {
      this._cachedSystemPrompt = this._assembleSystemPrompt();
    }
    // Append hook additional context (dynamic, not cached)
    const hookCtx = this.hookRuntime.getAdditionalContext();
    if (hookCtx) {
      return this._cachedSystemPrompt + "\n\n" + hookCtx;
    }
    return this._cachedSystemPrompt;
  }

  /**
   * Reload system prompt, skills, and tool definitions.
   * Called at session init, on `/reload`, and after AGENTS.md writes.
   * Invalidates the prompt cache so the next API call gets a fresh prompt.
   */
  _reloadPromptAndTools(): void {
    this._refreshSkills();
    this._cachedSystemPrompt = this._assembleSystemPrompt();
    this._promptSectionEstimates = null;
  }

  /**
   * Update the system message in the conversation with re-rendered paths.
   * Called by setStore() to fix paths after the store is linked.
   */
  private _refreshSystemPromptPaths(): void {
    this._reloadPromptAndTools();
  }

  // ==================================================================
  // Auto-compact
  // ==================================================================

  private _buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
    return this._contextManager.buildCompactCheck();
  }

  /**
   * Run the compact phase: inject compact prompt, let the Agent produce
   * a continuation prompt (possibly using tools), then return it.
   */
  private async _runCompactPhase(
    scenario: "before_turn" | "mid_turn",
    promptOverride?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this._compactInProgress = true;

    // Emit compact_start event
    if (this._progress) {
      this._progress.onCompactStart(this.primaryAgent.name, scenario);
    }

    // Inject compact prompt as user_message entry (compactPhase, invisible in TUI)
    const prompt = promptOverride ?? (scenario === "before_turn" ? COMPACT_PROMPT_OUTPUT : COMPACT_PROMPT_TOOLCALL);
    const compactPromptEntry = createUserMessageEntry(
      this._nextLogId("user_message"),
      this._turnCount,
      "",  // not visible in TUI
      prompt,
      this._allocateContextId(),
    );
    compactPromptEntry.tuiVisible = false;
    (compactPromptEntry.meta as Record<string, unknown>)["compactPhase"] = true;
    this._appendEntry(compactPromptEntry, false);

    let continuationPrompt = "";
    try {
      for (let i = 0; i < MAX_COMPACT_PHASE_ROUNDS; i++) {
        if (signal?.aborted) {
          throw new DOMException("Compact phase aborted.", "AbortError");
        }

        // Same per-activation turn-index invariant as _runTurnActivationLoop:
        // capture once so the tool-loop entries and the finalized reasoning/
        // text below can't be split across turnIndices if a queued message
        // drains mid-activation. See _runActivation / Docs/session.md.
        const compactTurnIndex = this._turnCount;
        const result = await this._runActivation(compactTurnIndex, signal, undefined, undefined, true);
        if (signal?.aborted) {
          throw new DOMException("Compact phase aborted.", "AbortError");
        }

        if (result.text) {
          const compactRound = this._computeNextRoundIndex(compactTurnIndex);
          const compactContextId = this._allocateContextId();
          if (result.reasoningContent) {
            const compactReasoningEntry = createReasoning(
              this._nextLogId("reasoning"),
              compactTurnIndex,
              compactRound,
              "",
              result.reasoningContent,
              result.reasoningState,
              compactContextId,
              result.thinkingArtifact ?? null,
            );
            compactReasoningEntry.tuiVisible = false;
            compactReasoningEntry.displayKind = null;
            (compactReasoningEntry.meta as Record<string, unknown>)["compactPhase"] = true;
            this._appendEntry(compactReasoningEntry, false);
          }
          const compactReplyEntry = createAssistantText(
            this._nextLogId("assistant_text"),
            compactTurnIndex,
            compactRound,
            "",
            result.text,
            compactContextId,
          );
          compactReplyEntry.tuiVisible = false;
          (compactReplyEntry.meta as Record<string, unknown>)["compactPhase"] = true;
          this._appendEntry(compactReplyEntry, false);
          continuationPrompt = result.text;
          break;
        }
      }
      if (!continuationPrompt) {
        continuationPrompt = "[Compact phase did not produce a continuation prompt.]";
      }
    } finally {
      this._compactInProgress = false;
    }

    return continuationPrompt;
  }

  /**
   * Execute auto-compact: run compact phase, then reconstruct conversation
   * with marker + system prompt + continuation prompt.
   */
  private async _doAutoCompact(
    scenario: "before_turn" | "mid_turn",
    signal?: AbortSignal,
    promptOverride?: string,
  ): Promise<void> {
    const originalTokens = this._lastTotalTokens;

    // Run compact phase
    const continuationPrompt = await this._runCompactPhase(scenario, promptOverride, signal);

    const contCtxId = this._allocateContextId();
    this._compactCount += 1;

    // v2 log: compact_marker + compact_context entries (source of truth)
    this._appendEntry(
      createCompactMarker(
        this._nextLogId("compact_marker"),
        this._turnCount,
        this._compactCount - 1,
        originalTokens,
        0, // compactedTokens not yet known
      ),
      false,
    );
    const currentMarkerIdx = this._log.length - 1;
    // Append plan snapshot to compact context so plan state survives compaction.
    const planSnapshot = formatPlanSnapshot(this._planState);
    const planSuffix = planSnapshot ? `\n\n${planSnapshot}` : "";
    const contContent = `${continuationPrompt}\n\n[Contexts before this point have been compacted.]${planSuffix}`;
    this._appendEntry(
      createCompactContext(
        this._nextLogId("compact_context"),
        this._turnCount,
        contContent,
        contCtxId,
        this._compactCount - 1,
      ),
      false,
    );

    const sessionDir = this._store?.sessionDir as string | undefined;
    if (sessionDir) {
      let previousMarkerIdx = -1;
      for (let i = currentMarkerIdx - 1; i >= 0; i--) {
        if (this._log[i].type === "compact_marker" && !this._log[i].discarded) {
          previousMarkerIdx = i;
          break;
        }
      }
      const archiveStartIdx = previousMarkerIdx >= 0 ? previousMarkerIdx + 1 : 1;
      const archiveEndIdx = currentMarkerIdx - 1;
      if (archiveEndIdx >= archiveStartIdx) {
        archiveWindow(
          sessionDir,
          this._compactCount - 1,
          this._log,
          archiveStartIdx,
          archiveEndIdx,
        );
        // Stripping window content is TUI-projection-visible —same touch
        // contract as _archiveSummaryCoveredEntries.
        this._touchLog();
      }
    }

    // Emit compact_end event
    if (this._progress) {
      this._progress.onCompactEnd(this.primaryAgent.name, scenario, originalTokens);
    }
  }

  /**
   * Check and inject summarize-hint prompts if thresholds are met
   * (see ContextManager.checkAndInjectHint).
   */
  private _checkAndInjectHint(_result: ToolLoopResult): void {
    this._contextManager.checkAndInjectHint();
  }

  /**
   * Update hint state based on actual inputTokens from the latest API call.
   * Implements hysteresis to prevent oscillation.
   * Reset thresholds are auto-derived from trigger thresholds.
   */
  private _updateHintStateAfterApiCall(): void {
    this._contextManager.updateHintStateAfterApiCall();
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

  private _instantiateChildSession(
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

  private async _execSpawn(args: Record<string, unknown>): Promise<ToolResult> {
    const idArg = this._argRequiredString("spawn", args, "id", { nonEmpty: true });
    if (idArg instanceof ToolResult) return idArg;
    const taskArg = this._argRequiredString("spawn", args, "task", { nonEmpty: true });
    if (taskArg instanceof ToolResult) return taskArg;
    const modeArg = this._argRequiredString("spawn", args, "mode", { nonEmpty: true });
    if (modeArg instanceof ToolResult) return modeArg;
    const templateArg = this._argOptionalString("spawn", args, "template");
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
    if (typeof args["model_level"] === "string") spec["model_level"] = args["model_level"];

    return this._execSpawnFromSpecs([spec]);
  }

  private _execSpawnFromSpecs(
    tasksSpec: Array<Record<string, unknown>>,
  ): ToolResult {
    return this._childSessionManagerInstance.spawnFromSpecs(tasksSpec);
  }

  private _execKillAgent(args: Record<string, unknown>): ToolResult {
    const idsArg = this._argRequiredStringArray("kill_agent", args, "ids");
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
  // ------------------------------------------------------------------

  private async _execAwaitEvent(args: Record<string, unknown>): Promise<ToolResult> {
    const secondsRaw = args["seconds"];
    if (typeof secondsRaw !== "number" || isNaN(secondsRaw)) {
      return new ToolResult({ content: "Error: 'seconds' must be a number." });
    }
    const seconds = Math.max(15, secondsRaw);
    const signal = this._currentTurnSignal;

    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Pre-check: if inbox already has messages, return immediately.
    // Inbox content is NOT included in tool_result —the activation boundary
    // drain writes them as individual entries after this tool_result.
    if (this._hasInboxMessages()) {
      const brief = this._buildDetailedChildStatusReport();
      const shell = this._buildShellReport();
      const parts = ["Messages pending.", brief, shell].filter(Boolean);
      return new ToolResult({ content: parts.join("\n\n") });
    }

    // 1s polling loop: check inbox every second until timeout or message.
    this._agentState = "waiting";
    this._setSelfPhase("waiting");
    const startMs = Date.now();
    const deadline = startMs + seconds * 1000;

    while (Date.now() < deadline) {
      if (this._hasInboxMessages()) break;
      if (signal?.aborted) {
        this._agentState = "working";
        this._setSelfPhase("idle");
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const sleepMs = Math.min(1000, deadline - Date.now());
      if (sleepMs <= 0) break;
      await new Promise<void>((r) => setTimeout(r, sleepMs));
    }

    this._agentState = "working";
    this._setSelfPhase("idle");

    // Build tool_result: header + status report only (no inbox content).
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    const hasMessages = this._hasInboxMessages();
    const header = hasMessages
      ? `Waited for ${elapsed}s —new message arrived.`
      : `Waited for ${elapsed}s —no new events.`;
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

  private _hasActiveAgents(): boolean {
    return this._childSessionManagerInstance.hasActiveAgents();
  }

  private _cascadeKillRunningChildren(
    cause: "user_mass_interrupt" | "parent_kill",
  ): number {
    return this._childSessionManagerInstance.cascadeKillRunning(cause);
  }

  private _suspendAllChildSessions(): void {
    this._childSessionManagerInstance.suspendAll();
  }

  private _archiveAllChildSessions(): void {
    this._childSessionManagerInstance.archiveAll();
  }

  private async _waitForAllChildTurnsSettled(): Promise<void> {
    await this._childSessionManagerInstance.waitForAllTurnsSettled();
  }

  private _forceKillAllShells(): void {
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
      getProgress: () => this._progress,
      fireHook: (event, payload) => this.hookRuntime.fireAndForget(event, payload),
      resolveSessionArtifacts: () => this._resolveSessionArtifacts(),
      getArtifactsDir: () => this._getArtifactsDir(),
      getPreferredThinkingLevel: () => this._preferredThinkingLevel,
      getPrimaryAgent: () => this.primaryAgent,
      getAgentTemplates: () => this.agentTemplates,
      createFromPredefined: (templateName, taskId, modelLevel) =>
        this._createSubAgentFromPredefined(templateName, taskId, modelLevel),
      createFromPath: (templateDir, taskId, modelLevel) =>
        this._createSubAgentFromPath(templateDir, taskId, modelLevel),
      resolveTemplatePath: (relPath) => this._resolveTemplatePath(relPath),
      buildSubAgentSystemPrompt: (basePrompt, persistent) =>
        this._buildSubAgentSystemPrompt(basePrompt, persistent),
      createChildSession: (o) => {
        const childSession = new Session({
          primaryAgent: o.primaryAgent,
          config: this.config,
          promptsDirs: this._promptsDirs,
          projectRoot: this._projectRoot,
          sessionArtifactsDir: o.artifactsDir,
          capabilities: CHILD_SESSION_CAPABILITIES,
          onTurnOutput: o.onTurnOutput,
          toolExecutorOverrides: {},
          deferQueuedMessageInjectionOnTurnExit: true,
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
      getParentModelConfig: () => this.primaryAgent.modelConfig,
      resolvePinnedModel: (entry) => {
        const resolved = resolveAgentModelEntry(this, entry);
        return { modelConfig: resolved.modelConfig, thinkingLevel: resolved.thinkingLevel };
      },
      resolveTierModel: (tier) => {
        const resolved = resolveModelTierEntry(this, tier);
        return { modelConfig: resolved.modelConfig, thinkingLevel: resolved.thinkingLevel };
      },
      appendStatus: (message, statusType) => {
        this._appendEntry(createStatus(this._nextLogId("status"), this._turnCount, message, statusType));
      },
    });
  }

  private get _subAgentFactoryInstance(): SubAgentFactory {
    return this._subAgentFactory ??= this._buildSubAgentFactory();
  }

  private _createSubAgentFromPredefined(templateName: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string } {
    return this._subAgentFactoryInstance.createFromPredefined(templateName, taskId, modelLevel);
  }

  private _createSubAgentFromPath(templateDir: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string } {
    return this._subAgentFactoryInstance.createFromPath(templateDir, taskId, modelLevel);
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

  /**
   * If content is a multimodal array, save inline base64 images to disk
   * and replace them with image_ref blocks for the log.
   * Returns the original content if no images, or if session dir is unavailable.
   */
  private _extractAndSaveImages(
    content: string | Array<Record<string, unknown>>,
  ): string | Array<Record<string, unknown>> {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content;

    let hasImage = false;
    for (const block of content) {
      if (block["type"] === "image" && block["data"]) {
        hasImage = true;
        break;
      }
    }
    if (!hasImage) return content;

    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return content; // Can't save without session dir

    const imagesDir = join(sessionDir, "images");
    try {
      mkdirSync(imagesDir, { recursive: true });
    } catch {
      return content; // Can't create images dir, keep inline
    }

    return content.map((block) => {
      if (block["type"] !== "image" || !block["data"]) return block;

      const mediaType = (block["media_type"] as string) || "image/png";
      const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg") || "png";
      let filename = "";
      let filePath = "";
      do {
        this._imageCounter += 1;
        filename = `img-${String(this._imageCounter).padStart(3, "0")}.${ext}`;
        filePath = join(imagesDir, filename);
      } while (existsSync(filePath));

      try {
        writeFileSync(filePath, Buffer.from(block["data"] as string, "base64"));
      } catch {
        return block; // Write failed, keep inline
      }

      return {
        type: "image_ref",
        path: `images/${filename}`,
        media_type: mediaType,
      };
    });
  }

  /**
   * Resolve an image_ref path to base64 data for API consumption.
   * Used by projectToApiMessages to restore image data from files.
   */
  private _resolveImageRef(refPath: string): { data: string; media_type: string } | null {
    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return null;
    const fullPath = join(sessionDir, refPath);
    try {
      const data = readFileSync(fullPath);
      const ext = refPath.split(".").pop() || "png";
      const mediaTypeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
      };
      return {
        data: data.toString("base64"),
        media_type: mediaTypeMap[ext] || "image/png",
      };
    } catch {
      return null;
    }
  }

  // ==================================================================
  // @file attachment processing
  // ==================================================================

  private async _processFileAttachments(userInput: string): Promise<string | Array<Record<string, unknown>>> {
    const supportsMultimodal = this.primaryAgent.modelConfig.supportsMultimodal;
    const [, refs] = parseReferences(userInput);
    const explicitAttachmentRoots = new Set<string>();
    for (const raw of refs) {
      if (!raw || typeof raw !== "string") continue;
      try {
        safePath({
          baseDir: this._projectRoot,
          requestedPath: raw,
          cwd: this._projectRoot,
          accessKind: "attach",
          allowCreate: true,
        });
      } catch (e) {
        if (!(e instanceof SafePathError)) continue;
        if (e.code !== "PATH_OUTSIDE_SCOPE" && e.code !== "PATH_SYMLINK_ESCAPES_SCOPE") continue;
        const lexicalTarget = e.details.resolvedPath || resolve(this._projectRoot, raw);
        explicitAttachmentRoots.add(resolve(lexicalTarget));
      }
    }
    const externalRoots = [...explicitAttachmentRoots];
    const attachmentArtifactsDir =
      this._sessionArtifactsOverride ?? this._getArtifactsDirIfAvailable?.();
    try {
      const result = await processFileAttachments(
        userInput,
        undefined,
        supportsMultimodal,
        this._projectRoot,
        externalRoots,
        attachmentArtifactsDir,
      );

      if (!fileAttachHasFiles(result)) return userInput;

      if (fileAttachHasImages(result) && supportsMultimodal) {
        const contentParts: Array<Record<string, unknown>> = [];
        const cleaned = result.cleanedText.trim();
        if (cleaned) {
          contentParts.push({ type: "text", text: cleaned });
        }
        for (const f of result.files) {
          if (f.isImage && f.imageData) {
            contentParts.push({
              type: "image",
              media_type: f.imageMediaType,
              data: f.imageData,
            });
          }
        }
        if (result.contextStr) {
          contentParts.push({ type: "text", text: result.contextStr });
        }
        return contentParts;
      }

      let userContent = result.cleanedText;
      if (result.contextStr) {
        userContent += "\n\n" + result.contextStr;
      }
      return userContent;
    } catch (e) {
      console.warn(
        `File attachment processing failed; continuing without attachments: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return userInput;
    }
  }

  // ==================================================================
  // MCP integration
  // ==================================================================

  private async _ensureMcp(): Promise<void> {
    if (!this._mcpManager) return;
    if (this._mcpConnected) return;

    // Await bootstrap's fire-and-forget connectAll if available.
    if (this._mcpReadyPromise) {
      await this._mcpReadyPromise;
      this._mcpReadyPromise = undefined;
    }

    const agents = [this.primaryAgent, ...Object.values(this.agentTemplates)];
    this._mcpConnected = await registerMcpTools(
      this._mcpManager,
      this._toolExecutors,
      agents,
    );

    if (this.onMcpStatus && typeof this._mcpManager.getServerStatuses === "function") {
      this.onMcpStatus(this._mcpManager.getServerStatuses());
    }
  }

  // ==================================================================
  // Persistence
  // ==================================================================

  // getStateForPersistence() and restoreFromPersistence() removed.
  // All persistence is now via getLogForPersistence() / restoreFromLog().

  private _generateSummary(): string {
    if (this._cachedSummary !== undefined) return this._cachedSummary;
    for (const entry of this._log) {
      if (entry.type !== "user_message") continue;
      if (entry.discarded) continue;
      const display = entry.display;
      if (!display) continue;
      if (SYSTEM_PREFIXES.some((prefix) => display.startsWith(prefix))) continue;
      this._cachedSummary = stripContextTags(display).slice(0, 100).trim();
      return this._cachedSummary;
    }
    return "New session";
  }

  // ==================================================================
  // Resource cleanup
  // ==================================================================

  async close(): Promise<void> {
    // 1. Freeze the root inbox before interrupt. Child inboxes need no
    // freezing: _suspendAllChildSessions persists each child's live inbox.
    const frozenRootInbox = [...this._inbox];

    // 2-3. Interrupt root turn and wait for it to complete
    this.requestTurnInterrupt();
    await this.waitForTurnComplete();

    // 4-5. Abort running child turns and wait for them to settle
    this._cascadeKillRunningChildren("parent_kill");
    await this._waitForAllChildTurnsSettled();

    // 6. Suspend all child sessions (preserves lifecycle)
    this._suspendAllChildSessions();

    // 7. Persist root session (inbox is frozen)
    // The frozen inbox will be included via getLogForPersistence if caller saves
    this._inbox = frozenRootInbox;

    // 8. Kill all shells
    this._forceKillAllShells();

    // 9. Fire Stop hooks (fire-and-forget)
    this.hookRuntime.fireAndForget("Stop", { event: "Stop", timestamp: Date.now() });
    this.hookRuntime.fireAndForget("SessionEnd", { event: "SessionEnd", timestamp: Date.now() });

    // 10. Close MCP connections
    if (this._mcpManager) {
      try {
        await this._mcpManager.closeAll();
      } catch (e) {
        console.warn("Error closing MCP connections:", e);
      }
    }
  }
}
