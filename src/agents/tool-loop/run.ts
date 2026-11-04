/**
 * Agent 共享的 tool loop 逻辑。
 *
 * 提供异步 LLM <-> tool 往返循环。调用 provider，执行 tool call，
 * 通过回调追加结果，重复直到模型不再调用工具或达到最大轮数。
 *
 * v2 设计：通过回调（getMessages / appendEntry）而非直接修改 provider 消息。
 * 后端存储可以是结构化会话日志（主 Agent）或临时结构化日志（子 Agent / 无状态运行）。
 *
 * 核心概念：
 * - PendingToolCallState：跟踪每个进行中的 tool call（参数流式传输、
 *   执行状态与 TUI 可见性）
 * - 顺序排出：已提交的 tool call 按发射顺序执行；挂起的 ask 暂停排出，
 *   以保证审批语义正确
 * - Compact：可在任意 provider 调用后触发中途压缩，返回 compactNeeded=true
 */

import type { ProviderResponse, ToolResult } from "../../providers/response.js";
import type { ToolCall, ToolDef } from "../../providers/types.js";
import { ToolResult as ToolResultClass } from "../../providers/response.js";
import {
  isRetryableNetworkError,
  isTurnIncompleteError,
  computeRetryDelay,
  computeIncompleteRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
  MAX_INCOMPLETE_TURN_RETRIES,
  TurnIncompleteError,
} from "../../network/retry.js";

import { buildToolResultPreview, generateToolCallDisplay, generateToolSummary } from "./display.js";
import { type PendingToolCallState, extractCompleteFlatArgs, parsePartialFlatObject } from "./streaming-arguments.js";
import { type ToolCallTuiVisibility, type ToolLoopOptions, type ToolLoopResult, type ToolPreflightDecision } from "./types.js";

/** 压缩阶段（suppressAsks）把审批/挂起类工具调用就地降级为该 ERROR 结果。 */
const COMPACT_ASK_DENY_MESSAGE =
  "ERROR: Tool approvals are unavailable during compaction; respond with the continuation prompt only.";
import { createReasoning, createAssistantText, createToolCall, createToolResult as createToolResultEntry } from "../../context/entry/factories.js";
import { resolveRoundPayloads } from "../../tools/patch-payload.js";
import type { ThinkingArtifact } from "../../thinking/artifact.js";
import type { AskRequest } from "../../ask.js";

// ------------------------------------------------------------------
// 工具执行器类型
// ------------------------------------------------------------------

/** 流式参数的解析/TUI 同步间隔；每 chunk 重建是平方级分配。 */
const PARTIAL_STREAM_UPDATE_INTERVAL_MS = 100;
/** 参数小于该阈值时逐 chunk 更新（成本可忽略，保持小工具的即时预览）。 */
const PARTIAL_STREAM_ALWAYS_UPDATE_BYTES = 4 * 1024;


// ------------------------------------------------------------------
// 工具摘要 / 显示帮助函数
// ------------------------------------------------------------------

/** 构建工具调用的 metadata 对象。 */
function buildToolCallMeta(
  base: { toolCallId: string; toolName: string; agentName: string; contextId?: string },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    toolCallId: base.toolCallId,
    toolName: base.toolName,
    agentName: base.agentName,
  };
  if (base.contextId !== undefined) meta.contextId = base.contextId;
  if (extra) Object.assign(meta, extra);
  return meta;
}

/** 根据 ToolDef.tuiPolicy.partialReveal 解析工具调用默认可见性。 */
function resolveDefaultToolCallTuiVisibility(
  toolDef: ToolDef | undefined,
  toolArgs: Record<string, unknown>,
  isClosed: boolean,
): ToolCallTuiVisibility {
  const policy = toolDef?.tuiPolicy?.partialReveal ?? "immediate";
  if (policy === "immediate") return "show";
  if (policy === "closed") return isClosed ? "show" : "defer";
  const ready = policy.completeArgs.every((key) => Object.prototype.hasOwnProperty.call(toolArgs, key));
  return ready || isClosed ? "show" : "defer";
}

// ------------------------------------------------------------------
// 未完成回合判定
// ------------------------------------------------------------------

