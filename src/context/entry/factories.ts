/**
 * 各类型日志条目的构造函数：把运行时事件落成 LogEntry。
 */

import type { ThinkingArtifact } from "../../thinking/artifact.js";
import type {
  InputKind,
  LogEntry,
  LogEntryType,
  ToolCallLogContent,
  TurnKind,
} from "./types.js";
import { buildAgentResultTuiPreview } from "./agent-result-preview.js";

/** 创建日志条目的基础工厂函数 */
function baseEntry(
  id: string,
  type: LogEntryType,
  turnIndex: number,
  partial: Partial<LogEntry>,
): LogEntry {
  return {
    id,
    type,
    timestamp: Date.now(),
    turnIndex,
    tuiVisible: false,
    displayKind: null,
    display: "",
    apiRole: null,
    content: null,
    archived: false,
    meta: {},
    ...partial,
  };
}

// ------------------------------------------------------------------
// 工厂函数——每种条目类型一个
// ------------------------------------------------------------------

/** 创建系统提示词条目 */
export function createSystemPrompt(
  id: string,
  content: string,
): LogEntry {
  return baseEntry(id, "system_prompt", 0, {
    apiRole: "system",
    content,
  });
}

/** 创建工作开始条目 */
export function createWorkStart(
  id: string,
  turnIndex: number,
  workId: string,
): LogEntry {
  return baseEntry(id, "work_start", turnIndex, {
    meta: { workId, timestamp: Date.now() },
  });
}

/** 创建工作结束条目 */
export function createWorkEnd(
  id: string,
  turnIndex: number,
  workId: string,
  status: "completed" | "interrupted" | "error",
  elapsedMs?: number,
  interruptHints?: string[],
): LogEntry {
  return baseEntry(id, "work_end", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display: "",
    meta: { workId, status, timestamp: Date.now(), elapsedMs, interruptHints },
  });
}

/** 创建输入接收条目 */
export function createInputReceived(
  id: string,
  turnIndex: number,
  inputId: string,
  inputKind: InputKind,
  display: string,
  content: unknown,
  contextId: string,
  opts?: { tuiVisible?: boolean; sender?: string },
): LogEntry {
  const tuiVisible = opts?.tuiVisible ?? (
    inputKind === "user" || inputKind === "compact"
  );
  const meta: Record<string, unknown> = { inputId, inputKind, contextId };
  if (opts?.sender) meta.sender = opts.sender;
  return baseEntry(id, "input_received", turnIndex, {
    tuiVisible,
    displayKind: tuiVisible ? "user" : null,
    display,
    apiRole: null,
    content,
    meta,
  });
}

/** 创建 turn 开始条目 */
export function createTurnStart(
  id: string,
  turnIndex: number,
  turnKind: TurnKind = "user",
): LogEntry {
  return baseEntry(id, "turn_start", turnIndex, {
    meta: { turnIndex, turnKind, timestamp: Date.now() },
  });
}

/** 创建 turn 结束条目 */
export function createTurnEnd(
  id: string,
  turnIndex: number,
  status: "completed" | "interrupted" | "error",
  elapsedMs?: number,
  interruptHints?: string[],
): LogEntry {
  return baseEntry(id, "turn_end", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display: "",
    meta: { turnIndex, status, timestamp: Date.now(), elapsedMs, interruptHints },
  });
}

/** 创建用户消息条目 */
export function createUserMessage(
  id: string,
  turnIndex: number,
  display: string,
  content: unknown,
  contextId: string,
  opts?: { tuiVisible?: boolean; inputId?: string; inputKind?: InputKind },
): LogEntry {
  const tuiVisible = opts?.tuiVisible ?? true;
  const meta: Record<string, unknown> = { contextId };
  if (opts?.inputId) meta.inputId = opts.inputId;
  if (opts?.inputKind) meta.inputKind = opts.inputKind;
  return baseEntry(id, "user_message", turnIndex, {
    tuiVisible,
    displayKind: tuiVisible ? "user" : null,
    display,
    apiRole: "user",
    content,
    meta,
  });
}

