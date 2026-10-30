/**
 * 单次激活与激活循环：把一轮 provider 调用 + 工具排空串起来。
 *
 * 只搬"跑一轮、判终止、串多轮"这层；ask/压缩/工具排空各自在独立模块，
 * 通过 host 虚分派调用。
 */

import { isNoReply, NO_REPLY_MARKER } from "../agents/agent.js";
import type { Agent } from "../agents/agent.js";
import type { BeforeToolExecuteCallback, ResolveToolCallVisibilityCallback, ToolLoopResult } from "../agents/tool-loop/types.js";
import type { ToolExecutor } from "../tools/executor-types.js";
import { type HookRuntime } from "../hooks/index.js";
import {
  createAskRequest,
  createAssistantText,
  createReasoning,
  createStatus,
  createTokenUpdate,
} from "../context/entry/factories.js";
import { ContextTagStripBuffer } from "../context/context-tags.js";
import { NoReplyStreamBuffer } from "./no-reply-stream.js";
import { projectToApiMessages } from "../context/projection/api.js";
import type { LogEntry } from "../context/entry/types.js";
import { stripContextTags } from "../context/context-tags.js";
import { type ProgressLevel, type ProgressReporter } from "../logging/progress.js";
import type { AskRequest } from "../ask.js";
import type { SessionLog } from "./log.js";
import type { TurnLifecycleEvent } from "./turn-types.js";

const MAX_ACTIVATIONS_PER_TURN = 30;

