/**
 * 手动/自动压缩：执行 compact phase、事务化提交、失败清理、并发保护。
 *
 * 提交顺序：compact phase → archive 原子写 → 单条 compact_checkpoint →
 * 再改内存（archive/strip/token）。checkpoint 是唯一 commit point；
 * 它之前的失败必须完整回滚，之后的表现层异常只告警。
 */

import { isNoReply } from "../agents/agent.js";
import type { Agent } from "../agents/agent.js";
import type { ToolLoopResult } from "../agents/tool-loop/types.js";
import { createAssistantText, createCompactContext, createCompactMarker, createReasoning } from "../context/entry/factories.js";
import { estimateEntryTokens } from "../context/token-estimate.js";
import { archiveWindowById, deleteArchiveFiles, type ArchiveWindowResult } from "../config/archive.js";
import type { LogEntry } from "../context/entry/types.js";
import type { SessionStore } from "../config/session-store.js";
import type { ContextManager } from "./context-manager.js";
import type { ProgressReporter } from "../logging/progress.js";
import type { Task } from "../tasks/types.js";
import type { LogSurgery } from "./log-surgery.js";
import type { SessionLog } from "./log.js";
import type { AskRequest } from "../ask.js";
import { appendManualInstruction, COMPACT_PROMPT_OUTPUT, COMPACT_PROMPT_TOOLCALL } from "./prompts.js";
import { createUserMessage as createUserMessageEntry } from "../context/entry/factories.js";

const MAX_COMPACT_PHASE_ROUNDS = 10;
/** 同一个 turn() 内自动压缩（before_turn + mid_turn）的硬上限。 */
export const MAX_AUTO_COMPACTS_PER_TURN = 3;
/** continuation 的最小长度；短于此视为压缩阶段失败，不提交。 */
export const MIN_CONTINUATION_CHARS = 200;
/** continuation 的硬上限；超长摘要会在下一轮立刻再次压缩。 */
export const MAX_CONTINUATION_CHARS = 16_000;
/** 逐字 tail 的字符上限（已定案 4k/4k/2k）。 */
export const VERBATIM_USER_CAP = 4_000;
export const VERBATIM_ASSISTANT_CAP = 4_000;
export const VERBATIM_TOOL_CAP = 2_000;
/** 压缩阶段控制文本，不能进入 continuation。 */
const COMPACT_CONTROL_MARKERS = [
  "[SYSTEM: COMPACT REQUIRED]",
  "[Compact phase did not produce a continuation prompt.]",
] as const;

export type CompactOrigin = "auto" | "manual";

export interface CompactCommitResult {
  status: "committed";
  checkpointId: string;
  compactIndex: number;
}

export class CompactPhaseEmptyError extends Error {
  readonly code = "E_COMPACT_CONTINUATION_INVALID";
  constructor(reason: string) {
    super(`Compact phase produced an invalid continuation prompt: ${reason}`);
    this.name = "CompactPhaseEmptyError";
  }
}

export class CompactTurnLimitError extends Error {
  readonly code = "E_COMPACT_TURN_LIMIT";
  constructor(limit: number) {
    super(
      `Automatic compaction reached the per-turn limit (${limit}). `
      + "The turn ended with the current context preserved; send a new message or run /compact manually.",
    );
    this.name = "CompactTurnLimitError";
  }
}

export class CompactDidNotReduceContextError extends Error {
  readonly code = "E_COMPACT_NO_REDUCTION";
  /** checkpoint 已提交；调用方不得把这次错误当成未提交尝试去截断。 */
  readonly committed = true;
  constructor() {
    super(
      "Compaction did not reduce the context below the 80% threshold. "
      + "The turn ended instead of compacting repeatedly; use a larger context window or prune manually.",
    );
    this.name = "CompactDidNotReduceContextError";
  }
}

export class CompactInsufficientWorkspaceError extends Error {
  readonly code = "E_COMPACT_WORKSPACE_LOW";
  readonly committed = false;
  constructor() {
    super("Compaction would leave less than 40% of the context budget for continued work.");
    this.name = "CompactInsufficientWorkspaceError";
  }
}

