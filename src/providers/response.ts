/** provider 统一响应的值对象：用量、响应体、工具执行结果。 */

import type { ThinkingArtifact } from "../thinking/artifact.js";

import { type StopReason } from "./stop-reason.js";
import { type Citation, type ToolCall } from "./types.js";

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
