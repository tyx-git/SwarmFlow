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
  createError as createErrorEntry,
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
  _recordSessionEvent(summary: string): void;
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
  _doAutoCompact(scenario: "before_turn" | "mid_turn", signal?: AbortSignal, promptOverride?: string, hideCompactMarker?: boolean): Promise<void>;
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
    const agentName = host.primaryAgent.name;
    const progress = host._progress;

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
      // Check if the streaming callback actually created/updated a log entry
      return streamedAssistantEntries.has(roundIndex);
    };

    onReasoningChunk = (roundIndex: number, chunk: string) => {
      if (reasoningAccumulator) reasoningAccumulator.text += chunk;
      if (progress) progress.onReasoningChunk(agentName, chunk);
      host._setSelfPhase("thinking");

      // If switching from text →reasoning in same round, start a new reasoning entry
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
        // Keep active tracker pointing to this reasoning entry
        if (host._activeLogEntryId !== entry.id) {
          host._setActiveLogEntry(entry.id);
        }
      }
      return true;
    };
  }

  // Mark reasoning entry as complete when the provider finishes streaming reasoning
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
    // Fire PostToolUse / PostToolUseFailure hooks
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

  // Streaming tool call callbacks —set active entry for early display
  const onToolCallPartialCb = (_callId: string, _name: string, _rawArguments: string) => {
    // Active entry tracking happens in tool-loop via appendEntry →_appendEntry;
    // we find the just-appended pending tool_call entry and mark it active
    const lastEntry = host._log[host._log.length - 1];
    if (lastEntry && lastEntry.type === "tool_call") {
      host._setActiveLogEntry(lastEntry.id);
    }
  };

  // Token update callback: update _lastInputTokens after each provider call
  // so the TUI can display real-time context usage.
  const onTokenUpdate = (inputTokens: number, usage?: import("../providers/response.js").Usage) => {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;
    host._lastInputTokens = inputTokens;
    host._lastTotalTokens = usage?.totalTokens ?? inputTokens;
    host._lastCacheReadTokens = usage?.cacheReadTokens ?? 0;
    host._cacheSupported = usage?.cacheSupported ?? false;
    // Cumulative stats are derived from the token_update entry appended below
    // (see _computeUsageStats), so there is nothing to accumulate here.
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
    const label = kind === "incomplete" ? "Response retry exhausted" : "Network retry exhausted";
    if (!host._compactInProgress) {
      host._appendEntry(
        createErrorEntry(
          host._nextLogId("error"),
          activationTurnIndex,
          `[${label} after ${max} attempts] ${errMsg}`,
          "retry_exhausted",
        ),
        false,
      );
    }
    host._progress?.onRetryExhausted(agentName, max, errMsg, kind);
  };

  // v2: callback-based message management
  // getMessages projects from _log via projectToApiMessages.
  const getMessages = (): Array<Record<string, unknown>> => {
    return projectToApiMessages(host._log, {
      systemPrompt: host._getSystemPrompt(),
      ephemeralTail: host.hookRuntime.getAdditionalContext() ?? undefined,
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
      // Check completion first —exec finished takes priority over stream state
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

  /** Mark a log entry as discarded (for cleanup on retry). */
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
    compactCheck: host._buildCompactCheck(),
    onTokenUpdate,
    onProviderResponse: () => host.hookRuntime.clearNextRoundContext(),
    thinkingLevel: host._thinkingLevel,
    promptCacheKey: host._promptCacheKey,
    onSaveCheckpoint: host._compactInProgress ? undefined : (() => host.onSaveRequest?.()),
    beforeToolExecute: host._beforeToolExecute,
    suppressAsks: host._compactInProgress,
    getNotification: () => null,
    // Round-boundary inbox drain. Suppressed during compact: anything
    // drained mid-compact would land before the upcoming compact_marker
    // and be hidden from the model afterwards (Q6).
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

      // Capture the turn index ONCE per activation. Every log entry produced
      // by this activation (streamed/finalized reasoning + text, tool calls,
      // ask, status) must share it. `host._turnCount` can advance mid-flight
      // when a queued user message is drained into this same work lifecycle;
      // reading it live would split a single provider round's reasoning from
      // its tool_calls across two turn indices (see projectToApiMessages
      // grouping), producing a degenerate assistant message.
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

      // Check abort AFTER successful completion —handles providers that
      // don't throw AbortError (stream finishes before abort takes effect).
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
        // Strip the <NO_REPLY> marker (if present) —treat as empty response.
        // Emit progress event so TUI can show a status message.
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
        // Fall through to normal response handling —turn ends naturally.
      }

      if (result.text) {
        finalText = result.text;

        // v2 log: create final assistant_text + optional reasoning entries
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
          host._discardCompactAttemptEntries(logLenBefore);
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
        // Messages held back during compact (Q6) land after the marker.
        if (host._hasInboxMessages()) {
          host._drainInboxAsEntries();
        }
        host.onSaveRequest?.();
        // Always continue after compact —fresh context, reset activation budget.
        activationIdx = -1;
        continue;
      }

      // Messages typed while the assistant was producing a final text reply
      // become the next model input in the same work lifecycle.
      if (host._hasInboxMessages()) {
        host._drainInboxAsEntries();
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
    // (_turnInner / _resumeActivationStage).
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
    // Never infer success from an incomplete state machine. A provider or
    // executor may finish without throwing (for example, a stream can end
    // unexpectedly), leaving no explicit terminal status. Treat that path
    // as an error unless the signal was deliberately aborted.
    if (!host._activeAsk && turnEndStatus === null) {
      if (activeSignal.aborted) {
        turnEndStatus = "interrupted";
      } else {
        turnEndStatus = "error";
        loopError ??= "Turn ended without a terminal status.";
        host._recordTurnErrorEntry(loopError);
      }
    }
    // A suspended ask keeps the session in "waiting" (Q1): the turn has not
    // ended, it is parked on the user's answer. Input arriving now must
    // queue without advancing the turn counter.
    host._agentState = host._activeAsk ? "waiting" : "idle";
    // Finalize tool_call entries stuck in non-terminal state (e.g. abort during await_event).
    // Scan backward: only the current round's tool_calls can be affected; stop at the first
    // non-tool_call entry after seeing at least one tool_call (entries are interleaved with
    // tool_result, token_update, etc. so we skip those).
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
    // If the finally drain wrote messages to the log without the model
    // seeing them, schedule an auto-resume turn to process them.
    if (!host._activeAsk && host._hasUnprocessedUserMessage()) {
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
