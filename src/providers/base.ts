/**
 * 提供者抽象层 — 基础类型和抽象类。
 *
 * 定义工具调用、使用跟踪、
 * 提供者响应和抽象 BaseProvider 合约的统一接口。
 */

import type { ThinkingArtifact } from "../lib/thinking-artifact.js";
import { isUnauthorizedError } from "../lib/network-retry.js";

// ------------------------------------------------------------------
// 数据接口
// ------------------------------------------------------------------

/**
 * 各家 provider 终止原因的归一化词汇。
 *
 * 原生取值差别很大（Anthropic `stop_reason`、OpenAI Chat `finish_reason`、
 * Responses `status` + `incomplete_details.reason`、Gemini `finishReason`），
 * 循环层需要的是一个能直接判定的语义，而不是又一轮字符串考古。
 */
export type StopReason =
  /** 正常说完（含 stop_sequence）。 */
  | "end_turn"
  /** 以工具调用结束，等待执行结果。 */
  | "tool_calls"
  /** 被 max_tokens / max_output_tokens 截断——这一轮没说完。 */
  | "max_tokens"
  /** 安全策略拒答。 */
  | "refusal"
  /** Anthropic `pause_turn`：服务端工具暂停，可继续。 */
  | "paused"
  /**
   * 上游从未给出终止事件，流就结束了（适配器主动标记）。
   *
   * 与 null 的区别很关键：null 是"这个 provider 不暴露终止信息"，
   * 而这一值是"确实缺了终止状态"——回合不能判定为完成。
   */
  | "incomplete_stream"
  /** 认识但不在上述语义里的取值（含 Responses 的 `failed`）。 */
  | "unknown";

const STOP_REASON_ALIASES: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop: "end_turn",
  stop_sequence: "end_turn",
  completed: "end_turn",
  eos: "end_turn",
  tool_use: "tool_calls",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  max_tokens: "max_tokens",
  max_output_tokens: "max_tokens",
  length: "max_tokens",
  // Responses API 的 status=incomplete（reason 缺失时）同样是"没说完"。
  incomplete: "max_tokens",
  content_filter: "refusal",
  refusal: "refusal",
  safety: "refusal",
  recitation: "refusal",
  prohibited_content: "refusal",
  blocklist: "refusal",
  pause_turn: "paused",
};

/**
 * 归一化 provider 的终止原因。
 *
 * 返回 null 表示"这个 provider 没有暴露终止信息"，调用方据此**不做任何
 * 推断**——把 null 当成截断会让所有未适配的适配器全军覆没。
 */
export function normalizeStopReason(raw: string | null | undefined): StopReason | null {
  if (!raw) return null;
  const alias = STOP_REASON_ALIASES[raw.toLowerCase()];
  return alias ?? "unknown";
}

/** 多模态消息的图像内容块。 */
export interface ImageBlock {
  mediaType: string;   // 例如 "image/png", "image/jpeg"
  data: string;        // base64 编码的图像数据
}

/** 模型返回的单个工具调用。 */
export interface ToolCall {
  id: string;
  name: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  parseError: string | null;
}

/** 标准化的网页搜索引用。 */
export interface Citation {
  url: string;
  title: string;
  citedText?: string;
}

/** 提供者无关的工具定义。 */
export type ToolTuiPartialRevealPolicy =
  | "immediate"
  | "closed"
  | { completeArgs: string[] };

export interface ToolTuiPolicy {
  /**
   * 部分工具调用何时有资格渲染到 TUI。
   * 隐藏/覆盖决策仍可由 Session 在运行时应用。
   */
  partialReveal?: ToolTuiPartialRevealPolicy;
}

export interface ToolDef {
  name: string;
  description: string;
  /** 函数参数的 JSON Schema。 */
  parameters: Record<string, unknown>;
  /**
   * 工具调用单行摘要的格式字符串。
   * `{agent}` 始终可用；其他占位符映射到参数键。
   */
  summaryTemplate?: string;
  /** 仅本地使用的 TUI 行为提示；永不转发给提供者。 */
  tuiPolicy?: ToolTuiPolicy;
}

