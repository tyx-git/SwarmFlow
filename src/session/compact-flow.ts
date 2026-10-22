/**
 * 手动/自动压缩：执行 compact phase、丢弃失败尝试、并发保护。
 *
 * 只搬"何时压缩、压缩阶段怎么跑、失败如何回滚"这层；
 * 激活循环（`_runActivation`）与轮次锁仍在 Session，通过 host 虚分派调用。
 */

import type { Agent } from "../agents/agent.js";
import type { ToolLoopResult } from "../agents/tool-loop/types.js";
import { createAssistantText, createCompactContext, createCompactMarker, createReasoning } from "../context/entry/factories.js";
import { archiveWindow } from "../config/archive.js";
import { appendManualInstruction, COMPACT_PROMPT_OUTPUT, COMPACT_PROMPT_TOOLCALL } from "./prompts.js";
import { createUserMessage as createUserMessageEntry } from "../context/entry/factories.js";

const MAX_COMPACT_PHASE_ROUNDS = 10;
import { formatTaskSnapshot } from "../tasks/snapshot.js";
import type { LogEntry } from "../context/entry/types.js";
import type { SessionStore } from "../config/session-store.js";
import type { ContextManager } from "./context-manager.js";
import type { ProgressReporter } from "../logging/progress.js";
import type { Task } from "../tasks/types.js";
import { type LogSurgery } from "./log-surgery.js";
import type { AskRequest } from "../ask.js";

/** 压缩流程所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface CompactHost {
  primaryAgent: Agent;
  onSaveRequest?: () => void | boolean;
  _store: SessionStore | undefined;
  _log: LogEntry[];
  _turnCount: number;
  _compactCount: number;
  _compactInProgress: boolean;
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
  _doAutoCompact(scenario: "before_turn" | "mid_turn", signal?: AbortSignal, promptOverride?: string, hideCompactMarker?: boolean): Promise<void>;
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
    // In-lock catch —see runInjectedCommand for why it cannot sit outside.
    try {
      return await host._runManualCompactBody(instruction, options);
    } catch (err) {
      host._recordTurnFailure(err, options?.signal);
      throw err;
    }
  });
}

/** Body of runManualCompact. Caller holds the turn lock. */
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
      );
      host.onSaveRequest?.();
      host._finishCurrentWork("completed");
      if (options?.completionDisplay) {
        host.appendCommandEcho(options.completionDisplay, "switch", "worked");
      }
    } catch (err) {
      // 压缩尝试期间写入的全部条目都不可信（meta 可能被 updateEntry 整体
      // 替换），统一按索引区间丢弃；abort 与非 abort 同规则。
      host._discardCompactAttemptEntries(logLenBeforeCompact);
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
    // Waking messages held back during compact (Q6) get their delivery turn
    // now that the session is idle again.
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
 * Run the compact phase: inject compact prompt, let the Agent produce
 * a continuation prompt (possibly using tools), then return it.
 */
export async function runCompactPhase(host: CompactHost, 
  scenario: "before_turn" | "mid_turn",
  promptOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  host._compactInProgress = true;

  // Emit compact_start event
  if (host._progress) {
    host._progress.onCompactStart(host.primaryAgent.name, scenario);
  }

  // Inject compact prompt as user_message entry (compactPhase, invisible in TUI)
  const prompt = promptOverride ?? (scenario === "before_turn" ? COMPACT_PROMPT_OUTPUT : COMPACT_PROMPT_TOOLCALL);
  const compactPromptEntry = createUserMessageEntry(
    host._nextLogId("user_message"),
    host._turnCount,
    "",  // not visible in TUI
    prompt,
    host._allocateContextId(),
  );
  compactPromptEntry.tuiVisible = false;
  (compactPromptEntry.meta as Record<string, unknown>)["compactPhase"] = true;
  host._appendEntry(compactPromptEntry, false);

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
      continuationPrompt = "[Compact phase did not produce a continuation prompt.]";
    }
  } finally {
    host._compactInProgress = false;
  }

  return continuationPrompt;
}

