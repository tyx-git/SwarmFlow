/**
 * 结构化日志条目类型和工厂函数。
 *
 * 会话日志架构 v2 的核心数据结构。
 * 会话中的每个事件都记录为一个 LogEntry。
 * TUI 和 API 视图从日志中投影。
 */

// ------------------------------------------------------------------
// 枚举类型
// ------------------------------------------------------------------

import type { ThinkingArtifact } from "../lib/thinking-artifact.js";

/** 日志条目类型——决定内容结构和投影规则 */
export type LogEntryType =
  | "system_prompt"
  | "work_start"
  | "work_end"
  | "input_received"
  | "turn_start"
  | "turn_end"
  | "user_message"
  | "agent_result"
  | "assistant_text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "ask_request"
  | "ask_resolution"
  | "no_reply"
  | "compact_marker"
  | "compact_context"
  | "summary"
  | "interruption_marker"
  | "sub_agent_start"
  | "sub_agent_tool_call"
  | "sub_agent_end"
  | "status"
  | "error"
  | "token_update";

/** Turn 类型 */
export type TurnKind = "user" | "summarize" | "compact";
/** 输入来源类型 */
export type InputKind = "user" | "system" | "peer" | "summarize" | "compact";

/** TUI 显示类型——决定条目在终端中的渲染方式 */
export type TuiDisplayKind =
  | "user"
  | "agent_result"
  | "assistant"
  | "reasoning"
  | "progress"
  | "tool_call"
  | "status"
  | "error"
  | "compact_mark"
  | "tool_result";

// ------------------------------------------------------------------
// LogEntry 接口
// ------------------------------------------------------------------

/** 日志条目——会话中每个事件的结构化记录 */
export interface LogEntry {
  /** 唯一条目 ID（类型前缀 + 序列号，例如 "user-001"、"tc-005"） */
  id: string;

  /** 条目类型——决定内容结构和投影规则 */
  type: LogEntryType;

  /** Unix 毫秒时间戳 */
  timestamp: number;

  /**
   * 用户可见的输入索引（从 1 开始，每次真实用户输入时递增）。
   * 此字段在运行时迁移期间仍命名为 turnIndex；
   * 语义上不再是工作生命周期 ID。
   */
  turnIndex: number;

  /**
   * 同一 turn 内的提供商调用轮次（从 0 开始）。
   * 将 assistant_text + tool_call 条目分组为一条 API 消息。
   * 仅出现在提供商相关条目（assistant_text、reasoning、
   * tool_call、tool_result、no_reply）上。
   */
  roundIndex?: number;

  // ---- TUI 投影层 ----

  /** 此条目在 TUI 中是否可见 */
  tuiVisible: boolean;

  /** TUI 渲染样式。tuiVisible 为 false 时为 null */
  displayKind: TuiDisplayKind | null;

  /** TUI 显示文本。始终保留在活动日志中 */
  display: string;

  // ---- API 投影层 ----

  /** 此条目映射的 API 角色。null = 不参与 API 投影 */
  apiRole: "system" | "user" | "assistant" | "tool_result" | null;

  /** 用于 API 投影的完整内容。归档后为 null */
  content: unknown;

  /** 内容是否已归档到单独文件 */
  archived: boolean;

  // ---- 状态标记 ----

  /** 已丢弃的条目（在投影中跳过）。用于压缩回滚等 */
  discarded?: boolean;

  // ---- 类型特定元数据 ----

  /** 随条目类型变化的结构化元数据 */
  meta: Record<string, unknown>;
}

/** 工具调用日志内容 */
export interface ToolCallLogContent {
  /** 工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 原始参数字符串 */
  rawArguments?: string;
  /** 解析后的参数对象 */
  arguments: Record<string, unknown>;
  /** 参数解析错误信息 */
  parseError?: string | null;
}

/** agent_result TUI 预览的最大行数 */
export const AGENT_RESULT_TUI_PREVIEW_LINES = 8;

/** 构建 agent_result 的 TUI 预览文本 */
export function buildAgentResultTuiPreview(
  content: string,
  maxLines = AGENT_RESULT_TUI_PREVIEW_LINES,
): { text: string; truncated: boolean } {
  if (!content) {
    return { text: "", truncated: false };
  }
  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return { text: content, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

// ------------------------------------------------------------------
// ID 分配器
// ------------------------------------------------------------------

/** 日志条目类型到 ID 前缀的映射 */
const TYPE_PREFIX_MAP: Record<LogEntryType, string> = {
  system_prompt: "sys",
  work_start: "ws",
  work_end: "we",
  input_received: "in",
  turn_start: "ts",
  turn_end: "te",
  user_message: "user",
  agent_result: "ar",
  assistant_text: "asst",
  reasoning: "rsn",
  tool_call: "tc",
  tool_result: "tr",
  ask_request: "askq",
  ask_resolution: "askr",
  no_reply: "nr",
  compact_marker: "cm",
  compact_context: "cc",
  summary: "sum",
  interruption_marker: "int",
  sub_agent_start: "sas",
  sub_agent_tool_call: "satc",
  sub_agent_end: "sae",
  status: "st",
  error: "err",
  token_update: "tok",
};

/**
 * 生成顺序 ID，如 "user-001"、"tc-005"。
 * 维护每个前缀的计数器。
 */
export class LogIdAllocator {
  private _counters = new Map<string, number>();

  /** 为指定条目类型分配下一个 ID */
  next(type: LogEntryType): string {
    const prefix = TYPE_PREFIX_MAP[type];
    const count = (this._counters.get(prefix) ?? 0) + 1;
    this._counters.set(prefix, count);
    return `${prefix}-${String(count).padStart(3, "0")}`;
  }

  /**
   * 从现有日志恢复计数器（例如 loadLog 之后）。
   * 扫描所有条目并将每个前缀计数器设置为看到的最大值。
   */
  restoreFrom(entries: LogEntry[]): void {
    this._counters.clear();
    for (const entry of entries) {
      const dashIdx = entry.id.lastIndexOf("-");
      if (dashIdx === -1) continue;
      const prefix = entry.id.slice(0, dashIdx);
      const num = parseInt(entry.id.slice(dashIdx + 1), 10);
      if (!isNaN(num)) {
        const current = this._counters.get(prefix) ?? 0;
        if (num > current) {
          this._counters.set(prefix, num);
        }
      }
    }
  }

  /** 获取前缀的当前计数器值（用于测试） */
  getCounter(type: LogEntryType): number {
    const prefix = TYPE_PREFIX_MAP[type];
    return this._counters.get(prefix) ?? 0;
  }
}

// ------------------------------------------------------------------
// 工厂辅助函数
// ------------------------------------------------------------------

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
    inputKind === "user" || inputKind === "summarize" || inputKind === "compact"
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
    summaryOrigin?: "agent" | "manual";
    coveredTurnStart?: number;
    coveredTurnEnd?: number;
  },
): LogEntry {
  const meta: Record<string, unknown> = {
    contextId,
    coveredContextIds,
    summaryDepth,
    summaryOrigin: opts?.summaryOrigin ?? "agent",
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
): LogEntry {
  const meta: Record<string, unknown> = { inputTokens };
  if (cacheReadTokens !== undefined) meta.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) meta.cacheCreationTokens = cacheCreationTokens;
  if (totalTokens !== undefined) meta.totalTokens = totalTokens;
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