// ------------------------------------------------------------------
// 对话消息的消息类型
// ------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool" | "tool_result";

export interface Message {
  role: MessageRole;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// ------------------------------------------------------------------
// sendMessage 的选项
// ------------------------------------------------------------------

export interface SendMessageOptions {
  temperature?: number;
  maxTokens?: number;
  onTextChunk?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  /** 当工具调用变得可见且其原始 JSON 参数缓冲区变化时触发。 */
  onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
  /** 当工具调用关闭并由提供者规范化时触发。 */
  onToolCallClosed?: (call: ToolCall) => void;
  signal?: AbortSignal;
  /** 统一思考级别字符串（"off", "low", "medium", "high", "adaptive" 等）。 */
  thinkingLevel?: string;
  /** OpenAI prompt cache affinity 的路由键（例如子 session id）。 */
  promptCacheKey?: string;
}

// ------------------------------------------------------------------
// 带计算属性的类
// ------------------------------------------------------------------

/** Token 用量跟踪器。 */
export class Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Whether the provider response exposed a cache-read metric. */
  cacheSupported: boolean;

  constructor(inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, cacheSupported = false) {
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.cacheCreationTokens = cacheCreationTokens;
    this.cacheReadTokens = cacheReadTokens;
    this.cacheSupported = cacheSupported || cacheCreationTokens > 0;
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }
}

/** 任意提供者的统一响应。 */
export class ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
  reasoningContent: string;
  reasoningState: unknown;
  thinkingArtifact: ThinkingArtifact | null;
  citations: Citation[];
  extra: Record<string, unknown>;
  /** 归一化终止原因；null = 该 provider 未暴露终止信息。 */
  stopReason: StopReason | null;

  constructor(opts: {
    text?: string;
    toolCalls?: ToolCall[];
    usage?: Usage;
    raw?: unknown;
    reasoningContent?: string;
    reasoningState?: unknown;
    thinkingArtifact?: ThinkingArtifact | null;
    citations?: Citation[];
    extra?: Record<string, unknown>;
    stopReason?: StopReason | null;
  } = {}) {
    this.text = opts.text ?? "";
    this.toolCalls = opts.toolCalls ?? [];
    this.usage = opts.usage ?? new Usage();
    this.raw = opts.raw ?? null;
    this.reasoningContent = opts.reasoningContent ?? "";
    this.reasoningState = opts.reasoningState ?? null;
    this.thinkingArtifact = opts.thinkingArtifact ?? null;
    this.citations = opts.citations ?? [];
    this.extra = opts.extra ?? {};
    this.stopReason = opts.stopReason ?? null;
  }

  get hasToolCalls(): boolean {
    return this.toolCalls.length > 0;
  }
}

export function finalizeToolCall(
  id: string,
  name: string,
  rawArguments: string,
  sourceLabel?: string,
): ToolCall {
  const normalizedRaw = rawArguments || "";
  try {
    return {
      id,
      name,
      rawArguments: normalizedRaw,
      arguments: normalizedRaw ? JSON.parse(normalizedRaw) as Record<string, unknown> : {},
      parseError: null,
    };
  } catch {
    const label = sourceLabel ?? (name || "tool");
    return {
      id,
      name,
      rawArguments: normalizedRaw,
      arguments: {},
      parseError: `Failed to parse ${label} tool arguments as JSON (${normalizedRaw.length} chars).`,
    };
  }
}

/** 带可选元数据的扩展工具执行结果。 */
export class ToolResult {
  content: string;
  actionHint?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  /**
   * 支持多模态的提供者可使用的可选多模态内容块
   *（例如带图像块的 Anthropic tool_result）。
   * 存在时，提供者应使用这些块而不是 `content` 字符串。
   * `content` 字符串仍作为文本回退 / TUI 显示。
   */
  contentBlocks?: Array<Record<string, unknown>>;

  constructor(opts: {
    content: string;
    actionHint?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    contentBlocks?: Array<Record<string, unknown>>;
  }) {
    this.content = opts.content;
    this.actionHint = opts.actionHint;
    this.tags = opts.tags ?? [];
    this.metadata = opts.metadata ?? {};
    this.contentBlocks = opts.contentBlocks;
  }