export class CompactArchiveRequiredError extends Error {
  readonly code = "E_COMPACT_ARCHIVE_REQUIRED";
  readonly committed = false;
  constructor() {
    super("Compaction cannot commit a window with entries to archive before session storage is ready.");
    this.name = "CompactArchiveRequiredError";
  }
}

/** 判断错误是否发生在 checkpoint 提交之后（禁止回滚历史）。 */
export function isCommittedCompactError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { committed?: unknown }).committed === true,
  );
}

/** 校验 compact phase 产出的 continuation；失败不得写 checkpoint。 */
export function validateContinuation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new CompactPhaseEmptyError("empty text");
  if (isNoReply(trimmed) || trimmed.includes("<NO_REPLY>")) {
    throw new CompactPhaseEmptyError("no-reply marker");
  }
  if (COMPACT_CONTROL_MARKERS.some((marker) => trimmed.includes(marker))) {
    throw new CompactPhaseEmptyError("compact control text");
  }
  if (trimmed.length < MIN_CONTINUATION_CHARS) {
    throw new CompactPhaseEmptyError(
      `too short (${trimmed.length} < ${MIN_CONTINUATION_CHARS} chars)`,
    );
  }
  if (trimmed.length > MAX_CONTINUATION_CHARS) {
    throw new CompactPhaseEmptyError(
      `too long (${trimmed.length} > ${MAX_CONTINUATION_CHARS} chars)`,
    );
  }
  return trimmed;
}

/** 超长文本保留头尾；不允许把长粘贴原样带进下一窗口。 */
export function truncateVerbatim(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  return `${text.slice(0, head)}\n…[${text.length - cap} chars omitted]…\n${text.slice(-tail)}`;
}

function entryText(entry: LogEntry): string {
  const content = entry.content;
  if (typeof content === "string") return content;
  if (entry.display) return entry.display;
  return content === null ? "" : JSON.stringify(content);
}

/**
 * 代码确定性提取的逐字 tail。模型摘要无法保证路径/命令/常数，
 * 这一层不依赖模型输出。
 */
export function buildVerbatimTail(
  entries: readonly LogEntry[],
  scenario: "before_turn" | "mid_turn",
  origin: CompactOrigin,
): string {
  const isCompactPhase = (entry: LogEntry): boolean =>
    (entry.meta as Record<string, unknown>)["compactPhase"] === true
    || (entry.meta as Record<string, unknown>)["displayOnly"] === true;

  let latestUser = "";
  let latestAssistant = "";
  let latestTool = "";
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.discarded || entry.archived || isCompactPhase(entry)) continue;

    if (!latestUser && entry.type === "user_message" && entry.apiRole === "user") {
      const meta = entry.meta as Record<string, unknown>;
      if (meta["inputKind"] !== "system" && meta["inputKind"] !== "peer") {
        latestUser = entryText(entry);
      }
    }
    if (!latestAssistant && entry.type === "assistant_text") {
      latestAssistant = entryText(entry);
    }
    if (scenario === "mid_turn" && !latestTool && entry.type === "tool_result") {
      const content = entry.content as { content?: unknown; toolSummary?: unknown } | null;
      const summary = typeof content?.toolSummary === "string" ? content.toolSummary : "";
      const body = typeof content?.content === "string" ? content.content : entry.display;
      latestTool = [summary, body].filter(Boolean).join("\n");
    }
    if (latestUser && latestAssistant && (scenario !== "mid_turn" || latestTool)) break;
  }

  const parts: string[] = [];
  if (latestUser) {
    const label = origin === "manual"
      ? "Latest user message (verbatim; already answered — reference only, do not re-answer)"
      : "Latest user message (verbatim; current request — continue it)";
    parts.push(`${label}:\n${truncateVerbatim(latestUser, VERBATIM_USER_CAP)}`);
  }
  if (latestAssistant) {
    parts.push(`Last assistant message (verbatim):\n${truncateVerbatim(latestAssistant, VERBATIM_ASSISTANT_CAP)}`);
  }
  if (latestTool) {
    parts.push(`Last tool result (verbatim excerpt; mid_turn only):\n${truncateVerbatim(latestTool, VERBATIM_TOOL_CAP)}`);
  }
  if (parts.length === 0) return "";
  return `[VERBATIM TAIL — reference only]\n${parts.join("\n\n")}`;
}

