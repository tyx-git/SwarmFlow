import type { AskRequest } from "../../ask.js";
import type { ThinkingArtifact } from "../../thinking/artifact.js";

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
 *   执行状态、TUI 可见性、edit-file 上下文探测）
 * - 顺序排出：已提交的 tool call 按发射顺序执行；挂起的 ask 暂停排出，
 *   以保证审批语义正确
 * - Compact：可在任意 provider 调用后触发中途压缩，返回 compactNeeded=true
 */

import type { BaseProvider } from "../../providers/base.js";
import type { ToolResult } from "../../providers/response.js";
import type { ToolDef } from "../../providers/types.js";

import {
  type RetryKind,
} from "../../network/retry.js";
import type { LogEntry } from "../../context/entry/types.js";

/**
 * asyncRunToolLoop 的返回值。包含调用方（通常是 Session）
 * 构建日志条目和决定下一步所需的一切。
 */
export interface ToolLoopResult {
  text: string;
  toolHistory: Array<Record<string, unknown>>;
  totalUsage: { inputTokens: number; outputTokens: number };
  intermediateText: string[];
  lastInputTokens: number;
  reasoningContent: string;
  reasoningState: unknown;
  thinkingArtifact?: ThinkingArtifact | null;
  /** 最后一个 tool-call round 的扁平 context_id（无 tool call 时为 undefined）。 */
  lastRoundId?: string;
  /** 是否触发了中途压缩（提前返回）。 */
  compactNeeded?: boolean;
  compactScenario?: "mid_turn";
  lastTotalTokens?: number;
  /** 流式回调是否已写入最终文本条目。 */
  textHandledInLog?: boolean;
  /** 流式回调是否已写入最终推理条目。 */
  reasoningHandledInLog?: boolean;
  /** 模型本轮返回无 tool call 时为 true。 */
  endedWithoutToolCalls?: boolean;
  /** 达到工具调用轮数上限而提前结束；text 是固定哨兵文案。 */
  reachedMaxToolRounds?: boolean;
  /** 模型调用了 ask 工具、需要用户输入才能继续时设置。 */
  suspendedAsk?: {
    ask: AskRequest;
    toolCallId: string;
    roundIndex: number;
  };
}

// ------------------------------------------------------------------
// 回调类型
// ------------------------------------------------------------------

/** 工具调用前的回调。 */
export type OnToolCallCallback = (
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summary: string,
) => void;

/** 工具结果返回后的回调。 */
export type OnToolResultCallback = (
  agentName: string,
  toolName: string,
  toolCallId: string,
  isError: boolean,
  summary: string,
) => void;

export interface ToolPreflightContext {
  agentName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  summary: string;
}

/** 工具预检决定：放行、拒绝、或暂停询问用户。 */
export type ToolPreflightDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; ask: AskRequest };

/** 工具执行前的预检钩子（可返回 allow/deny/ask）。 */
export type BeforeToolExecuteCallback = (
  ctx: ToolPreflightContext,
) => ToolPreflightDecision | void | Promise<ToolPreflightDecision | void>;

/** TUI 中工具调用的可见性状态。 */
export type ToolCallTuiVisibility = "defer" | "show" | "hide";

export interface ToolCallVisibilityContext {
  agentName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  rawArguments: string;
  isClosed: boolean;
  toolDef?: ToolDef;
  defaultDecision: ToolCallTuiVisibility;
}

/** 解析工具调用可见性的回调。 */
export type ResolveToolCallVisibilityCallback = (
  ctx: ToolCallVisibilityContext,
) => ToolCallTuiVisibility | void;

// ------------------------------------------------------------------
// asyncRunToolLoop
// ------------------------------------------------------------------