/** 激活循环所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface ActivationHost {
  primaryAgent: Agent;
  hookRuntime: HookRuntime;
  onSaveRequest?: () => boolean;
  _log: LogEntry[];
  _logStore: SessionLog;
  _turnCount: number;
  _agentState: string;
  _activeAsk: AskRequest | null;
  _activeLogEntryId: string | null;
  _compactInProgress: boolean;
  _compactTerminatedThisTurn: boolean;
  _thinkingLevel: string;
  _promptCacheKey: string;
  _lastInputTokens: number;
  _lastTotalTokens: number;
  _lastCacheReadTokens: number;
  _cacheSupported: boolean;
  _lastToolCallSummary: string;
  _lifetimeToolCallCount: number;
  _lifecycleEndedEmitted: boolean;
  _progress?: ProgressReporter;
  _toolExecutors: Record<string, ToolExecutor>;
  _beforeToolExecute: BeforeToolExecuteCallback;
  _resolveToolCallVisibility: ResolveToolCallVisibilityCallback;
  _resolveSealedReasoningState?(value: unknown): unknown | null;
  _nextLogId(type: LogEntry["type"]): string;
  _appendEntry(entry: LogEntry, save?: boolean): void;
  _touchLog(): void;
  _allocateContextId(): string;
  _computeNextRoundIndex(turnIndex?: number): number;
  _setActiveLogEntry(entryId: string | null): void;
  _setSelfPhase(phase: unknown): void;
  _getSystemPrompt(): string;
  _resolveImageRef(refPath: string): { data: string; media_type: string } | null;
  _extractAndSaveImages(content: string | Array<Record<string, unknown>>): string | Array<Record<string, unknown>>;
  _recordSessionEvent(summary: string): void;
  _buildRuntimeStateBlock(): string;
  _emitTurnLifecycle(event: TurnLifecycleEvent): void;
  _recordTurnErrorEntry(err: unknown, opts?: unknown): void;
  _waitForAllChildTurnsSettled(): Promise<void>;
  _handleInterruption(logLen: number, text: string, opts: { activationCompleted: boolean }): void;
  _collectInterruptHints(): string[];
  _installCurrentTurnSignal(signal?: AbortSignal): { prevSignal: AbortSignal | null; prevController: AbortController | null; cleanup: () => void; signal: AbortSignal };
  _restoreCurrentTurnSignal(state: { prevSignal: AbortSignal | null; prevController: AbortController | null; cleanup: () => void }): void;
  _isCompactAbortError(err: unknown): boolean;
  _buildCompactCheck(): ((inputTokens: number, outputTokens: number, hasToolCalls: boolean) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined;
  _beginWorkIfNeeded(): string;
  _finishCurrentWork(status: "completed" | "interrupted" | "error", interruptHints?: string[]): void;
  _appendInterruptionSystemMessage(partialToolNames?: readonly string[], compactWasInterrupted?: boolean): void;
  _discardCompactAttemptEntries(fromIndex: number): void;
  _truncateCompactAttemptEntries(fromIndex: number): void;
  _doAutoCompact(
    scenario: "before_turn" | "mid_turn",
    signal?: AbortSignal,
    promptOverride?: string,
    hideCompactMarker?: boolean,
    origin?: "auto" | "manual",
  ): Promise<{ status: "committed"; checkpointId: string; compactIndex: number }>;
  _drainInboxAsEntries(): number;
  _findToolCallContextId(toolCallId: string, roundIndex?: number): string | undefined;
  _resolveOutputRoundContextId(turnIndex: number, roundIndex: number): string;
  _retagRoundEntries(turnIndex: number, roundIndex: number, contextId: string): void;
  _emitAskRequestedProgress(ask: unknown): void;
  _hasActiveAgents(): boolean;
  _hasInboxMessages(): boolean;
  _hasUnprocessedUserMessage(): boolean;
  _scheduleAutoResume(): void;
  // 同簇方法：模块内按 host.X(...) 虚分派调用
  _runActivation(
    activationTurnIndex: number,
    signal?: AbortSignal,
    textAccumulator?: { text: string },
    reasoningAccumulator?: { text: string },
    suppressStreaming?: boolean,
  ): Promise<ToolLoopResult>;
}

export async function runActivation(host: ActivationHost, 
  activationTurnIndex: number,
  signal?: AbortSignal,
  textAccumulator?: { text: string },
  reasoningAccumulator?: { text: string },
  suppressStreaming?: boolean,
): Promise<ToolLoopResult> {
  const baseRoundIndex = host._computeNextRoundIndex(activationTurnIndex);
  const streamedAssistantEntries = new Map<number, LogEntry>();
  const streamedReasoningEntries = new Map<number, LogEntry>();
  const textBuffers = new Map<number, NoReplyStreamBuffer>();
  const roundContextIds = new Map<number, string>();
  const getRoundContextId = (roundIndex: number): string => {
    let contextId = roundContextIds.get(roundIndex);
    if (!contextId) {
      contextId = host._allocateContextId();
      roundContextIds.set(roundIndex, contextId);
    }
    return contextId;
  };

  let onTextChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;
  let onReasoningChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;

  if (suppressStreaming) {
    // 压缩阶段：只累积文本，不向 TUI 流式输出
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
    const agentName = host.primaryAgent.name;
    const progress = host._progress;

    // 按轮次记录上一个 chunk 的类型：provider 交错返回 reasoning 与 text
    // 条目时（如 Responses API），每段连续内容各自生成 LogEntry，
    // 而不是全部并进首个 chunk 位置的 sticky 条目。
    let lastStreamKind: "reasoning" | "text" | null = null;
    let lastStreamRound = -1;

    onTextChunk = (roundIndex: number, chunk: string) => {
      // 同一轮内从 reasoning 切到 text：重建 buffer 与条目
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
          host._setSelfPhase("generating");

          const entry = streamedAssistantEntries.get(roundIndex);
          if (!entry) {
            const nextEntry = createAssistantText(
              host._nextLogId("assistant_text"),
              activationTurnIndex,
              roundIndex,
              cleanChunk,
              cleanChunk,
              getRoundContextId(roundIndex),
            );
            host._appendEntry(nextEntry, false);
            streamedAssistantEntries.set(roundIndex, nextEntry);
            host._setActiveLogEntry(nextEntry.id);
          } else {
            host._logStore.updateEntry(entry.id, (target) => {
              target.display += cleanChunk;
              target.content = String(target.content ?? "") + cleanChunk;
            });
            if (host._activeLogEntryId !== entry.id) {
              host._setActiveLogEntry(entry.id);
            }
          }
        });
        roundBuffer = new NoReplyStreamBuffer((cleanChunk: string) => stripBuf.feed(cleanChunk));
        textBuffers.set(roundIndex, roundBuffer);
      }
      roundBuffer.feed(chunk);
      // 检查流式回调是否真的创建或更新了日志条目
      return streamedAssistantEntries.has(roundIndex);
    };

    onReasoningChunk = (roundIndex: number, chunk: string) => {
      if (reasoningAccumulator) reasoningAccumulator.text += chunk;
      if (progress) progress.onReasoningChunk(agentName, chunk);
      host._setSelfPhase("thinking");

      // 同一轮内从 text 切到 reasoning：新建 reasoning 条目
      if (lastStreamRound === roundIndex && lastStreamKind === "text") {
        streamedReasoningEntries.delete(roundIndex);
      }
      lastStreamKind = "reasoning";
      lastStreamRound = roundIndex;

      const entry = streamedReasoningEntries.get(roundIndex);
      if (!entry) {
        const nextEntry = createReasoning(
          host._nextLogId("reasoning"),
          activationTurnIndex,
          roundIndex,
          chunk,
          chunk,
          undefined,
          getRoundContextId(roundIndex),
        );
        host._appendEntry(nextEntry, false);
        streamedReasoningEntries.set(roundIndex, nextEntry);
        host._setActiveLogEntry(nextEntry.id);
      } else {
        host._logStore.updateEntry(entry.id, (target) => {
          target.display += chunk;
          target.content = String(target.content ?? "") + chunk;
        });
        // 保持活跃指针指向这个 reasoning 条目
        if (host._activeLogEntryId !== entry.id) {
          host._setActiveLogEntry(entry.id);
        }
      }
      return true;
    };
  }

  // provider 结束 reasoning 流式输出后，把该 reasoning 条目标记为完成
  const onReasoningDone = (
    roundIndex: number,
    thinkingArtifact?: import("../thinking/artifact.js").ThinkingArtifact | null,
    reasoningState?: unknown,
  ) => {
    const entry = streamedReasoningEntries.get(roundIndex);
    if (entry) {
      host._logStore.updateEntry(entry.id, (target) => {
        const meta = target.meta as Record<string, unknown>;
        meta.reasoningComplete = true;
        if (reasoningState !== undefined) meta.reasoningState = reasoningState;
        if (thinkingArtifact) meta.thinkingArtifact = thinkingArtifact;
      });
      if (host._activeLogEntryId === entry.id) {
        host._activeLogEntryId = null;
      }
    }
  };

  let onToolCall: ((name: string, tool: string, args: Record<string, unknown>, summary: string) => void) | undefined;
  if (host._progress) {
    const step = host._turnCount;
    const progress = host._progress;

    onToolCall = (name: string, tool: string, args: Record<string, unknown>, summary: string) => {
      progress.onToolCall(step, name, tool, args, summary);
    };
  }
  const origOnToolCall = onToolCall;
  onToolCall = (name: string, tool: string, args: Record<string, unknown>, summary: string) => {
    origOnToolCall?.(name, tool, args, summary);
    host._setSelfPhase("tool_calling");
    host._lifetimeToolCallCount += 1;
    host._lastToolCallSummary = summary;
    host._recordSessionEvent(summary);
  };

  const onToolResult = (name: string, tool: string, toolCallId: string, isError: boolean, summary: string) => {
    if (host._progress) {
      host._progress.onToolResult(host._turnCount, name, tool, toolCallId, isError, summary);
    }
    // 触发 PostToolUse / PostToolUseFailure 钩子
    if (host.hookRuntime.hooks.length > 0) {
      const event = isError ? "PostToolUseFailure" : "PostToolUse";
      host.hookRuntime.fireAndForget(event, {
        event,
        timestamp: Date.now(),
        toolName: tool,
        toolCallId,
        agentId: name,
      });
    }
  };

  // 流式 tool call 回调——提前设置活跃条目，尽早显示
  const onToolCallPartialCb = (_callId: string, _name: string, _rawArguments: string) => {
    // 活跃条目的跟踪在 tool-loop 里由 appendEntry →_appendEntry 完成；
    // 这里找到刚追加的待执行 tool_call 条目并标记为活跃
    const lastEntry = host._log[host._log.length - 1];
    if (lastEntry && lastEntry.type === "tool_call") {
      host._setActiveLogEntry(lastEntry.id);
    }
  };

  // token 更新回调：每次 provider 调用后更新 _lastInputTokens，
  // 供 TUI 实时显示上下文占用。
  const onTokenUpdate = (inputTokens: number, usage?: import("../providers/response.js").Usage) => {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
      host._lastInputTokens = 0;
      host._lastTotalTokens = 0;
      host._lastCacheReadTokens = 0;
      host._cacheSupported = false;
      return;
    }
    host._lastInputTokens = inputTokens;
    host._lastTotalTokens = usage?.totalTokens ?? inputTokens;
    host._lastCacheReadTokens = usage?.cacheReadTokens ?? 0;
    host._cacheSupported = usage?.cacheSupported ?? false;
    // 累计统计由下面追加的 token_update 条目推导（见 _computeUsageStats），
    // 这里不需要再做累加。
    host._appendEntry(
      createTokenUpdate(
        host._nextLogId("token_update"),
        activationTurnIndex,
        inputTokens,
        usage?.cacheReadTokens,
        usage?.cacheCreationTokens,
        usage?.totalTokens,
        usage?.cacheSupported,
      ),
      false,
    );
    if (host._progress) {
      const extra: Record<string, unknown> = { input_tokens: inputTokens };
      if (usage) {
        extra["total_tokens"] = usage.totalTokens;
        if (usage.cacheReadTokens > 0) extra["cache_read_tokens"] = usage.cacheReadTokens;
        if (usage.cacheCreationTokens > 0) extra["cache_creation_tokens"] = usage.cacheCreationTokens;
      }
      host._progress.emit({
        step: host._turnCount,
        agent: host.primaryAgent.name,
        action: "token_update",
        message: "",
        level: "quiet" as ProgressLevel,
        timestamp: Date.now() / 1000,
        usage: { input_tokens: inputTokens },
        extra,
      });
    }
  };

  const agentName = host.primaryAgent.name;
  const emitRetryAttempt = (
    attempt: number,
    max: number,
    delaySec: number,
    errMsg: string,
    kind: "network" | "incomplete" = "network",
  ) => {
    const label = kind === "incomplete" ? "Response retry" : "Network retry";
    if (!host._compactInProgress) {
      const entry = createStatus(
        host._nextLogId("status"),
        activationTurnIndex,
        `[${label} ${attempt}/${max}] waiting ${delaySec}s: ${errMsg}`,
        "retry_attempt",
      );
      // 未完成回合的重试是异常事件，应该出现在对话记录里；网络重试仍只占状态栏。
      if (kind !== "incomplete") {
        entry.tuiVisible = false;
        entry.displayKind = null;
      }
      host._appendEntry(entry, false);
    }
    host._progress?.onRetryAttempt(agentName, attempt, max, delaySec, errMsg, kind);
  };
  const emitRetrySuccess = (attempt: number) => {
    if (!host._compactInProgress) {
      // 成功恢复后直接回到 Working，成功提示不占用对话记录。
      const entry = createStatus(
        host._nextLogId("status"),
        activationTurnIndex,
        "[Retry succeeded] attempt " + attempt,
        "retry_success",
      );
      entry.tuiVisible = false;
      entry.displayKind = null;
      host._appendEntry(entry, false);
    }
    host._progress?.onRetrySuccess(agentName, attempt);
  };
  const emitRetryExhausted = (
    max: number,
    errMsg: string,
    kind: "network" | "incomplete" = "network",
  ) => {
    // 耗尽后回合必然失败：错误条目由回合入口层统一写一次，
    // 这里只更新实时进度，避免同一文案在日志里出现两份。
    host._progress?.onRetryExhausted(agentName, max, errMsg, kind);
  };

  // v2：基于回调的消息管理
  // getMessages 通过 projectToApiMessages 从 _log 投影出消息。
  const getMessages = (): Array<Record<string, unknown>> => {
    const runtimeState = host._buildRuntimeStateBlock();
    const hookContext = host.hookRuntime.getAdditionalContext() ?? "";
    const ephemeralTail = [runtimeState, hookContext].filter(Boolean).join("\n\n");
    return projectToApiMessages(host._log, {
      systemPrompt: host._getSystemPrompt(),
      ephemeralTail: ephemeralTail || undefined,
      resolveImageRef: (refPath) => host._resolveImageRef(refPath),
      resolveReasoningState: host._resolveSealedReasoningState
        ? (value) => host._resolveSealedReasoningState!(value)
        : undefined,
      requiresAlternatingRoles: (host.primaryAgent as any)._provider?.requiresAlternatingRoles,
      enforceToolCallProtocol: true,
    });
  };

  const appendEntry = (entry: LogEntry): void => {
    if (host._compactInProgress) {
      entry.tuiVisible = false;
      entry.displayKind = null;
      (entry.meta as Record<string, unknown>)["compactPhase"] = true;
    }
    host._appendEntry(entry, false);
    if (
      entry.type === "tool_call"
      && entry.tuiVisible
      && !host._compactInProgress
      && entry.meta["toolExecState"] !== "completed"
      && entry.meta["toolExecState"] !== "failed"
      && (entry.meta["toolExecState"] === "running"
        || entry.meta["toolExecState"] === "not_started"
        || entry.meta["toolStreamState"] === "partial"
        || entry.meta["toolStreamState"] === "closed")
    ) {
      host._setActiveLogEntry(entry.id);
    }
  };

  const allocId = (type: LogEntry["type"]): string => {
    return host._nextLogId(type);
  };

  /** 就地更新已有日志条目（用于收尾待执行的 tool call 条目）。 */
  const updateEntryFn = (entryId: string, patch: {
    apiRole?: LogEntry["apiRole"];
    content?: unknown;
    display?: string;
    tuiVisible?: boolean;
    displayKind?: LogEntry["displayKind"];
    meta?: Record<string, unknown>;
  }): void => {
    // 约定：log-projection 里的耗时配对 memo 对每个条目只折叠一次——
    // timestamp、meta.toolCallId 和 meta.execStartMs 在追加时就已固定，
    // 不能在这里打补丁。
    const entry = host._logStore.findEntryById(entryId);
    if (!entry) return;
    host._logStore.updateEntry(entryId, (target) => {
      if (patch.apiRole !== undefined) target.apiRole = patch.apiRole;
      if (patch.content !== undefined) target.content = patch.content;
      if (patch.display !== undefined) target.display = patch.display;
      if (patch.tuiVisible !== undefined) target.tuiVisible = patch.tuiVisible;
      if (patch.displayKind !== undefined) target.displayKind = patch.displayKind;
      if (patch.meta !== undefined) target.meta = patch.meta;
    });
    if (entry.type === "tool_call" && !entry.tuiVisible) {
      if (host._activeLogEntryId === entry.id) {
        host._setActiveLogEntry(null);
      } else {
        host._touchLog();
      }
      return;
    }
    if (entry.type === "tool_call" && patch.meta) {
      const execState = patch.meta["toolExecState"];
      const streamState = patch.meta["toolStreamState"];
      // 先判断完成状态——执行结束优先于流式状态
      if (execState === "completed" || execState === "failed") {
        if (host._activeLogEntryId === entry.id) {
          host._setActiveLogEntry(null);
        } else {
          host._touchLog();
        }
        return;
      }
      if (
        execState === "running"
        || execState === "not_started"
        || streamState === "partial"
        || streamState === "closed"
      ) {
        if (host._activeLogEntryId !== entry.id) {
          host._setActiveLogEntry(entry.id);
        } else {
          host._touchLog();
        }
        return;
      }
    }
    host._touchLog();
  };

  /** 把日志条目标记为已丢弃（供重试时清理）。 */
  const discardEntryFn = (entryId: string): void => {
    const entry = host._logStore.findEntryById(entryId);
    if (!entry) return;
    host._logStore.updateEntry(entryId, (target) => {
      target.discarded = true;
      target.tuiVisible = false;
    });
  };

  return host.primaryAgent.asyncRunWithMessages({
    getMessages,
    appendEntry,
    allocId,
    turnIndex: activationTurnIndex,
    baseRoundIndex,
    toolExecutors: host._toolExecutors,
    onToolCall,
    onToolResult,
    onTextChunk,
    onReasoningChunk,
    onReasoningDone,
    signal,
    contextIdAllocator: (roundIndex) => getRoundContextId(roundIndex),
    toolContextIdAllocator: () => host._allocateContextId(),
    externalizeContentBlocks: (blocks) => {
      const result = host._extractAndSaveImages(blocks);
      return Array.isArray(result) ? result : blocks;
    },
    compactCheck: host._buildCompactCheck(),
    onTokenUpdate,
    onProviderResponse: () => host.hookRuntime.clearNextRoundContext(),
    thinkingLevel: host._thinkingLevel,
    promptCacheKey: host._promptCacheKey,
    onSaveCheckpoint: host._compactInProgress ? undefined : (() => host.onSaveRequest?.()),
    beforeToolExecute: host._beforeToolExecute,
    suppressAsks: host._compactInProgress,
    getNotification: () => null,
    // 轮次边界的 inbox 排空。压缩期间禁用：压缩中途排空的消息会落在
    // 即将写入的 compact_marker 之前，之后对模型不可见（Q6）。
    onToolRoundComplete: () => {
      if (!host._compactInProgress) host._drainInboxAsEntries();
    },
    streamCallbacksOwnEntries: !suppressStreaming,
    onRetryAttempt: emitRetryAttempt,
    onRetrySuccess: emitRetrySuccess,
    onRetryExhausted: emitRetryExhausted,
    onToolCallPartial: onToolCallPartialCb,
    resolveToolCallVisibility: host._resolveToolCallVisibility,
    updateEntry: updateEntryFn,
    discardEntry: discardEntryFn,
  });
}