/** 创建代理结果条目 */
export function createAgentResult(
  id: string,
  turnIndex: number,
  agentId: string,
  agentNumericId: number,
  agentTemplate: string,
  outcome: "completed" | "failed" | "interrupted",
  cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt",
  elapsedMs: number,
  content: string,
  contextId: string,
  fullOutputPath?: string,
): LogEntry {
  const preview = buildAgentResultTuiPreview(content);
  const meta: Record<string, unknown> = {
    contextId,
    agentId,
    agentNumericId,
    agentTemplate,
    outcome,
    cause,
    elapsedMs,
  };
  if (preview.truncated) meta.tuiPreviewTruncated = true;
  if (fullOutputPath) meta.fullOutputPath = fullOutputPath;
  return baseEntry(id, "agent_result", turnIndex, {
    tuiVisible: true,
    displayKind: "agent_result",
    display: preview.text,
    apiRole: null,
    content,
    meta,
  });
}

/** 创建 assistant 文本条目 */
export function createAssistantText(
  id: string,
  turnIndex: number,
  roundIndex: number,
  display: string,
  content: string,
  contextId?: string,
): LogEntry {
  return baseEntry(id, "assistant_text", turnIndex, {
    roundIndex,
    tuiVisible: true,
    displayKind: "assistant",
    display,
    apiRole: "assistant",
    content,
    meta: contextId ? { contextId } : {},
  });
}

/** 创建推理/思维链条目 */
export function createReasoning(
  id: string,
  turnIndex: number,
  roundIndex: number,
  display: string,
  content: unknown,
  reasoningState?: unknown,
  contextId?: string,
  thinkingArtifact?: ThinkingArtifact | null,
): LogEntry {
  const meta: Record<string, unknown> = {};
  if (reasoningState !== undefined) meta.reasoningState = reasoningState;
  if (contextId !== undefined) meta.contextId = contextId;
  if (thinkingArtifact) meta.thinkingArtifact = thinkingArtifact;
  return baseEntry(id, "reasoning", turnIndex, {
    roundIndex,
    tuiVisible: true,
    displayKind: "reasoning",
    display,
    apiRole: null,
    content,
    meta,
  });
}

/** 创建工具调用条目 */
export function createToolCall(
  id: string,
  turnIndex: number,
  roundIndex: number,
  display: string,
  toolCallContent: ToolCallLogContent,
  opts: { toolCallId: string; toolName: string; agentName: string; contextId?: string },
  apiRole: LogEntry["apiRole"] = "assistant",
): LogEntry {
  const meta: Record<string, unknown> = {
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    agentName: opts.agentName,
  };
  if (opts.contextId !== undefined) meta.contextId = opts.contextId;
  return baseEntry(id, "tool_call", turnIndex, {
    roundIndex,
    tuiVisible: true,
    displayKind: "tool_call",
    display,
    apiRole,
    content: {
      ...toolCallContent,
      rawArguments: toolCallContent.rawArguments ?? JSON.stringify(toolCallContent.arguments ?? {}),
      parseError: toolCallContent.parseError ?? null,
    },
    meta,
  });
}

/** 创建工具结果条目 */
export function createToolResult(
  id: string,
  turnIndex: number,
  roundIndex: number,
  resultContent: { toolCallId: string; toolName: string; content: string; toolSummary: string },
  opts: {
    isError: boolean;
    contextId?: string;
    toolMetadata?: Record<string, unknown>;
    execStartMs?: number;
    interrupt?: {
      kind: "not_started" | "execution_interrupted";
      partialEffectsPossible?: boolean;
      incompleteArguments?: boolean;
    };
    previewText?: string;
    /** When true, TUI renders the preview in dim/gray style. */
    previewDim?: boolean;
  },
): LogEntry {
  const meta: Record<string, unknown> = {
    toolCallId: resultContent.toolCallId,
    toolName: resultContent.toolName,
    isError: opts.isError,
  };
  if (opts.contextId !== undefined) meta.contextId = opts.contextId;
  if (opts.toolMetadata && Object.keys(opts.toolMetadata).length > 0) {
    meta.toolMetadata = opts.toolMetadata;
  }
  if (opts.execStartMs !== undefined) meta.execStartMs = opts.execStartMs;
  if (opts.interrupt) meta.interrupt = opts.interrupt;
  if (opts.previewDim) meta.tuiDim = true;
  const hasDisplay = Boolean(opts.previewText) || opts.isError;
  return baseEntry(id, "tool_result", turnIndex, {
    roundIndex,
    tuiVisible: hasDisplay,
    displayKind: hasDisplay ? "tool_result" : null,
    display: opts.previewText ?? (opts.isError ? resultContent.content : ""),
    apiRole: "tool_result",
    content: resultContent,
    meta,
  });
}