/**
 * 判定一次 provider 响应是否"响应了、但这一轮没跑完"。
 *
 * 三种缺陷都必须重掷，否则半截 JSON 或空文本会以"正常完成"的姿态写进日志：
 * - `max_tokens` 截断：工具参数只剩半个 JSON。Anthropic 适配器压根不会为
 *   被截断的块发出 closed 事件，OpenAI 则给出 parseError——两种情况都不能
 *   让半成品进入执行。
 * - 无终止状态：断流（`stopReason === "incomplete_stream"`），或参数流没有
 *   闭合事件。
 * - 空响应：既没有文本也没有任何已提交的 tool call。
 *
 * 返回 null 表示这一轮可信，可以继续。
 */
function detectTurnDefect(
  resp: ProviderResponse,
  pendingToolCalls: Map<string, PendingToolCallState>,
): TurnIncompleteError | null {
  const pendings = Array.from(pendingToolCalls.values());
  const hasCommittedToolCalls = pendings.some((pending) => Boolean(pending.closedCall));
  const unclosed = pendings.find(
    (pending) => !pending.closedCall && pending.rawArguments.trim().length > 0,
  );

  if (resp.stopReason === "max_tokens") {
    return new TurnIncompleteError(
      hasCommittedToolCalls || unclosed
        ? "Provider output was truncated at max_tokens; tool call arguments are incomplete. Raise the model's max_tokens and retry."
        : "Provider output was truncated at max_tokens; the turn did not complete. Raise the model's max_tokens and retry.",
    );
  }
  if (resp.stopReason === "incomplete_stream") {
    // 事件数把"网关压根没回 event-stream"和"流到一半被截断"分开了：前者重掷
    // 同一请求永远一样失败（多半是 base_url 少了 /v1），后者才值得再赌一次。
    if (resp.streamEventCount === null) {
      return new TurnIncompleteError(
        "Provider stream ended without a terminal status; the turn did not complete.",
      );
    }
    return new TurnIncompleteError(resp.streamEventCount === 0
      ? "Provider stream ended without a terminal status after 0 SSE events; the endpoint returned no event-stream body (check the provider base_url)."
      : `Provider stream ended without a terminal status after ${resp.streamEventCount} SSE events; the turn did not complete.`);
  }
  if (unclosed) {
    return new TurnIncompleteError(
      `Provider stream ended before tool call "${unclosed.name}" was closed; the turn did not complete.`,
    );
  }
  if (!hasCommittedToolCalls && !resp.text.trim()) {
    return new TurnIncompleteError(
      "Provider returned an empty response; the turn did not complete.",
    );
  }
  return null;
}

// ------------------------------------------------------------------
// ToolLoopResult
// ------------------------------------------------------------------

/**
 * 异步工具循环：调用 LLM，执行工具，重复直到完成。
 *
 * 工具执行器接收参数字典，可能是同步或异步的。
 * 异常被捕获并作为错误 ToolResult 内容返回。
 */
