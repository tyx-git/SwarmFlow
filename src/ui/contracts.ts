/**
 * Shared terminal UI contract definitions.
 *
 * These types describe the boundary between the runtime and any terminal UI
 * implementation. They are intentionally renderer-agnostic.
 */

import type { ProgressReporter } from "../lib/progress.js";
import type { PlanCheckpoint } from "../lib/plan-state.js";
import type { SessionStore, LogSessionMeta } from "../config/persistence.js";
import type {
  PendingAskUi,
  AgentQuestionDecision,
} from "../ask.js";
import type { LogEntry, LogIdAllocator } from "../context/log-entry.js";
import type { ChildSessionSnapshot, DeliverMessageResult } from "../session-tree-types.js";
import type {
  CommandRegistry as ActualCommandRegistry,
  CommandContext,
  SlashCommand as ActualSlashCommand,
  CommandOption as ActualCommandOption,
} from "../commands/commands.js";

// ------------------------------------------------------------------
// Rewind plan types
// ------------------------------------------------------------------

export interface RewindPathMutation {
  entryId: string;
  turnIndex: number;
  reversePatch: string;
}

export interface RewindPlanApplicable {
  path: string;
  mutations: RewindPathMutation[];
}

export interface RewindPlanWarning {
  path: string;
  reason: "disk_modified";
  mutations: RewindPathMutation[];
}

export interface RewindPlanConflict {
  path: string;
  reason: "patch_failed" | "untracked" | "file_deleted" | "file_not_readable";
}

// Bash mutation rewind types

export interface BashRewindEntry {
  entryId: string;
  turnIndex: number;
  /** Index within the BashMutation.entries array (for per-entry revert tracking). */
  bashEntryIndex: number;
  /** Position in the session log (for chronological ordering with file mutations). */
  logIndex: number;
  kind: "mkdir" | "cp" | "mv";
  description: string;
  status: "applicable" | "conflict";
  conflictReason?: "dir_not_empty" | "dir_deleted" | "backup_missing" | "source_occupied" | "disk_modified" | "target_deleted";
  conflictDetails?: string[];
  /** Original BashMutationEntry for execution. */
  mutation: import("../tools/basic.js").BashMutationEntry;
}

export interface RewindPlan {
  fromTurnIndex: number;
  applicable: RewindPlanApplicable[];
  warnings: RewindPlanWarning[];
  conflicts: RewindPlanConflict[];
  bashEntries: BashRewindEntry[];
  totalAdditions: number;
  totalDeletions: number;
  summaryFile: string;
  otherFileCount: number;
}

export interface RewindApplyResult {
  revertedPaths: string[];
  conflictPaths: string[];
  bashReverted: string[];
  bashSkipped: string[];
  error?: string;
}

// ------------------------------------------------------------------

export type CommandRegistry = ActualCommandRegistry;
export type SlashCommand = ActualSlashCommand;
export type CommandOption = ActualCommandOption;
export type { CommandContext };

import type { InlineImageInput } from "../session.js";
export type { InlineImageInput };