/** 创建无回复条目 */
export function createNoReply(
  id: string,
  turnIndex: number,
  roundIndex: number,
  content: string,
  contextId?: string,
): LogEntry {
  return baseEntry(id, "no_reply", turnIndex, {
    roundIndex,
    apiRole: "assistant",
    content,
    meta: contextId ? { contextId } : {},
  });
}

/** 创建压缩标记条目 */
export function createCompactMarker(
  id: string,
  turnIndex: number,
  compactIndex: number,
  originalTokens: number,
  compactedTokens: number,
): LogEntry {
  return baseEntry(id, "compact_marker", turnIndex, {
    tuiVisible: true,
    displayKind: "compact_mark",
    display: "\u2014 Compacted \u2014",
    meta: { compactIndex, originalTokens, compactedTokens },
  });
}

/** 创建压缩上下文条目 */
export function createCompactContext(
  id: string,
  turnIndex: number,
  content: string,
  contextId: string,
  compactIndex: number,
): LogEntry {
  return baseEntry(id, "compact_context", turnIndex, {
    apiRole: "user",
    content,
    meta: { contextId, compactIndex },
  });
}

/** 创建摘要条目 */
export function createSummary(
  id: string,
  turnIndex: number,
  display: string,
  content: string,
  contextId: string,
  coveredContextIds: string[],
  summaryDepth: number,
  opts?: {
    coveredTurnStart?: number;
    coveredTurnEnd?: number;
  },
): LogEntry {
  const meta: Record<string, unknown> = {
    contextId,
    coveredContextIds,
    summaryDepth,
  };
  if (opts?.coveredTurnStart !== undefined) meta.coveredTurnStart = opts.coveredTurnStart;
  if (opts?.coveredTurnEnd !== undefined) meta.coveredTurnEnd = opts.coveredTurnEnd;
  return baseEntry(id, "summary", turnIndex, {
    tuiVisible: true,
    displayKind: "user",
    display,
    apiRole: "user",
    content,
    meta,
  });
}

/** 创建中断标记条目 */
export function createInterruptionMarker(
  id: string,
  turnIndex: number,
  content: string,
  terminatedSubAgents?: string[],
): LogEntry {
  return baseEntry(id, "interruption_marker", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display: "[System]: Last turn was interrupted by the user.",
    apiRole: "user",
    content,
    meta: terminatedSubAgents?.length ? { terminatedSubAgents } : {},
  });
}

/** 创建子代理开始条目 */
export function createSubAgentStart(
  id: string,
  turnIndex: number,
  display: string,
  subAgentId: number,
  subAgentName: string,
  task: string,
): LogEntry {
  return baseEntry(id, "sub_agent_start", turnIndex, {
    tuiVisible: true,
    displayKind: "progress",
    display,
    meta: { subAgentId, subAgentName, task },
  });
}

/** 创建子代理工具调用条目 */
export function createSubAgentToolCall(
  id: string,
  turnIndex: number,
  display: string,
  subAgentId: number,
  subAgentName: string,
  toolName: string,
  toolCallCount: number,
): LogEntry {
  return baseEntry(id, "sub_agent_tool_call", turnIndex, {
    tuiVisible: true,
    displayKind: "progress",
    display,
    meta: { subAgentId, subAgentName, toolName, toolCallCount },
  });
}