/**
 * Execute auto-compact: run compact phase, then reconstruct conversation
 * with marker + system prompt + continuation prompt.
 */
export async function doAutoCompact(host: CompactHost, 
  scenario: "before_turn" | "mid_turn",
  signal?: AbortSignal,
  promptOverride?: string,
  hideCompactMarker = false,
): Promise<void> {
  const originalTokens = host._lastTotalTokens;

  // Run compact phase
  const continuationPrompt = await host._runCompactPhase(scenario, promptOverride, signal);

  const contCtxId = host._allocateContextId();
  host._compactCount += 1;

  // v2 log: compact_marker + compact_context entries (source of truth)
  const compactMarker = createCompactMarker(
    host._nextLogId("compact_marker"),
    host._turnCount,
    host._compactCount - 1,
    originalTokens,
    0, // compactedTokens not yet known
  );
  if (hideCompactMarker) {
    compactMarker.tuiVisible = false;
    compactMarker.displayKind = null;
  }
  host._appendEntry(compactMarker, false);
  const currentMarkerIdx = host._log.length - 1;
  // 任务清单在磁盘上（tasks.json 为权威），压缩后必须重新注入一次，
  // 否则新实例会看不到当前任务与依赖状态。
  const taskSnapshot = formatTaskSnapshot(host.getTaskState());
  const taskSuffix = taskSnapshot ? `\n\n${taskSnapshot}` : "";
  const contContent = `${continuationPrompt}\n\n[Contexts before this point have been compacted.]${taskSuffix}`;
  host._appendEntry(
    createCompactContext(
      host._nextLogId("compact_context"),
      host._turnCount,
      contContent,
      contCtxId,
      host._compactCount - 1,
    ),
    false,
  );

  const sessionDir = host._store?.sessionDir as string | undefined;
  if (sessionDir) {
    let previousMarkerIdx = -1;
    for (let i = currentMarkerIdx - 1; i >= 0; i--) {
      if (host._log[i].type === "compact_marker" && !host._log[i].discarded) {
        previousMarkerIdx = i;
        break;
      }
    }
    const archiveStartIdx = previousMarkerIdx >= 0 ? previousMarkerIdx + 1 : 1;
    const archiveEndIdx = currentMarkerIdx - 1;
    if (archiveEndIdx >= archiveStartIdx) {
      archiveWindow(
        sessionDir,
        host._compactCount - 1,
        host._log,
        archiveStartIdx,
        archiveEndIdx,
      );
      // Stripping window content is TUI-projection-visible.
      host._touchLog();
    }
  }

  // 压缩后旧上下文已被替换：per-response 快照必须清零，否则下一回合的
  // before-turn 判断仍按压缩前的输入大小触发，导致连续压缩。累计用量
  // 仍由日志中的 token_update 求和，不受此重置影响。
  host._lastInputTokens = 0;
  host._lastTotalTokens = 0;
  host._lastCacheReadTokens = 0;
  host._cacheSupported = false;

  // Emit compact_end event
  if (host._progress) {
    host._progress.onCompactEnd(host.primaryAgent.name, scenario, originalTokens);
  }
}

/**
 * 压缩失败清理：丢弃本次压缩尝试写入的全部条目（索引区间即事实来源）。
 * 不能只看 meta.compactPhase：tool-loop 同步工具状态时会用 updateEntry
 * 整体替换 meta，标记会丢失，留下的半截 tool_call 会破坏 API 投影。
 * 调用方必须在追加失败/中断记录之前调用。
 */
export function discardCompactAttemptEntries(host: CompactHost, fromIndex: number): void {
  for (let i = fromIndex; i < host._log.length; i++) {
    const entry = host._log[i];
    if (!entry || entry.discarded) continue;
    entry.discarded = true;
  }
}
