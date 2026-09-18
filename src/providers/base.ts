/**
 * 提供者抽象层 — 基础类型和抽象类。
 *
 * 定义工具调用、使用跟踪、
 * 提供者响应和抽象 BaseProvider 合约的统一接口。
 */

import type { ThinkingArtifact } from "../lib/thinking-artifact.js";

// ------------------------------------------------------------------
// 数据接口
// ------------------------------------------------------------------

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

  constructor(inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0) {
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.cacheCreationTokens = cacheCreationTokens;
    this.cacheReadTokens = cacheReadTokens;
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
   * 带可选流式回调的异步发送。
   *
   * 使用完整 options 对象委托给 `sendMessage`，其中包括
   * 流式回调和中止信号。每个提供者的 `sendMessage`
   * 会检查 `onTextChunk`/`onReasoningChunk`，存在时路由到其
   * 流式实现。
   */
  async asyncSendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    return this.sendMessage(messages, tools, options);
  }
}