  toString(): string {
    return this.content;
  }
}

// ------------------------------------------------------------------
// 中断流式传输的部分 JSON 恢复
// ------------------------------------------------------------------

/**
 * 从截断的 JSON 对象字符串中恢复完整键值对。
 * 用于流式传输在参数中途被中断时。
 *
 * 策略：
 * 1. 尝试普通 JSON.parse（如果 JSON 实际完整则可用）
 * 2. 尝试追加常见闭合符（"}", ""}" 等）以闭合截断值
 * 3. 在最后一个顶层逗号处截断并用 "}" 闭合
 * 4. 回退到 {}
 */
export function recoverPartialArgs(partial: string): Record<string, unknown> {
  if (!partial) return {};

  // 1. 尝试普通解析
  try {
    const r = JSON.parse(partial);
    if (r && typeof r === "object" && !Array.isArray(r)) return r;
  } catch {}

  // 2. 尝试追加常见闭合符
  for (const closer of ['"}', "}", '"]}'  , "null}"]) {
    try {
      const r = JSON.parse(partial + closer);
      if (r && typeof r === "object" && !Array.isArray(r)) return r;
    } catch {}
  }

  // 3. 在最后一个逗号处截断并闭合
  for (let i = partial.length - 1; i >= 0; i--) {
    if (partial[i] === ",") {
      try {
        const r = JSON.parse(partial.slice(0, i) + "}");
        if (r && typeof r === "object" && !Array.isArray(r)) return r;
      } catch {}
    }
  }

  return {};
}

// ------------------------------------------------------------------
// 抽象基础提供者
// ------------------------------------------------------------------

/**
 * 每个提供者适配器必须实现的接口。
 */
export abstract class BaseProvider {
  /**
   * 此提供者是否要求 user/assistant 角色严格交替。
   * 为 true 时，渲染管线会合并连续的同角色消息。
   */
  readonly requiresAlternatingRoles: boolean = false;

  /**
   * compact 检测如何计算 token 预算。
   * - "subtract_output": budget = contextLength - maxOutputTokens（默认）
   * - "full_context": budget = contextLength，仅检查 inputTokens
   */
  readonly budgetCalcMode: "subtract_output" | "full_context" = "subtract_output";

  /**
   * 向模型发送消息并返回统一响应。
   */
  abstract sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;

  /**
   * 凭据被上游拒绝（401/403）时刷新一次。
   *
   * 返回 true 表示凭据已更新、请求值得原样重发；返回 false 表示这个适配器
   * 没有可刷新的凭据（静态 API key），错误照原样抛给用户。
   *
   * 只有 OAuth 型适配器需要覆盖它。长会话里 access token 中途过期是常态，
   * 没有这条路径整轮就直接报废。
   */
  protected async _reauthenticate(): Promise<boolean> {
    return false;
  }

  /**
   * 带可选流式回调的异步发送。
   *
   * 使用完整 options 对象委托给 `sendMessage`，其中包括
   * 流式回调和中止信号。每个提供者的 `sendMessage`
   * 会检查 `onTextChunk`/`onReasoningChunk`，存在时路由到其
   * 流式实现。
   *
   * 额外负责 401/403 的"刷新凭据→原样重发一次"。重试环（network-retry）
   * 故意不认 4xx：凭据不刷新时重发多少次都是同一个错误，所以这里只发一次，
   * 失败就抛。
   */
  async asyncSendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    let firstError: unknown;
    try {
      return await this.sendMessage(messages, tools, options);
    } catch (err) {
      if (!isUnauthorizedError(err)) throw err;
      firstError = err;
    }

    if (options?.signal?.aborted) throw firstError;
    if (!await this._reauthenticate()) throw firstError;
    if (options?.signal?.aborted) throw firstError;

    // 重发一次。刷新失败或仍然 401 都直接抛给调用方——4xx 不在退避重试环的
    // 识别范围内，所以不会有第三次尝试。
    return await this.sendMessage(messages, tools, options);
  }
}
