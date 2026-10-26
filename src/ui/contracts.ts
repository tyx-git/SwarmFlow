/**
 * 共享终端 UI 合约定义。
 *
 * 这些类型描述了运行时与任何终端 UI 实现之间的边界。
 * 它们是有意与渲染器无关的。
 */

import type { ProgressReporter } from "../logging/progress.js";
import type { Task } from "../tasks/types.js";
import type { SessionStore } from "../config/session-store.js";
import type { LogSessionMeta } from "../config/session-meta.js";
import type {
  PendingAskUi,
  AgentQuestionDecision,
} from "../ask.js";
import type { LogEntry } from "../context/entry/types.js";
import type { LogIdAllocator } from "../context/entry/id-allocator.js";
import type { DeliverMessageResult } from "../session/tree-types.js";
import type { CommandRegistry as ActualCommandRegistry } from "../commands/registry.js";
import type { SessionLike } from "../session/contract.js";
import type {
  CommandContext,
  SlashCommand as ActualSlashCommand,
  CommandOption as ActualCommandOption,
} from "../commands/types.js";

// ------------------------------------------------------------------
// 回滚计划类型
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

// Bash 变更回滚类型

export interface BashRewindEntry {
  entryId: string;
  turnIndex: number;
  /** BashMutation.entries 数组中的索引（用于逐条还原跟踪）。 */
  bashEntryIndex: number;
  /** 会话日志中的位置（用于与文件变更按时间排序）。 */
  logIndex: number;
  kind: "mkdir" | "cp" | "mv";
  description: string;
  status: "applicable" | "conflict";
  conflictReason?: "dir_not_empty" | "dir_deleted" | "backup_missing" | "source_occupied" | "disk_modified" | "target_deleted" | "untracked";
  conflictDetails?: string[];
  /** 用于执行的原始 BashMutationEntry。 */
  mutation: import("../tools/mutations.js").BashMutationEntry;
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

/**
 * TUI 侧的会话面 = 命令层依赖的 `SessionLike` + UI 渲染额外需要的只读快照/订阅。
 * 命令层用到的成员一律继承自 `SessionLike`，不在此重复声明（避免两处漂移）。
 */
export interface Session extends SessionLike {
  turn(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[] }): Promise<string>;
  close(): Promise<void>;
  requestTurnInterrupt?(): { accepted: true };
  cancelCurrentTurn?(): void;
  hasRunningChildAgents?(): boolean;
  denyPendingAsk?(): boolean;
  denyAndInterruptPendingAsk?(): { accepted: boolean; reason?: string; turnFinished?: boolean };
  setProgressReporter?(reporter: ProgressReporter | undefined): void;
  clearProgressReporter?(reporter: ProgressReporter): void;
  turnCount?: number;
  canRunDeferredCommand?(): boolean;
  compactCount?: number;
  createdAt?: string;
  lastInputTokens: number;
  lastTotalTokens: number;
  lastCacheReadTokens?: number;
  cacheSupported?: boolean;
  contextBudget: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeUncachedTokens: number;
  systemPromptTokens: number;
  contextBreakdown: { systemPrompt: number; tools: number; agentsMd: number; skills: number; messages: number };
  computeGlobalTokenStats?(): { cumulativeInput: number; cumulativeOutput: number; cumulativeCacheRead: number; cumulativeUncached: number; sessionCount: number; sessionsWithoutTokens: string[] };
  onSaveRequest?: () => boolean;
  setStore(store: SessionStore | null): void;
  getPendingAsk(): PendingAskUi | null;
  resolveAgentQuestionAsk?(askId: string, decision: AgentQuestionDecision): void;
  resolveApprovalAsk?(askId: string, choiceIndex: number): void;
  resumePendingTurn?(options?: { signal?: AbortSignal }): Promise<string>;
  hasPendingTurnToResume?(): boolean;
  runManualCompact?(instruction?: string, options?: { signal?: AbortSignal; completionDisplay?: string }): Promise<void>;
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
  _initConversation(): void;
  deliverMessage?(source: "user" | "system", content: string): DeliverMessageResult | void;
  restoreQueuedUserInput?(): string | null;
  log?: readonly LogEntry[];
  /** Log filtered by display cutoff — hides entries before /clear. */
  getDisplayLog?(): readonly LogEntry[];
  subscribeLog?(listener: () => void): () => void;
  getLogRevision?(): number;
  /** 当前活动（流式/执行中）日志条目的 ID，或 null。 */
  activeLogEntryId?: string | null;
  getChildSessionLog?(childId: string): readonly LogEntry[] | null;
  interruptChildSession?(childId: string): { accepted: boolean; reason?: string };
  restoreFromLog?(meta: LogSessionMeta, entries: LogEntry[], idAllocator: LogIdAllocator): void;
  getLogForPersistence?(): { meta: LogSessionMeta; entries: readonly LogEntry[] };
  persistToDisk?(): boolean;
  /** R-3：是否还有更早的历史可加载。 */
  hasEarlierHistory?(): boolean;
  /** R-3：加载一页更早的历史并合并到展示日志。 */
  loadEarlierHistoryPage?(maxEntries?: number): { loaded: number; hasMore: boolean; capped?: boolean };
  /** R-3：异步读取归档display，不阻塞TUI事件循环。 */
  loadEarlierHistoryPageAsync?(maxEntries?: number): Promise<{ loaded: number; hasMore: boolean; capped?: boolean }>;
  /** R-3：页缓存是否已达 8 MiB 上限。 */
  isHistoryCacheCapped?(): boolean;
  appendUserInputDisplay?(text: string): void;
  reloadSkills?(): { added: string[]; removed: string[]; total: number };
  /** 当前会话的任务清单（内存权威，磁盘为 write-through 副本）。 */
  getTaskState?(): readonly Task[];
  /** 任务清单变更订阅（父面板与 badge 用；不读盘）。 */
  subscribeTaskState?(listener: () => void): () => void;
  /** 任务清单是否落盘；`"memory"` 时 UI 才需要标注"不持久化"。 */
  getTaskPersistence?(): "file" | "pending" | "memory";
  /** 待处理询问变更订阅（自身 + 子会话询问）。 */
  subscribeAsk?(listener: () => void): () => void;
  /** 轮次生命周期订阅；参见 session.ts 中的 TurnLifecycleEvent。 */
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
  | "command_echo"
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
  /** 预览/详情条目的完整未截断结果文本。 */
  fullText?: string;
}

export interface LaunchOptions {
  session: Session;
  commandRegistry?: CommandRegistry;
  sessionStore?: SessionStore | null;
  config?: { defaultModel?: string };
}