function previousLiveMarkerIndex(entries: readonly LogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compact_marker" && !entries[i]!.discarded) return i;
  }
  return -1;
}

/** 下一个 compactIndex 取 live marker 的最大索引 + 1；rewind 空洞不生成重复文件名。 */
function nextCompactIndex(entries: readonly LogEntry[]): number {
  let max = -1;
  for (const entry of entries) {
    if (entry.type !== "compact_marker" || entry.discarded) continue;
    const raw = (entry.meta as Record<string, unknown>)["compactIndex"];
    if (typeof raw === "number" && Number.isInteger(raw) && raw > max) max = raw;
  }
  return max + 1;
}

function warnPostCommit(host: CompactHost, message: string): void {
  try {
    host._recordSessionEvent(`compact warning: ${message}`);
  } catch {
    // 记录事件本身失败也不能影响已提交状态。
  }
}

function applyCommittedCompact(
  host: CompactHost,
  args: {
    ids: readonly string[];
    checkpointId: string;
    archiveFile: string;
    compactIndex: number;
    originalTokens: number;
    compactedTokens: number;
    scenario: "before_turn" | "mid_turn";
  },
): void {
  try {
    // 先折叠用量，再归档/剥离冷区 token_update。
    host._foldArchivedUsage();
    if (args.ids.length > 0) {
      host._logStore.archiveEntries(args.ids, {
        checkpointId: args.checkpointId,
        archiveFile: args.archiveFile,
      });
    }
    // 活动窗口之外的已归档条目可以立即释放 display/meta；
    // TUI 历史页按需从 archive 取回，折叠阈值不再决定存储边界。
    host._logStore.stripArchivedPresentation(host._log.length - 1);
  } catch (error) {
    warnPostCommit(host, `memory release failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  host._lastInputTokens = 0;
  host._lastTotalTokens = 0;
  host._lastCacheReadTokens = 0;
  host._cacheSupported = false;
  host._compactCount = Math.max(host._compactCount, args.compactIndex + 1);

  try {
    host.onSaveRequest?.();
  } catch (error) {
    warnPostCommit(host, `save request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 压缩流程所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface CompactHost {
  primaryAgent: Agent;
  onSaveRequest?: () => boolean;
  _store: SessionStore | undefined;
  _log: LogEntry[];
  _logStore: SessionLog;
  _turnCount: number;
  _compactCount: number;
  _compactInProgress: boolean;
  /** 本 turn 已提交的自动压缩次数；手动 /compact 不计入。 */
  _autoCompactCountThisTurn: number;
  _contextManager: ContextManager;
  _agentState: string;
  _activeAsk: AskRequest | null;
  _pendingTurnState: unknown;
  _progress?: ProgressReporter;
  _lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  _lastInputTokens: number;
  _lastTotalTokens: number;
  _lastCacheReadTokens: number;
  _cacheSupported: boolean;
  _hasActiveAgents(): boolean;
  _hasRunningShells(): boolean;
  _hasWakingInboxMessages(): boolean;
  _buildShellReport(): string;
  _recordSessionEvent(summary: string): void;
  _recordTurnFailure(err: unknown, signal?: AbortSignal): void;
  _installCurrentTurnSignal(signal?: AbortSignal): {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
    signal: AbortSignal;
  };
  _restoreCurrentTurnSignal(state: {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
  }): void;
  _isCompactAbortError(err: unknown): boolean;
  _nextLogId(type: LogEntry["type"]): string;
  _appendEntry(entry: LogEntry, save?: boolean): void;
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
  ): void;
  _truncateCompactAttemptEntries(fromIndex: number): void;
  /** provider 无 usage 时的活动窗口 + 静态前缀估算。 */
  _estimateContextTokens(): number;
  /** 仅静态前缀（system/tools/memory/skills）的 token 估算。 */
  _estimateStaticContextTokens(): number;
  /** 当前请求的 ephemeral runtime/hook 尾巴 token 估算。 */
  _estimateEphemeralTailTokens?(): number;
  /** 归档前把累计用量折成 usage base，避免冷区 token_update 被 strip 后丢账。 */
  _foldArchivedUsage(): void;
  _touchLog(): void;
  _allocateContextId(): string;
  _beginWorkIfNeeded(): string;
  _finishCurrentWork(status: "completed" | "interrupted" | "error", interruptHints?: string[]): void;
  _appendInterruptionSystemMessage(partialToolNames?: readonly string[], compactWasInterrupted?: boolean): void;
  _beginActiveInput(inputKind: "user" | "compact", display: string, content: unknown): { inputIndex: number; inputId: string; contextId: string };
  _computeNextRoundIndex(turnIndex?: number): number;
  _scheduleAutoResume(): void;
  _ensureSessionStorageReady(): void;
  _withTurnLock<T>(fn: () => Promise<T>): Promise<T>;
  _runActivation(
    activationTurnIndex: number,
    signal?: AbortSignal,
    textAccumulator?: { text: string },
    reasoningAccumulator?: { text: string },
    suppressStreaming?: boolean,
  ): Promise<ToolLoopResult>;
  appendCommandEcho(displayText: string, tagged: string, options?: unknown): void;
  getTaskState(): readonly Task[];
  // 同簇方法：模块内按 host.X(...) 虚分派调用
  _getManualCompactBlocker(): string | null;
  _runManualCompactBody(instruction?: string, options?: { signal?: AbortSignal; completionDisplay?: string }): Promise<void>;
  _runCompactPhase(scenario: "before_turn" | "mid_turn", promptOverride?: string, signal?: AbortSignal): Promise<string>;
  _doAutoCompact(
    scenario: "before_turn" | "mid_turn",
    signal?: AbortSignal,
    promptOverride?: string,
    hideCompactMarker?: boolean,
    origin?: CompactOrigin,
  ): Promise<CompactCommitResult>;
  _discardCompactAttemptEntries(fromIndex: number): void;
}
// ==================================================================
// 手动/自动压缩：执行 compact phase、丢弃失败尝试、并发保护
// ==================================================================

export function getManualCompactBlocker(host: CompactHost): string | null {
  if (host._compactInProgress) {
    return "Cannot run /compact while compact is in progress.";
  }
  if (host._agentState !== "idle") {
    return "Cannot run /compact while the current turn is still running.";
  }
  if (host._activeAsk) {
    return "Cannot run /compact while an ask is pending.";
  }
  if (host._pendingTurnState) {
    return "Cannot run /compact while a turn is waiting to resume.";
  }
  if (host._hasActiveAgents()) {
    return "Cannot run /compact while sub-agents are still running.";
  }
  if (host._hasRunningShells()) {
    return [
      "Cannot run /compact while background shells are still running.",
      host._buildShellReport(),
      "Stop the shells you no longer need (open the process panel or run /ps), then retry.",
    ].filter(Boolean).join("\n");
  }
  if (host._hasWakingInboxMessages()) {
    return "Cannot run /compact while queued messages are waiting to be delivered.";
  }
  return null;
}

export async function runManualCompact(host: CompactHost,
  instruction?: string,
  options?: { signal?: AbortSignal; completionDisplay?: string },
): Promise<void> {
  return host._withTurnLock(async () => {
    // 锁内 catch——不能放在锁外的原因见 runInjectedCommand。
    try {
      return await host._runManualCompactBody(instruction, options);
    } catch (err) {
      host._recordTurnFailure(err, options?.signal);
      throw err;
    }
  });
}

/** runManualCompact 的主体。调用方需持有 turn 锁。 */
export async function runManualCompactBody(host: CompactHost,
  instruction?: string,
  options?: { signal?: AbortSignal; completionDisplay?: string },
): Promise<void> {
  {
    host._ensureSessionStorageReady();

    const blocker = host._getManualCompactBlocker();
    if (blocker) throw new Error(blocker);

    host._lastTurnEndStatus = null;
    const displayText = instruction?.trim() ? `/compact ${instruction.trim()}` : "/compact";
    host._beginActiveInput("compact", displayText, displayText);
    host.onSaveRequest?.();

    const prompt = appendManualInstruction(
      COMPACT_PROMPT_OUTPUT,
      instruction,
      "compact",
    );
    const prevAgentState = host._agentState;
    const turnSignalState = host._installCurrentTurnSignal(options?.signal);
    host._agentState = "working";
    host._beginWorkIfNeeded();
    const logLenBeforeCompact = host._log.length;
    try {
      await host._doAutoCompact(
        "before_turn",
        turnSignalState.signal,
        prompt,
        Boolean(options?.completionDisplay),
        "manual",
      );
    } catch (err) {
      // 未提交：本次压缩尝试写入的全部条目不可信，物理截断。
      // 已提交（压后复检失败等）：checkpoint 必须保留，只回报错误。
      if (!isCommittedCompactError(err)) {
        host._truncateCompactAttemptEntries(logLenBeforeCompact);
      }
      if (turnSignalState.signal.aborted || host._isCompactAbortError(err)) {
        host._appendInterruptionSystemMessage([], true);
        host._recordSessionEvent("interrupted by user");
        host._finishCurrentWork("interrupted");
      } else {
        host._recordTurnFailure(err, turnSignalState.signal);
        host._finishCurrentWork("error");
      }
      throw err;
    } finally {
      host._restoreCurrentTurnSignal(turnSignalState);
      host._agentState = prevAgentState;
    }

    // checkpoint 已提交：以下都是表现层/簿记动作，失败只告警，绝不回滚历史。
    try {
      host.onSaveRequest?.();
      host._finishCurrentWork("completed");
      if (options?.completionDisplay) {
        host.appendCommandEcho(options.completionDisplay, "switch", "worked");
      }
    } catch (err) {
      warnPostCommit(host, `post-commit bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 压缩期间暂扣的唤醒消息（Q6），
    // 在会话重新空闲后获得投递轮次。
    if (host._hasWakingInboxMessages()) {
      host._scheduleAutoResume();
    }
  }
}

export function buildCompactCheck(host: CompactHost): ((
  inputTokens: number, outputTokens: number, hasToolCalls: boolean,
) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
  return host._contextManager.buildCompactCheck();
}

/**
 * 执行 compact phase：注入压缩提示，让 Agent 产出
 * continuation prompt（可能用到工具），然后返回它。
 */
export async function runCompactPhase(host: CompactHost,
  scenario: "before_turn" | "mid_turn",
  promptOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  host._compactInProgress = true;
  try {
    // 以 user_message 条目注入压缩提示（compactPhase，TUI 不可见）
    const prompt = promptOverride ?? (scenario === "before_turn" ? COMPACT_PROMPT_OUTPUT : COMPACT_PROMPT_TOOLCALL);
    const compactPromptEntry = createUserMessageEntry(
      host._nextLogId("user_message"),
      host._turnCount,
      "",  // TUI 不可见
      prompt,
      host._allocateContextId(),
    );
    compactPromptEntry.tuiVisible = false;
    (compactPromptEntry.meta as Record<string, unknown>)["compactPhase"] = true;
    host._appendEntry(compactPromptEntry, false);

    let continuationPrompt = "";
    for (let i = 0; i < MAX_COMPACT_PHASE_ROUNDS; i++) {
      if (signal?.aborted) {
        throw new DOMException("Compact phase aborted.", "AbortError");
      }

      // 与 _runTurnActivationLoop 相同的"每次 activation 固定 turnIndex"不变量：
      // 只取一次，这样即便排队消息在 activation 中途被 drain，
      // 工具循环条目与下面定稿的 reasoning/text
      // 也不会被拆到不同 turnIndex。见 _runActivation / Docs/session.md。
      const compactTurnIndex = host._turnCount;
      const result = await host._runActivation(compactTurnIndex, signal, undefined, undefined, true);
      if (signal?.aborted) {
        throw new DOMException("Compact phase aborted.", "AbortError");
      }
      if (result.reachedMaxToolRounds) {
        // 工具轮数上限返回的是固定哨兵文案，不是 continuation prompt；
        // 接受它会用哨兵替换整段历史，必须按压缩失败处理。
        throw new Error(
          "Compact phase hit the tool-round limit without producing a continuation prompt.",
        );
      }
      if (result.suspendedAsk) {
        // 压缩阶段不允许挂起等待审批（suppressAsks 已在工具循环内降级，
        // 这里是绕过降级路径的最后防线）。
        throw new Error("Compact phase cannot suspend for tool approvals.");
      }

      if (result.text) {
        const compactRound = host._computeNextRoundIndex(compactTurnIndex);
        const compactContextId = host._allocateContextId();
        if (result.reasoningContent) {
          const compactReasoningEntry = createReasoning(
            host._nextLogId("reasoning"),
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
          host._appendEntry(compactReasoningEntry, false);
        }
        const compactReplyEntry = createAssistantText(
          host._nextLogId("assistant_text"),
          compactTurnIndex,
          compactRound,
          "",
          result.text,
          compactContextId,
        );
        compactReplyEntry.tuiVisible = false;
        (compactReplyEntry.meta as Record<string, unknown>)["compactPhase"] = true;
        host._appendEntry(compactReplyEntry, false);
        continuationPrompt = result.text;
        break;
      }
    }
    if (!continuationPrompt) {
      throw new CompactPhaseEmptyError("compact phase produced no text");
    }
    return validateContinuation(continuationPrompt);
  } finally {
    host._compactInProgress = false;
  }
}

/**
 * 事务化执行自动压缩：
 *   compact phase → archive 原子写 → compact_checkpoint（commit）→
 *   内存侧 archive/strip/token 簿记。
 */
export async function doAutoCompact(host: CompactHost,
  scenario: "before_turn" | "mid_turn",
  signal?: AbortSignal,
  promptOverride?: string,
  hideCompactMarker = false,
  origin: CompactOrigin = promptOverride ? "manual" : "auto",
): Promise<CompactCommitResult> {
  if (origin === "auto") {
    const used = host._autoCompactCountThisTurn ?? 0;
    if (used >= MAX_AUTO_COMPACTS_PER_TURN) {
      throw new CompactTurnLimitError(MAX_AUTO_COMPACTS_PER_TURN);
    }
  }

  const originalTokens = host._lastTotalTokens;
  let archive: ArchiveWindowResult | null = null;
  let compactedTokens: number | undefined;
  let committed = false;
  let completed = false;

  try {
    host._progress?.onCompactStart(host.primaryAgent.name, origin === "manual" ? "manual" : scenario);

    // 在任何 compact phase 条目写入前提取，避免把压缩提示/回复当成“上一条消息”。
    const verbatimTail = buildVerbatimTail(host._log, scenario, origin);

    // 1-3: 生成 continuation；archive 与 checkpoint 尚未触碰内存。
    const continuationPrompt = await host._runCompactPhase(scenario, promptOverride, signal);
    const compactIndex = nextCompactIndex(host._log);
    const checkpointId = host._nextLogId("compact_marker");
    const contCtxId = host._allocateContextId();

    // 任务清单/运行体状态由运行时在每个请求的 ephemeral [RUNTIME STATE] 中提供，
    // 不再烘进 compact_context。
    const contContent = `${continuationPrompt}\n\n[Contexts before this point have been compacted.]${
      verbatimTail ? `\n\n${verbatimTail}` : ""
    }`;
    const compactContext = createCompactContext(
      host._nextLogId("compact_context"),
      host._turnCount,
      contContent,
      contCtxId,
      compactIndex,
    );
    compactedTokens = estimateEntryTokens(compactContext)
      + host._estimateStaticContextTokens()
      + (host._estimateEphemeralTailTokens?.() ?? 0);
    const { budget: workspaceBudget } = host._contextManager.budgetInfo();
    if (workspaceBudget <= 0 || workspaceBudget - compactedTokens < workspaceBudget * 0.4) {
      throw new CompactInsufficientWorkspaceError();
    }

    const compactMarker = createCompactMarker(
      checkpointId,
      host._turnCount,
      compactIndex,
      originalTokens,
      compactedTokens,
    );
    if (hideCompactMarker) {
      compactMarker.tuiVisible = false;
      compactMarker.displayKind = null;
    }

    // 4: archive 覆盖上一个 live marker 之后到当前末尾的全部条目。
    const previousMarkerIdx = previousLiveMarkerIndex(host._log);
    const archiveStartIdx = previousMarkerIdx >= 0 ? previousMarkerIdx + 1 : 1;
    const archiveEndIdx = host._log.length - 1;
    const sessionDir = host._store?.sessionDir as string | undefined;
    const hasArchivableEntries = archiveEndIdx >= archiveStartIdx
      && host._log.slice(archiveStartIdx, archiveEndIdx + 1).some((entry) => !entry.archived && !entry.discarded);
    if (hasArchivableEntries && !sessionDir) throw new CompactArchiveRequiredError();
    let archiveFile = "";
    let archiveIndexFile = "";
    let archivedIds: string[] = [];
    try {
      if (sessionDir && hasArchivableEntries) {
        archive = await archiveWindowById(
          sessionDir,
          checkpointId,
          host._log,
          archiveStartIdx,
          archiveEndIdx,
        );
        if (archive.ids.length === 0) {
          throw new Error("Archive window contained entries but produced no archive records.");
        }
        archiveFile = archive.archiveFile;
        archiveIndexFile = archive.archiveIndexFile;
        archivedIds = archive.ids;
      }
      if (archivedIds.length > 0 && !archiveFile) {
        throw new Error("Archive records must have a committed archive file.");
      }

      // 5: 唯一 commit point：marker + context 同条 checkpoint 记录。
      host._appendCompactCheckpoint(compactMarker, compactContext, {
        checkpointId,
        archiveFile,
        archiveIndexFile,
        compactIndex,
        scenario: origin === "manual" ? "manual" : scenario,
      });
      committed = true;
    } catch (error) {
      if (archive && sessionDir) {
        deleteArchiveFiles(sessionDir, archive.archiveFile, archive.archiveIndexFile);
      }
      throw error;
    }
    if (origin === "auto") {
      host._autoCompactCountThisTurn = (host._autoCompactCountThisTurn ?? 0) + 1;
    }

    // 6: 已提交；剩余动作失败只告警，不得回滚历史。
    applyCommittedCompact(host, {
      ids: archivedIds,
      checkpointId,
      archiveFile,
      compactIndex,
      originalTokens,
      compactedTokens,
      scenario,
    });

    // 7: 压后复检。仍超阈值时 checkpoint 已提交，错误必须带 committed 标记，
    // 调用方不得截断本次区间。
    const { budget } = host._contextManager.budgetInfo();
    const threshold = host._contextManager.thresholds.compact_mid_turn / 100;
    const postCompactTokens = host._estimateContextTokens()
      + (host._estimateEphemeralTailTokens?.() ?? 0);
    if (budget > 0 && postCompactTokens > threshold * budget) {
      throw new CompactDidNotReduceContextError();
    }

    completed = true;
    return { status: "committed", checkpointId, compactIndex };
  } finally {
    try {
      host._progress?.onCompactEnd(
        host.primaryAgent.name,
        origin === "manual" ? "manual" : scenario,
        originalTokens,
        compactedTokens,
        { status: completed ? "completed" : "failed", committed },
      );
    } catch (error) {
      warnPostCommit(host, `progress callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 压缩失败清理：物理截断本次尝试写入的连续尾部区间。
 * 只允许在未提交（checkpoint 尚未 append）时调用。
 */
export function discardCompactAttemptEntries(host: CompactHost, fromIndex: number): void {
  host._truncateCompactAttemptEntries(fromIndex);
}