export interface Session {
  turn(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[] }): Promise<string>;
  close(): Promise<void>;
  requestTurnInterrupt?(): { accepted: true };
  cancelCurrentTurn?(): void;
  interruptAllChildAgents?(): void;
  hasRunningChildAgents?(): boolean;
  denyPendingAsk?(): boolean;
  denyAndInterruptPendingAsk?(): { accepted: boolean; reason?: string; turnFinished?: boolean };
  killAllShells?(): void;
  primaryAgent: {
    name: string;
    modelConfig?: {
      name?: string;
      provider?: string;
      model?: string;
      contextLength?: number;
    };
  };
  setProgressReporter?(reporter: ProgressReporter | undefined): void;
  clearProgressReporter?(reporter: ProgressReporter): void;
  turnCount?: number;
  compactCount?: number;
  createdAt?: string;
  lastInputTokens: number;
  lastTotalTokens: number;
  lastCacheReadTokens?: number;
  contextBudget: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeUncachedTokens: number;
  systemPromptTokens: number;
  contextBreakdown: { systemPrompt: number; tools: number; agentsMd: number; skills: number; messages: number };
  computeGlobalTokenStats?(): { cumulativeInput: number; cumulativeOutput: number; cumulativeCacheRead: number; cumulativeUncached: number; sessionCount: number };
  onSaveRequest?: () => void;
  onMcpStatus?: (statuses: Array<{ name: string; state: string; toolCount: number; error?: string }>) => void;
  setStore(store: SessionStore | null): void;
  getPendingAsk(): PendingAskUi | null;
  resolveAgentQuestionAsk?(askId: string, decision: AgentQuestionDecision): void;
  resolveApprovalAsk?(askId: string, choiceIndex: number): void;
  permissionMode?: string;
  hookRuntime?: { hooks: readonly any[]; getAdditionalContext(): string | null };
  getGlobalPreferences?(): any;
  getRewindTargets?(): Array<{
    turnIndex: number;
    entryIndex: number;
    preview: string;
    timestamp: number;
    fileCount: number;
    additions: number;
    deletions: number;
    filesReverted: boolean;
  }>;
  planRewind?(fromTurnIndex: number): Promise<RewindPlan>;
  rewindConversation?(toTurnIndex: number): { removed: number; error?: string };
  rewindFiles?(plan: RewindPlan): Promise<RewindApplyResult>;
  rewindBoth?(toTurnIndex: number, plan: RewindPlan): Promise<RewindApplyResult & { removed: number }>;
  resumePendingTurn?(options?: { signal?: AbortSignal }): Promise<string>;
  hasPendingTurnToResume?(): boolean;
  runManualSummarize?(options?: { signal?: AbortSignal; targetContextIds?: string[]; focusPrompt?: string }): Promise<string>;
  getSummarizeTargets?(): Array<{ kind: "turn" | "summary"; turnIndex: number; preview: string; timestamp: number; contextId?: string }>;
  getContextIdsForTurnRange?(startTurn: number, endTurn: number): string[];
  runManualCompact?(instruction?: string, options?: { signal?: AbortSignal }): Promise<void>;
  getBackgroundShellSnapshots?(): Array<{
    id: string; command: string; cwd: string;
    status: "running" | "exited" | "failed" | "killed";
    exitCode: number | null; elapsedSeconds: number;
    recentOutput: string[]; logPath: string;
  }>;
  getBackgroundShellDetail?(id: string, opts?: { maxChars?: number }): ({
    id: string; command: string; cwd: string;
    status: "running" | "exited" | "failed" | "killed";
    exitCode: number | null; elapsedSeconds: number;
    recentOutput: string[]; logPath: string;
    logTail: string; logTruncated: boolean;
  }) | null;
  stopBackgroundShell?(id: string): Promise<string>;
  thinkingLevel?: string;
  currentModelConfigName?: string;
  switchModel?(modelConfigName: string): void;
  reloadCurrentModelConfig?(): void;
  config?: {
    modelNames: string[];
    getModel(name: string): { provider: string; model: string; contextLength: number; supportsThinking: boolean; supportsMultimodal: boolean };
    invalidateModel?(name: string): void;
    invalidateModelsByProvider?(provider: string): void;
  };
  _resetTransientState(): void;
  _initConversation(): void;
  deliverMessage?(source: "user" | "system", content: string): DeliverMessageResult | void;
  restoreQueuedUserInput?(): string | null;
  log?: readonly LogEntry[];
  subscribeLog?(listener: () => void): () => void;
  getLogRevision?(): number;
  /** The ID of the currently active (streaming/executing) log entry, or null. */
  activeLogEntryId?: string | null;
  getChildSessionSnapshots?(): ChildSessionSnapshot[];
  getChildSessionLog?(childId: string): readonly LogEntry[] | null;
  interruptChildSession?(childId: string): { accepted: boolean; reason?: string };
  restoreFromLog?(meta: LogSessionMeta, entries: LogEntry[], idAllocator: LogIdAllocator): void;
  getLogForPersistence?(): { meta: LogSessionMeta; entries: readonly LogEntry[] };
  resetForNewSession?(newStore?: any): void;
  appendStatusMessage?(text: string, statusType?: string): void;
  appendErrorMessage?(text: string, errorType?: string): void;
  getAllSkillNames?(): { name: string; description: string; enabled: boolean }[];
  setSkillEnabled?(name: string, enabled: boolean): void;
  reloadSkills?(): { added: string[]; removed: string[]; total: number };
  notifySkillAvailabilityChanged?(changes: { enabled?: string[]; disabled?: string[] }): void;
  reloadMcp?(options?: { notice?: boolean; reason?: string }): Promise<string>;
  reconnectMcpServer?(serverName: string): Promise<boolean>;
  /** Turn-lock-wrapped command variants so reload cannot overlap a live turn. */
  reloadMcpFromCommand?(reason: string): Promise<string>;
  reconnectMcpServerFromCommand?(serverName: string): Promise<boolean>;
  ensureMcpReadyFromCommand?(): Promise<void>;
  skills?: ReadonlyMap<string, unknown>;
  getPlanState?(): PlanCheckpoint[];
  subscribePlan?(listener: () => void): () => void;
  /** Pending-ask change subscription (own + child-session asks). */
  subscribeAsk?(listener: () => void): () => void;
  /** Turn lifecycle subscription; see TurnLifecycleEvent in session.ts. */
  subscribeTurnLifecycle?(
    listener: (event: {
      phase: "started" | "ended";
      turnIndex: number;
      status?: "completed" | "interrupted" | "error" | "waiting";
      error?: string;
    }) => void,
  ): () => void;
}

export type ConversationEntryKind =
  | "user"
  | "agent_result"
  | "assistant"
  | "interrupted_marker"
  | "progress"
  | "sub_agent_rollup"
  | "sub_agent_done"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "status"
  | "error"
  | "compact_mark";

export interface ConversationEntry {
  kind: ConversationEntryKind;
  text: string;
  startedAt?: number;
  elapsedMs?: number;
  id?: string;
  queued?: boolean;
  dim?: boolean;
  meta?: Record<string, unknown>;
  /** Full untruncated result text for preview/detail entries. */
  fullText?: string;
}

export interface LaunchOptions {
  session: Session;
  commandRegistry?: CommandRegistry;
  sessionStore?: SessionStore | null;
  config?: { defaultModel?: string };
}