/** 创建子代理结束条目 */
export function createSubAgentEnd(
  id: string,
  turnIndex: number,
  display: string,
  subAgentId: number,
  subAgentName: string,
  elapsed: number,
  toolCallCount: number,
): LogEntry {
  return baseEntry(id, "sub_agent_end", turnIndex, {
    tuiVisible: true,
    displayKind: "progress",
    display,
    meta: { subAgentId, subAgentName, elapsed, toolCallCount },
  });
}

/** 创建状态条目 */
export function createStatus(
  id: string,
  turnIndex: number,
  display: string,
  statusType: string,
): LogEntry {
  return baseEntry(id, "status", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display,
    meta: { statusType },
  });
}

/**
 * 创建仅用于主界面显示的用户输入条目（如 /memory、/theme brief 等斜杠命令）
 *
 * type: "user_message" 走 transformUser → UserEntry → 背景色 userWash
 * apiRole: null 走 log-projection 的 filter → 不发送给 LLM
 * meta.displayOnly: true 标记为非真实用户输入
 */
export function createUserInputDisplay(
  id: string,
  turnIndex: number,
  display: string,
): LogEntry {
  return baseEntry(id, "user_message", turnIndex, {
    tuiVisible: true,
    displayKind: "user",
    display,
    apiRole: null,
    content: null,
    meta: { displayOnly: true },
  });
}

/** 创建切换类命令的简洁回显；不进入模型上下文。 */
export function createSwitchCommandEcho(
  id: string,
  turnIndex: number,
  display: string,
  tone: "default" | "worked" = "default",
): LogEntry {
  return baseEntry(id, "user_message", turnIndex, {
    tuiVisible: true,
    displayKind: "command_echo",
    display,
    apiRole: null,
    content: null,
    meta: { displayOnly: true, commandEchoTone: tone },
  });
}

/** 统一命令回显入口；注入类命令保持既有用户气泡样式。 */
export function createCommandEcho(
  id: string,
  turnIndex: number,
  display: string,
  style: "switch" | "injected",
  tone: "default" | "worked" = "default",
): LogEntry {
  return style === "switch"
    ? createSwitchCommandEcho(id, turnIndex, display, tone)
    : createUserInputDisplay(id, turnIndex, display);
}

/** 创建错误条目 */
export function createError(
  id: string,
  turnIndex: number,
  display: string,
  errorType?: string,
): LogEntry {
  return baseEntry(id, "error", turnIndex, {
    tuiVisible: true,
    displayKind: "error",
    display,
    meta: errorType ? { errorType } : {},
  });
}

/** 创建 token 更新条目 */
export function createTokenUpdate(
  id: string,
  turnIndex: number,
  inputTokens: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
  totalTokens?: number,
  cacheSupported?: boolean,
): LogEntry {
  const meta: Record<string, unknown> = { inputTokens };
  if (cacheReadTokens !== undefined) meta.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) meta.cacheCreationTokens = cacheCreationTokens;
  if (totalTokens !== undefined) meta.totalTokens = totalTokens;
  if (cacheSupported !== undefined) meta.cacheSupported = cacheSupported;
  return baseEntry(id, "token_update", turnIndex, { meta });
}

/** 创建 ask 请求条目 */
export function createAskRequest(
  id: string,
  turnIndex: number,
  content: unknown,
  askId: string,
  askKind: string,
  toolCallId: string,
  roundIndex: number,
  contextId?: string,
): LogEntry {
  const meta: Record<string, unknown> = { askId, askKind, toolCallId, roundIndex };
  if (contextId !== undefined) meta.contextId = contextId;
  return baseEntry(id, "ask_request", turnIndex, {
    content,
    meta,
  });
}

/** 创建 ask 解析条目 */
export function createAskResolution(
  id: string,
  turnIndex: number,
  content: unknown,
  askId: string,
  askKind: string,
): LogEntry {
  return baseEntry(id, "ask_resolution", turnIndex, {
    content,
    meta: { askId, askKind },
  });
}