export async function asyncRunToolLoop(
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  // 诊断：在主要循环入口加 trace，便于 native panic 时关联最后调用栈。
  try {
    const { getLogger } = await import("../../logging/logger.js");
    getLogger("tool-loop").info("asyncRunToolLoop:enter", {
      agent: opts.agentName,
      turn: opts.turnIndex,
      tools: opts.tools?.length ?? 0,
      maxRounds: opts.maxRounds,
    });
  } catch { /* logger not initialized */ }
  const {
    provider,
    getMessages,
    appendEntry,
    allocId,
    turnIndex,
    baseRoundIndex = 0,
    tools,
    toolExecutors,
    maxRounds,
    agentName = "",
    onToolCall,
    onToolResult,
    onTextChunk,
    onReasoningChunk,
    onReasoningDone,
    builtinExecutor,
    signal,
    contextIdAllocator,
    toolContextIdAllocator,
    externalizeContentBlocks,
    onTokenUpdate,
    onProviderResponse,
    compactCheck,
    thinkingLevel,
    promptCacheKey,
    onSaveCheckpoint,
    beforeToolExecute,
    suppressAsks,
    getNotification,
    onToolRoundComplete,
    streamCallbacksOwnEntries = false,
    onRetryAttempt,
    onRetrySuccess,
    onRetryExhausted,
    onToolCallPartial: onToolCallPartialOpt,
    resolveToolCallVisibility,
    updateEntry,
    discardEntry,
  } = opts;

  let toolsMap = opts.toolsMap;
  if (!toolsMap && tools) {
    toolsMap = Object.fromEntries(tools.map((t) => [t.name, t]));
  }

  const toolHistory: Array<Record<string, unknown>> = [];
  const intermediateText: string[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let lastInput = 0;
  let lastReasoningContent = "";
  let lastReasoningState: unknown = null;
  let lastThinkingArtifact: ThinkingArtifact | null = null;

  // 每个 tool-call round 的扁平 context ID
  let lastRoundId: string | undefined;

  // 跨 round 的网络重试计数器（连续失败计数）
  let networkRetryCount = 0;

  // 跨 round 的"未完成回合"重掷计数器：上游响应了但产出不可用，
  // 与网络故障分开预算（次数少、停顿短），否则会把 5 次网络预算和
  // 5→80 秒的等待烧在毫无意义的停顿上。
  let incompleteRetryCount = 0;

  for (let roundIdx = 0; roundIdx < maxRounds; roundIdx++) {
    const roundIndex = baseRoundIndex + roundIdx;
    // 每次 provider 调用前检查中断
    if (signal?.aborted) {
      throw new DOMException("操作已被中止。", "AbortError");
    }

    // 追踪 provider 是否调用了 onTextChunk（流式传输）
    let providerStreamedText = false;
    let providerStreamedReasoning = false;
    let textHandledViaCallback = false;
    let reasoningHandledViaCallback = false;
    let wrappedChunk: ((chunk: string) => void) | undefined;
    if (onTextChunk) {
      wrappedChunk = (chunk: string) => {
        providerStreamedText = true;
        textHandledViaCallback = onTextChunk(roundIndex, chunk) === true || textHandledViaCallback;
      };
    }
    let wrappedReasoningChunk: ((chunk: string) => void) | undefined;
    if (onReasoningChunk) {
      wrappedReasoningChunk = (chunk: string) => {
        providerStreamedReasoning = true;
        reasoningHandledViaCallback = onReasoningChunk(roundIndex, chunk) === true || reasoningHandledViaCallback;
      };
    }

    const ensureRoundContextId = (): string | undefined => {
      if (lastRoundId === undefined && contextIdAllocator) {
        lastRoundId = contextIdAllocator(roundIndex);
      }
      return lastRoundId;
    };

    // 追踪进行中的 tool call
    const pendingToolCalls = new Map<string, PendingToolCallState>();

    /** 获取或创建 PendingToolCallState。 */
    const ensurePendingToolCall = (callId: string, name: string): PendingToolCallState => {
      let pending = pendingToolCalls.get(callId);
      if (!pending) {
        pending = {
          name,
          rawArguments: "",
          entryId: null,
          completeTopLevelArgs: {},
          closedCall: null,
          executionPromise: null,
          streamPhase: "hidden_partial",
          execPhase: "not_started",
          tuiVisibility: "defer",
        };
        pendingToolCalls.set(callId, pending);
      } else if (name && pending.name !== name) {
        pending.name = name;
      }
      return pending;
    };

    /** 从 pending 状态获取工具参数（优先 closedCall > completeTopLevelArgs）。 */
    const getToolArgsForEntry = (pending: PendingToolCallState): Record<string, unknown> => {
      return pending.closedCall?.arguments ?? pending.completeTopLevelArgs;
    };

    /** 解析 pending tool call 的 TUI 可见性。 */
    const resolvePendingToolVisibility = (
      pending: PendingToolCallState,
      isClosed: boolean,
    ): ToolCallTuiVisibility => {
      if (pending.tuiVisibility === "show" || pending.tuiVisibility === "hide") {
        return pending.tuiVisibility;
      }
      const toolArgs = getToolArgsForEntry(pending);
      const toolDef = toolsMap?.[pending.name];
      const defaultDecision = resolveDefaultToolCallTuiVisibility(toolDef, toolArgs, isClosed);
      const override = resolveToolCallVisibility?.({
        agentName,
        toolName: pending.name,
        toolArgs,
        rawArguments: pending.rawArguments,
        isClosed,
        toolDef,
        defaultDecision,
      });
      return override ?? defaultDecision;
    };

    /** 从 pending 状态派生流式状态字符串。 */
    const deriveToolStreamState = (pending: PendingToolCallState): string | undefined => {
      if (pending.streamPhase === "hidden_partial") return undefined;
      if (pending.streamPhase === "visible_partial") return "partial";
      return "closed";
    };

    /** 构建工具调用的内容对象（用于日志条目）。 */
    const buildToolCallContent = (
      callId: string,
      pending: PendingToolCallState,
    ): { id: string; name: string; rawArguments: string; arguments: Record<string, unknown>; parseError: string | null } => ({
      id: callId,
      name: pending.name,
      rawArguments: pending.closedCall?.rawArguments ?? pending.rawArguments,
      arguments: getToolArgsForEntry(pending),
      parseError: pending.closedCall?.parseError ?? null,
      ...(pending.executionPayload !== undefined
        ? { executionPayload: pending.executionPayload }
        : {}),
    });

    const releaseCompletedToolCallPayload = (pending: PendingToolCallState): void => {
      pending.rawArguments = "";
      pending.completeTopLevelArgs = {};
      pending.closedCall = null;
      pending.executionPromise = null;
      pending.executionPayload = undefined;
    };

    /**
     * 同步 tool_call 日志条目。
     * 若是新建则追加条目，若是更新则调用 updateEntry。
     */
    const syncToolCallEntry = (callId: string): void => {
      const pending = pendingToolCalls.get(callId);
      if (!pending) return;
      if (pending.tuiVisibility === "defer") return;
      const args = getToolArgsForEntry(pending);
      if (!pending.contextId && toolContextIdAllocator) {
        pending.contextId = toolContextIdAllocator();
      }
      const contextId = pending.contextId ?? ensureRoundContextId();
      const display = generateToolCallDisplay(pending.name, args);
      const meta = buildToolCallMeta(
        { toolCallId: callId, toolName: pending.name, agentName, contextId },
        {
          toolStreamState: deriveToolStreamState(pending),
          toolExecState: pending.execPhase,
        },
      );
      const entryTuiVisible = pending.tuiVisibility === "show";

      if (!pending.entryId) {
        const entryId = allocId("tool_call");
        const entry = createToolCall(
          entryId,
          turnIndex,
          roundIndex,
          display,
          buildToolCallContent(callId, pending),
          { toolCallId: callId, toolName: pending.name, agentName, contextId },
          pending.closedCall ? "assistant" : null,
        );
        entry.meta = meta;
        entry.tuiVisible = entryTuiVisible;
        entry.displayKind = entryTuiVisible ? "tool_call" : null;
        appendEntry(entry);
        pending.entryId = entryId;
        return;
      }

      updateEntry?.(pending.entryId, {
        apiRole: pending.closedCall ? "assistant" : null,
        content: buildToolCallContent(callId, pending),
        display,
        tuiVisible: entryTuiVisible,
        displayKind: entryTuiVisible ? "tool_call" : null,
        meta,
      });
    };

    /**
     * 记录部分 tool call（参数仍在流式传输中）。
     * 解析参数并更新 TUI 可见性。
     */
    const recordPartialToolCall = (
      callId: string,
      toolName: string,
      rawArguments: string,
    ): void => {
      const pending = ensurePendingToolCall(callId, toolName);
      pending.rawArguments = rawArguments;
      // 每个 chunk 都重建参数视图是 O(n²)：1KB chunk 流
      // 一个 256KB 参数会重复处理约 132 倍字节。大参数按 100ms 节流；
      // 小参数保持逐 chunk 更新（成本可忽略，交互更跟手）。
      // closeCommittedToolCall 会无条件做一次最终解析与同步。
      const now = Date.now();
      if (
        rawArguments.length >= PARTIAL_STREAM_ALWAYS_UPDATE_BYTES
        && pending.lastPartialParseAt !== undefined
        && now - pending.lastPartialParseAt < PARTIAL_STREAM_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      pending.lastPartialParseAt = now;
      pending.completeTopLevelArgs = extractCompleteFlatArgs(parsePartialFlatObject(rawArguments));
      if (pending.streamPhase !== "closed") {
        pending.tuiVisibility = resolvePendingToolVisibility(pending, false);
        pending.streamPhase = pending.tuiVisibility === "show" ? "visible_partial" : "hidden_partial";
      }
      if (pending.entryId || pending.tuiVisibility === "show") {
        syncToolCallEntry(callId);
      }
    };

    /**
     * 执行已解析的 tool call。
     * 包含预检、信号处理、执行、结果记录。
     * 返回 suspendedAsk 表示需要用户输入以继续。
     */
    const executeResolvedToolCall = (
      callId: string,
      toolName: string,
      args: Record<string, unknown>,
      fatalParseError?: string,
    ): Promise<{ suspendedAsk?: { ask: AskRequest; toolCallId: string; roundIndex: number } } | null> => {
      const pending = ensurePendingToolCall(callId, toolName);
      if (pending.executionPromise) {
        return pending.executionPromise;
      }

      const run = async (): Promise<{ suspendedAsk?: { ask: AskRequest; toolCallId: string; roundIndex: number } } | null> => {
        if (signal?.aborted) {
          throw new DOMException("操作已被中止。", "AbortError");
        }

        const toolDef = toolsMap?.[toolName];
        const summary = generateToolSummary(
          agentName,
          toolName,
          args,
          toolDef?.summaryTemplate ?? "",
        );

        onToolCall?.(agentName, toolName, args, summary);

        let toolOutput: ToolResult | string;
        const execStartMs = Date.now();
        try {
          let preflight: ToolPreflightDecision | void = undefined;
          if (beforeToolExecute) {
            preflight = await beforeToolExecute({
              agentName,
              toolName,
              toolArgs: args,
              toolCallId: callId,
              summary,
              toolPayload: pending.executionPayload,
            });
          }

          if (preflight && preflight.kind === "ask" && !suppressAsks) {
            const ask = preflight.ask;
            ask.payload.toolCallId = callId;
            ask.roundIndex = roundIndex;
            return { suspendedAsk: { ask, toolCallId: callId, roundIndex } };
          }

          pending.execPhase = "running";
          pending.streamPhase = "closed";
          syncToolCallEntry(callId);

          if (preflight && preflight.kind === "ask" && suppressAsks) {
            toolOutput = new ToolResultClass({ content: COMPACT_ASK_DENY_MESSAGE });
          } else if (fatalParseError) {
            toolOutput = new ToolResultClass({
              content: `ERROR: ${fatalParseError}`,
            });
          } else if (preflight && preflight.kind === "deny") {
            toolOutput = new ToolResultClass({
              content: `ERROR: ${preflight.message}`,
            });
          } else if (toolName in toolExecutors) {
            toolOutput = await toolExecutors[toolName](args, {
              signal,
              patchPayload: pending.executionPayload,
            });
          } else if (builtinExecutor) {
            toolOutput = await builtinExecutor(toolName, args, {
              signal,
              patchPayload: pending.executionPayload,
            });
          } else {
            toolOutput = new ToolResultClass({
              content: `ERROR: No executor found for tool '${toolName}'`,
            });
          }
        } catch (e) {
          if ((e as any)?.name === "AskPendingError") {
            if (suppressAsks) {
              toolOutput = new ToolResultClass({ content: COMPACT_ASK_DENY_MESSAGE });
            } else {
              const ask = (e as { ask?: AskRequest }).ask;
              if (ask) {
                ask.payload.toolCallId = callId;
                ask.roundIndex = roundIndex;
                return { suspendedAsk: { ask, toolCallId: callId, roundIndex } };
              }
              throw e;
            }
          }
          if (signal?.aborted) {
            throw e;
          }
          console.error(`[${agentName}] 工具 '${toolName}' 抛出异常:`, e);
          toolOutput = new ToolResultClass({
            content: `ERROR: 工具执行失败 — ${e}`,
          });
        }

        // 执行器返回后再次检查中止信号
        if (signal?.aborted) {
          throw new DOMException("操作已被中止。", "AbortError");
        }

        const resolved: ToolResultClass =
          typeof toolOutput === "string"
            ? new ToolResultClass({ content: toolOutput })
            : toolOutput instanceof ToolResultClass
              ? toolOutput
              : new ToolResultClass({ content: String(toolOutput) });

        let resultStr = resolved.content;
        if (getNotification) {
          const note = getNotification();
          if (note) resultStr += note;
        }

        const toolEntry: Record<string, unknown> = {
          tool: toolName,
          arguments: args,
          result: resultStr,
        };
        if (resolved.actionHint) toolEntry["action_hint"] = resolved.actionHint;
        if (resolved.tags.length > 0) toolEntry["tags"] = resolved.tags;
        if (Object.keys(resolved.metadata).length > 0) {
          toolEntry["tool_metadata"] = resolved.metadata;
        }
        toolHistory.push(toolEntry);

        const mergedMetadata = { ...resolved.metadata };
        if (resolved.contentBlocks) {
          mergedMetadata._contentBlocks = externalizeContentBlocks
            ? externalizeContentBlocks(resolved.contentBlocks)
            : resolved.contentBlocks;
        }
        const isError = resolved.content.startsWith("ERROR:");
        if (pending.tuiVisibility === "hide" && isError) {
          pending.tuiVisibility = "show";
          syncToolCallEntry(callId);
        }
        const { text: previewText, dim: previewDim } = buildToolResultPreview(
          resolved.metadata,
          resultStr,
          isError,
        );
        const toolResultEntry = createToolResultEntry(
          allocId("tool_result"),
          turnIndex,
          roundIndex,
          {
            toolCallId: callId,
            toolName,
            content: resultStr,
            toolSummary: summary,
          },
          {
            isError,
            contextId: pending?.contextId ?? ensureRoundContextId(),
            toolMetadata: mergedMetadata,
            execStartMs,
            previewText,
            previewDim,
          },
        );
        if (pending.tuiVisibility === "hide" && !isError) {
          toolResultEntry.tuiVisible = false;
          toolResultEntry.displayKind = null;
        }
        appendEntry(toolResultEntry);
        if (onSaveCheckpoint) onSaveCheckpoint();
        onToolResult?.(agentName, toolName, callId, resolved.content.startsWith("ERROR:"), summary);

        pending.execPhase = resolved.content.startsWith("ERROR:") ? "failed" : "completed";
        pending.executionPayload = undefined;
        syncToolCallEntry(callId);
        releaseCompletedToolCallPayload(pending);
        return null;
      };

      const promise = run();
      pending.executionPromise = promise;
      return promise;
    };

    /**
     * 关闭已提交的 tool call（参数流式传输完毕）。
     * 注意：不在此处开始执行，工具执行在流式传输完成后统一排出
     *（见流式传输后的 drain）。这保证审批语义——工具 b 的待处理审批
     * 必须阻塞 c、d 等。
     */
    const closeCommittedToolCall = (tc: ToolCall): void => {
      const pending = ensurePendingToolCall(tc.id, tc.name);
      pending.rawArguments = tc.rawArguments;
      pending.completeTopLevelArgs = {
        ...pending.completeTopLevelArgs,
        ...tc.arguments,
      };
      pending.closedCall = tc;
      pending.tuiVisibility = resolvePendingToolVisibility(pending, true);
      pending.streamPhase = "closed";
      syncToolCallEntry(tc.id);
    };

    let wrappedToolCallPartial: ((callId: string, name: string, rawArguments: string) => void) | undefined;
    let wrappedToolCallClosed: ((call: ToolCall) => void) | undefined;
    let suspendedAskResult: { ask: AskRequest; toolCallId: string; roundIndex: number } | undefined;
    if (onToolCallPartialOpt) {
      wrappedToolCallPartial = (callId: string, name: string, rawArguments: string) => {
        onToolCallPartialOpt!(callId, name, rawArguments);
        recordPartialToolCall(callId, name, rawArguments);
      };
    }
    wrappedToolCallClosed = (call: ToolCall) => {
      closeCommittedToolCall(call);
    };

    let resp: ProviderResponse;
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("操作已被中止。", "AbortError");
      }
      try {
        resp = await provider.asyncSendMessage(
          getMessages() as any,
          tools?.length ? tools : undefined,
          {
            onTextChunk: wrappedChunk,
            onReasoningChunk: wrappedReasoningChunk,
            onToolCallPartial: wrappedToolCallPartial,
            onToolCallClosed: wrappedToolCallClosed,
            signal,
            thinkingLevel,
            promptCacheKey,
          },
        );
        // 契约检查先行：适配器把 tool call 放在 final response 里而不是发
        // closed 事件时，这是编程错误，不能被后面的"空响应"判定误分类。
        if (resp.toolCalls.length > 0) {
          throw new Error("Provider 返回了 final-response toolCalls；tool-loop 期望仅接收规范流式 tool_call_closed 事件。");
        }
        // 上游响应了但这一轮没跑完（截断 / 断流 / 空响应）——抛出去交给
        // 下面的退避环，而不是带着半个 JSON 或空文本继续。
        const defect = detectTurnDefect(resp, pendingToolCalls);
        if (defect) throw defect;
        if (networkRetryCount > 0 || incompleteRetryCount > 0) {
          onRetrySuccess?.(networkRetryCount + incompleteRetryCount);
          networkRetryCount = 0;
          incompleteRetryCount = 0;
        }
        break;
      } catch (loopErr) {
        if (signal?.aborted) {
          throw new DOMException("操作已被中止。", "AbortError");
        }
        // 未完成回合的判定必须抢在 isRetryableNetworkError 之前：它的 code
        // 也在 RETRYABLE_CODES 里，不分流就会套用 5 次 / 5→80 秒的网络预算。
        const isIncomplete = isTurnIncompleteError(loopErr);
        const isNetwork = !isIncomplete && isRetryableNetworkError(loopErr);
        if (!isIncomplete && !isNetwork) {
          throw loopErr;
        }
        const maxRetries = isIncomplete ? MAX_INCOMPLETE_TURN_RETRIES : MAX_NETWORK_RETRIES;
        const failedCount = isIncomplete ? incompleteRetryCount : networkRetryCount;
        if (failedCount >= maxRetries) {
          const errMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
          onRetryExhausted?.(maxRetries, errMsg, isIncomplete ? "incomplete" : "network");
          throw loopErr;
        }
        const attempt = failedCount + 1;
        if (isIncomplete) incompleteRetryCount = attempt;
        else networkRetryCount = attempt;
        if (discardEntry) {
          for (const [, pending] of pendingToolCalls) {
            if (pending.entryId) discardEntry(pending.entryId);
          }
        }
        pendingToolCalls.clear();
        // 重试是一次全新的响应：上一尝试的流式标志必须复位，
        // 否则新响应的文本回退（非流式 provider）会被误判为“已流式处理”。
        providerStreamedText = false;
        providerStreamedReasoning = false;
        textHandledViaCallback = false;
        reasoningHandledViaCallback = false;
        const errMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
        const delay = isIncomplete
          ? computeIncompleteRetryDelay(failedCount)
          : computeRetryDelay(failedCount);
        const delaySec = Math.round(delay / 1000);
        onRetryAttempt?.(attempt, maxRetries, delaySec, errMsg, isIncomplete ? "incomplete" : "network", roundIdx);
        await retrySleep(delay, signal);
      }
    }

    lastInput = resp.usage.inputTokens;
    totalInput += resp.usage.inputTokens;
    totalOutput += resp.usage.outputTokens;

    // 本轮请求已经携带了 next-round hook 上下文，消费后立即清理。
    onProviderResponse?.();

    if (onTokenUpdate) {
      onTokenUpdate(lastInput, resp.usage);
    }

    const hasCommittedToolCalls = Array.from(pendingToolCalls.values()).some((pending) =>
      Boolean(pending.closedCall),
    );

    // 每次 provider 调用后检查是否需要压缩
    let compactTriggered = false;

    if (compactCheck) {
      const check = compactCheck(
        resp.usage.inputTokens,
        resp.usage.outputTokens,
        hasCommittedToolCalls,
      );
      if (check?.compactNeeded) {
        compactTriggered = true;
      }
    }

    // 非流式时的文本回退
    if (resp.text && onTextChunk && !providerStreamedText) {
      textHandledViaCallback = onTextChunk(roundIndex, resp.text) === true || textHandledViaCallback;
    }

    if (resp.reasoningContent && onReasoningChunk && !providerStreamedReasoning) {
      reasoningHandledViaCallback =
        onReasoningChunk(roundIndex, resp.reasoningContent) === true || reasoningHandledViaCallback;
    }

    // 通知推理内容完毕（无论流式或最终响应返回）
    if ((resp.reasoningContent || providerStreamedReasoning) && onReasoningDone) {
      onReasoningDone(roundIndex, resp.thinkingArtifact, resp.reasoningState);
    }

    if (!hasCommittedToolCalls) {
      // 无 tool call — 返回最终结果。
      // 调用方（Session）负责创建最终的 assistant_text / reasoning / no_reply 条目。
      // 空响应、max_tokens 截断、断流都已在上面的退避环里判定并重掷，
      // 走到这里说明这一轮是完整的。
      return {
        text: resp.text,
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: resp.reasoningContent,
        reasoningState: resp.reasoningState,
        thinkingArtifact: resp.thinkingArtifact,
        lastRoundId: lastRoundId,
        compactNeeded: false,
        compactScenario: undefined,
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
        endedWithoutToolCalls: true,
      };
    }

    // 追踪每轮的推理内容（用于 max-rounds 回退）
    lastReasoningContent = resp.reasoningContent;
    lastReasoningState = resp.reasoningState;
    lastThinkingArtifact = resp.thinkingArtifact ?? null;

    // 为 round 分配扁平 context ID
    if (contextIdAllocator) {
      lastRoundId = contextIdAllocator(roundIndex);
    }

    // --- 为本轮创建条目 ---

    // 推理条目
    if (resp.reasoningContent && !(streamCallbacksOwnEntries && reasoningHandledViaCallback)) {
      appendEntry(createReasoning(
        allocId("reasoning"),
        turnIndex,
        roundIndex,
        resp.reasoningContent,
        resp.reasoningContent,
        resp.reasoningState,
        lastRoundId,
        resp.thinkingArtifact,
      ));
    }

    // 中间助手文本条目（与 tool_calls 伴随的文本）
    if (resp.text && !(streamCallbacksOwnEntries && textHandledViaCallback)) {
      intermediateText.push(resp.text);
      appendEntry(createAssistantText(
        allocId("assistant_text"),
        turnIndex,
        roundIndex,
        resp.text,
        resp.text,
        lastRoundId,
      ));
    }

    // 零参数 edit：把正文里的补丁块按调用顺序绑定到 executionPayload。
    // 先给全部已闭合调用赋值，再执行，保证 ask 挂起后的孤儿调用也能直接取到。
    const editCallIds = [...pendingToolCalls.entries()]
      .filter(([, pending]) => Boolean(pending.closedCall) && pending.name === "edit")
      .map(([callId]) => callId);
    if (editCallIds.length > 0) {
      const payloads = resolveRoundPayloads(
        editCallIds.map((callId) => ({ id: callId, name: "edit" })),
        resp.text ?? "",
      );
      for (const callId of editCallIds) {
        const pending = pendingToolCalls.get(callId);
        if (!pending) continue;
        pending.executionPayload = payloads.get(callId);
        syncToolCallEntry(callId);
      }
    }

    // 顺序排出：按发射顺序执行已提交的 tool call。
    // Map 保持插入顺序，迭代即得到模型发射顺序。
    // 遇到 suspendedAsk 时停止 — 剩余 tool call 成为孤儿
    //（仍在日志中，execPhase: "not_started"），Session 审批后恢复。
    for (const [callId, pending] of pendingToolCalls) {
      if (!pending.name || !pending.closedCall) continue;
      if (pending.execPhase === "completed" || pending.execPhase === "failed") continue;
      const result = await executeResolvedToolCall(
        callId,
        pending.name,
        pending.closedCall.arguments,
        pending.closedCall.parseError ?? undefined,
      );
      if (result?.suspendedAsk) {
        suspendedAskResult = result.suspendedAsk;
        break;
      }
    }
    pendingToolCalls.clear();

    // 工具轮次结束：所有 tool_result 已写入。
    // 下一轮模型调用前耗尽队列中的消息。
    if (onToolRoundComplete && !suspendedAskResult) {
      onToolRoundComplete();
    }

    if (suspendedAskResult) {
      return {
        text: resp.text || "",
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: resp.reasoningContent,
        reasoningState: resp.reasoningState,
        thinkingArtifact: resp.thinkingArtifact,
        lastRoundId: lastRoundId,
        compactNeeded: false,
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
        suspendedAsk: suspendedAskResult,
      };
    }

    // 所有工具调用执行完毕后：若触发了压缩，提前返回
    if (compactTriggered) {
      return {
        text: resp.text || "",
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: lastReasoningContent,
        reasoningState: lastReasoningState,
        thinkingArtifact: lastThinkingArtifact,
        lastRoundId: lastRoundId,
        compactNeeded: true,
        compactScenario: "mid_turn",
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
      };
    }
  }

  console.warn(`[${agentName}] 达到最大工具调用轮数 (${maxRounds})`);
  return {
    text: "(Agent reached maximum tool call rounds without completing.)",
    toolHistory,
    totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
    intermediateText,
    lastInputTokens: lastInput,
    reasoningContent: lastReasoningContent,
    reasoningState: lastReasoningState,
    thinkingArtifact: lastThinkingArtifact,
    lastRoundId: lastRoundId,
    lastTotalTokens: totalInput + totalOutput,
    textHandledInLog: false,
    reasoningHandledInLog: false,
    reachedMaxToolRounds: true,
  };
}