export async function runTurnActivationLoop(host: ActivationHost, 
  signal: AbortSignal | undefined,
  textAccumulator: { text: string },
  reasoningAccumulator: { text: string },
): Promise<string> {
  let finalText = "";
  let turnEndStatus: "completed" | "interrupted" | "error" | null = null;
  let loopError: string | null = null;
  const turnSignalState = host._installCurrentTurnSignal(signal);
  const activeSignal = turnSignalState.signal;
  host._beginWorkIfNeeded();
  host._emitTurnLifecycle({ phase: "started", turnIndex: host._turnCount });
  try {
    let reachedLimit = true;
    for (let activationIdx = 0; activationIdx < MAX_ACTIVATIONS_PER_TURN; activationIdx++) {
      if (activeSignal.aborted) break;

      const t0 = performance.now();
      const logLenBeforeActivation = host._log.length;
      textAccumulator.text = "";
      reasoningAccumulator.text = "";
      host._agentState = "working";
      host._setSelfPhase("thinking");

      // 每次激活只捕获一次 turn index。本次激活产生的所有日志条目
      //（流式/收尾的 reasoning 与 text、tool call、ask、status）必须共用它。
      // 排队的用户消息被排空进同一工作生命周期时，`host._turnCount` 可能在
      // 途中推进；实时读取会把同一 provider 轮次的 reasoning 和 tool_calls
      // 拆到两个 turn index（见 projectToApiMessages 的分组逻辑），
      // 生成退化的 assistant 消息。
      const activationTurnIndex = host._turnCount;

      if (host._progress) {
        host._progress.onAgentStart(activationTurnIndex, host.primaryAgent.name);
      }

      let result: ToolLoopResult;
      try {
        result = await host._runActivation(activationTurnIndex, activeSignal, textAccumulator, reasoningAccumulator);
      } catch (err: unknown) {
        if (activeSignal.aborted) {
          host._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
            activationCompleted: false,
          });
          host.onSaveRequest?.();
          finalText = textAccumulator.text.trim() || "";
          turnEndStatus = "interrupted";
          reachedLimit = false;
          break;
        }

        throw err;
      }

      // 成功完成后再检查中止——有些 provider 不会抛 AbortError
      //（流在 abort 生效前就已结束）。
      if (activeSignal.aborted) {
        host._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
          activationCompleted: true,
        });
        host.onSaveRequest?.();
        finalText = textAccumulator.text.trim() || "";
        turnEndStatus = "interrupted";
        reachedLimit = false;
        break;
      }

      if (Number.isFinite(result.lastInputTokens) && result.lastInputTokens > 0) {
        host._lastInputTokens = result.lastInputTokens;
        host._lastTotalTokens = result.lastTotalTokens ?? result.lastInputTokens;
      }
      if (result.suspendedAsk) {
        result.suspendedAsk.ask.turnIndex = activationTurnIndex;
        const askContextId =
          host._findToolCallContextId(result.suspendedAsk.toolCallId, result.suspendedAsk.roundIndex);
        host._activeAsk = result.suspendedAsk.ask;
        host._emitAskRequestedProgress(host._activeAsk);
        host._appendEntry(createAskRequest(
          host._nextLogId("ask_request"),
          activationTurnIndex,
          host._activeAsk!.payload,
          host._activeAsk!.id,
          host._activeAsk!.kind,
          result.suspendedAsk.toolCallId,
          result.suspendedAsk.roundIndex,
          askContextId,
        ), false);
        host.onSaveRequest?.();
        reachedLimit = false;
        break;
      }

      const elapsed = (performance.now() - t0) / 1000;
      let agentEndEmitted = false;

      const emitAgentEndOnce = () => {
        if (agentEndEmitted || !host._progress) return;
        host._progress.onAgentEnd(
          host._turnCount,
          host.primaryAgent.name,
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
        // 去掉 <NO_REPLY> 标记（若有），按空响应处理。
        // 发出进度事件，让 TUI 显示状态提示。
        if (_trimmedText.endsWith(NO_REPLY_MARKER)) {
          result.text = _trimmedText
            .slice(0, _trimmedText.length - NO_REPLY_MARKER.length)
            .trim();
        }

        if (host._progress) {
          host._progress.onNoReplyClear(host.primaryAgent.name);
        }
        emitAgentEndOnce();
        if (host._progress) {
          host._progress.onAgentNoReply(host.primaryAgent.name);
        }
        // 落到正常响应处理——回合自然结束。
      }

      if (result.text) {
        finalText = result.text;

        // v2 日志：创建最终的 assistant_text 和可选的 reasoning 条目
        {
          const finalRound = (result.textHandledInLog || result.reasoningHandledInLog)
            ? Math.max(0, host._computeNextRoundIndex(activationTurnIndex) - 1)
            : host._computeNextRoundIndex(activationTurnIndex);
          const finalContextId = host._resolveOutputRoundContextId(activationTurnIndex, finalRound);
          if (result.textHandledInLog || result.reasoningHandledInLog) {
            host._retagRoundEntries(activationTurnIndex, finalRound, finalContextId);
          }
          if (result.reasoningContent && !result.reasoningHandledInLog) {
            host._appendEntry(createReasoning(
              host._nextLogId("reasoning"),
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
            host._appendEntry(createAssistantText(
              host._nextLogId("assistant_text"),
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
      host.onSaveRequest?.();

      if (result.compactNeeded && result.compactScenario) {
        if (host._hasInboxMessages()) {
          host._drainInboxAsEntries();
        }
        const logLenBefore = host._log.length;
        try {
          await host._doAutoCompact(result.compactScenario!, activeSignal);
        } catch (compactErr) {
          const compactCommitted = Boolean(
            compactErr
            && typeof compactErr === "object"
            && (compactErr as { committed?: unknown }).committed === true,
          );
          if (!compactCommitted) {
            host._truncateCompactAttemptEntries(logLenBefore);
          }
          if (compactCommitted && (compactErr as { code?: unknown })?.code === "E_COMPACT_NO_REDUCTION") {
            host._compactTerminatedThisTurn = true;
          }
          if (activeSignal.aborted || host._isCompactAbortError(compactErr)) {
            host._appendInterruptionSystemMessage([], true);
            host._recordSessionEvent("interrupted by user");
            host.onSaveRequest?.();
            finalText = textAccumulator.text.trim() || "";
            turnEndStatus = "interrupted";
            reachedLimit = false;
            break;
          }
          throw compactErr;
        }
        // 压缩期间暂扣的消息（Q6）落在 marker 之后。
        if (host._hasInboxMessages()) {
          host._drainInboxAsEntries();
        }
        host.onSaveRequest?.();
        // 压缩后总是继续——上下文是新的，激活预算也重置。
        activationIdx = -1;
        continue;
      }

      // 助手输出最终文本期间输入的消息，
      // 在同一工作生命周期里成为模型的下一次输入。
      if (host._hasInboxMessages()) {
        host._drainInboxAsEntries();
        continue;
      }

      // 最终输出（最后一次 provider 调用没有 tool call）→回合结束。
      // 子代理结果通过新回合里的 auto-resume 处理。
      // 模型应显式使用 await_event 等待子代理。
      // 注意：toolHistory.length 在工具循环的所有轮次间累计，
      // 即使最后一次调用没有 tool_calls 也可能 > 0。
      if (result.endedWithoutToolCalls) {
        reachedLimit = false;
        turnEndStatus = "completed";
        break;
      }
      // 这里不再单独做边界排空——上文那次检查
      // 已在决定 break 之前处理了 inbox 消息。
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
    // 非中止类错误逃出循环（provider 失败、轮中压缩、排空）时，回合以
    // "error" 收尾。可见的错误日志条目由入口层的 catch 按逃逸路径
    // 恰好写一次（_turnInner / _resumeActivationStage）。
    const aborted = activeSignal.aborted;
    if (!aborted) {
      loopError = err instanceof Error ? err.message : String(err);
      turnEndStatus = "error";
    }
    throw err;
  } finally {
    host._restoreCurrentTurnSignal(turnSignalState);
    if (turnEndStatus === "interrupted" && host._hasActiveAgents()) {
      await host._waitForAllChildTurnsSettled();
    }
    // 状态机没走完就不能当作成功。provider 或执行器可能不抛错就结束
    //（例如流意外中断），没有留下明确的终止状态。除非信号是被主动中止的，
    // 否则这条路径按错误处理。
    if (!host._activeAsk && turnEndStatus === null) {
      if (activeSignal.aborted) {
        turnEndStatus = "interrupted";
      } else {
        turnEndStatus = "error";
        loopError ??= "Turn ended without a terminal status.";
        host._recordTurnErrorEntry(loopError);
      }
    }
    // 挂起的 ask 让会话停在 "waiting"（Q1）：回合没结束，只是等着用户回答。
    // 此时到达的输入必须排队，不能推进回合计数。
    host._agentState = host._activeAsk ? "waiting" : "idle";
    // 收尾卡在非终态的 tool_call 条目（例如 await_event 期间被中止）。
    // 从后往前扫：只有当前轮的 tool_call 会受影响；看到至少一个 tool_call 后，
    // 遇到第一个非 tool_call 条目就停（条目间夹杂 tool_result、token_update 等，跳过即可）。
    {
      let sawToolCall = false;
      for (let i = host._log.length - 1; i >= 0; i--) {
        const entry = host._log[i];
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
    host._activeLogEntryId = null;
    host._setSelfPhase("idle");
    if (!host._activeAsk && host._turnCount > 0 && turnEndStatus) {
      let interruptHints: string[] | undefined;
      if (turnEndStatus === "interrupted") {
        interruptHints = host._collectInterruptHints();
      }
      host._finishCurrentWork(turnEndStatus, interruptHints);
    }
    // 若 finally 里的排空往日志写了消息而模型没看到，
    // 安排一个 auto-resume 回合来处理。
    if (!host._activeAsk && !host._compactTerminatedThisTurn && host._hasUnprocessedUserMessage()) {
      host._scheduleAutoResume();
    }
    host._lifecycleEndedEmitted = true;
    host._emitTurnLifecycle({
      phase: "ended",
      turnIndex: host._turnCount,
      status: host._activeAsk
        ? "waiting"
        : turnEndStatus ?? "error",
      ...(loopError !== null && !host._activeAsk ? { error: loopError } : {}),
    });
  }

  return finalText;
}