export interface ToolLoopOptions {
  provider: BaseProvider;
  /**
   * 返回当前 API 消息序列。每次 provider 调用前都会调用。
   * 主 Agent：从 _log 投影；子 Agent：返回本地数组。
   */
  getMessages: () => Array<Record<string, unknown>>;
  /**
   * 追加 LogEntry 到后端存储。
   * 主 Agent：追加到 _log；子 Agent：转换为原始消息并推送。
   */
  appendEntry: (entry: LogEntry) => void;
  /** 分配下一个条目 ID。 */
  allocId: (type: LogEntry["type"]) => string;
  /** 当前 turn 索引（用于创建条目）。 */
  turnIndex: number;
  /** 当前 turn 内的基础 round 索引。 */
  baseRoundIndex?: number;
  tools?: ToolDef[];
  toolExecutors: Record<string, ToolExecutor>;
  maxRounds: number;
  agentName?: string;
  onToolCall?: OnToolCallCallback;
  onToolResult?: OnToolResultCallback;
  toolsMap?: Record<string, ToolDef>;
  /** 流式文本块回调。返回 true 表示已处理（不再需要默认处理）。 */
  onTextChunk?: (roundIndex: number, chunk: string) => boolean | void;
  /** 流式推理内容回调。返回 true 表示已处理。 */
  onReasoningChunk?: (roundIndex: number, chunk: string) => boolean | void;
  /** 一轮的推理内容全部接收完毕后调用。 */
  onReasoningDone?: (
    roundIndex: number,
    thinkingArtifact?: ThinkingArtifact | null,
    reasoningState?: unknown,
  ) => void;
  /** 未在 toolExecutors 中找到时的内置执行器回退。 */
  builtinExecutor?: (
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolExecutorContext,
  ) => Promise<ToolResult | string>;
  /** 中断信号。 */
  signal?: AbortSignal;
  /** 为 round 分配 context_id（用于 text/reasoning）。 */
  contextIdAllocator?: (roundIndex: number) => string;
  /** 为每个 tool_call 分配独立的 context_id。 */
  toolContextIdAllocator?: () => string;
  /** 每次 provider 响应后调用，报告最新输入 token 数和完整使用量。 */
  onTokenUpdate?: (inputTokens: number, usage?: import("../../providers/response.js").Usage) => void;
  /**
   * 成功收到 provider 响应后调用。
   * Session 用它清理“下一轮”hook 上下文：这些内容已随本次请求发送，
   * 不能让它们在后续每一轮中重复累积。
   */
  onProviderResponse?: () => void;
  /**
   * 每次 provider 调用后检查是否需要压缩。
   * 返回 null 表示跳过检查（如子 Agent）。
   */
  compactCheck?: (
    inputTokens: number,
    outputTokens: number,
    hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null;
  /** 统一思考深度覆盖（传递给 provider）。 */
  thinkingLevel?: string;
  /** OpenAI prompt cache 亲和路由键（如子会话 ID）。 */
  promptCacheKey?: string;
  /** 每次 tool_result 追加后调用，用于增量持久化。 */
  onSaveCheckpoint?: () => void;
  /** 工具执行前的预检门禁（可询问/暂停/拒绝）。 */
  beforeToolExecute?: BeforeToolExecuteCallback;
  /**
   * 压缩阶段置 true：任何需要审批/挂起的工具调用都被就地降级为
   * ERROR tool_result，而不是挂起等待用户。压缩是纯总结操作，
   * 挂起会把压缩变成投影校验错误并静默吞掉审批。
   */
  suppressAsks?: boolean;
  /** 返回要追加到 tool_result 内容的通知字符串，无则返回 null。 */
  getNotification?: () => string | null;
  /** 一轮所有 tool_result 写完后、下一轮模型调用前调用。
   *  Session 用此耗尽队列中的收件消息。 */
  onToolRoundComplete?: () => void;
  /** 为 true 时，流式 text/reasoning 回调拥有对应的日志条目。 */
  streamCallbacksOwnEntries?: boolean;
  /** 检测到可重试错误时调用。 */
  onRetryAttempt?: (attempt: number, maxRetries: number, delaySec: number, errMsg: string, kind?: RetryKind) => void;
  /** 重试的调用成功时调用。 */
  onRetrySuccess?: (attempt: number) => void;
  /** 所有重试耗尽时调用。 */
  onRetryExhausted?: (maxRetries: number, errMsg: string, kind?: RetryKind) => void;
  /** 工具调用参数演进时调用；provider 传递最新原始参数缓冲区。 */
  onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
  /** 解析工具调用在 TUI 中是延迟、显示还是隐藏。 */
  resolveToolCallVisibility?: ResolveToolCallVisibilityCallback;
  /** 就地更新已有日志条目（用于最终化 pending tool call 条目）。 */
  updateEntry?: (entryId: string, patch: {
    apiRole?: LogEntry["apiRole"];
    content?: unknown;
    display?: string;
    tuiVisible?: boolean;
    displayKind?: LogEntry["displayKind"];
    meta?: Record<string, unknown>;
  }) => void;
  /** 将日志条目标记为已丢弃（重试时清理）。 */
  discardEntry?: (entryId: string) => void;
}

import type { ToolExecutor, ToolExecutorContext } from "../../tools/executor-types.js";
