/**
 * Provider abstraction layer 鈥?base types and abstract class.
 *
 * Defines the unified interfaces for tool calls, usage tracking,
 * provider responses, and the abstract BaseProvider contract.
 */

import type { ThinkingArtifact } from "../lib/thinking-artifact.js";

// ------------------------------------------------------------------
// Data interfaces
// ------------------------------------------------------------------

/** An image content block for multimodal messages. */
export interface ImageBlock {
  mediaType: string;   // e.g. "image/png", "image/jpeg"
  data: string;        // base64-encoded image data
}

/** A single tool invocation returned by a model. */
export interface ToolCall {
  id: string;
  name: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  parseError: string | null;
}

/** Normalized web search citation. */
export interface Citation {
  url: string;
  title: string;
  citedText?: string;
}

/** Provider-agnostic tool definition. */
export type ToolTuiPartialRevealPolicy =
  | "immediate"
  | "closed"
  | { completeArgs: string[] };

export interface ToolTuiPolicy {
  /**
   * When a partial tool call becomes eligible to render in the TUI.
   * Hidden/override decisions can still be applied at runtime by Session.
   */
  partialReveal?: ToolTuiPartialRevealPolicy;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the function arguments. */
  parameters: Record<string, unknown>;
  /**
   * Format string for one-line summaries of tool invocations.
   * `{agent}` is always available; other placeholders map to argument keys.
   */
  summaryTemplate?: string;
  /** Local-only TUI behavior hints; never forwarded to providers. */
  tuiPolicy?: ToolTuiPolicy;
}

// ------------------------------------------------------------------
// Message type for conversation messages
// ------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool" | "tool_result";

export interface Message {
  role: MessageRole;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// ------------------------------------------------------------------
// Options for sendMessage
// ------------------------------------------------------------------

export interface SendMessageOptions {
  temperature?: number;
  maxTokens?: number;
  onTextChunk?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  /** Fired as a tool call becomes visible and its raw JSON argument buffer evolves. */
  onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
  /** Fired when a tool call is closed and canonicalized by the provider. */
  onToolCallClosed?: (call: ToolCall) => void;
  signal?: AbortSignal;
  /** Unified thinking level string ("off", "low", "medium", "high", "adaptive", etc.) */
  thinkingLevel?: string;
  /** Routing key for OpenAI prompt cache affinity (e.g. child session id). */
  promptCacheKey?: string;
}

// ------------------------------------------------------------------
// Classes with computed properties
// ------------------------------------------------------------------

/** Token usage tracker. */
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

/** Unified response from any provider. */
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

/** Extended tool execution result with optional metadata. */
export class ToolResult {
  content: string;
  actionHint?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  /**
   * Optional multimodal content blocks for providers that support them
   * (e.g. Anthropic tool_result with image blocks).
   * When present, providers should use these instead of `content` string.
   * The `content` string still serves as the text fallback / TUI display.
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
// Partial JSON recovery for interrupted streaming
// ------------------------------------------------------------------

/**
 * Recover complete key-value pairs from a truncated JSON object string.
 * Used when streaming is interrupted mid-arguments.
 *
 * Strategy:
 * 1. Try normal JSON.parse (works if JSON is actually complete)
 * 2. Try appending common closers ("}", ""}", etc.) to close truncated values
 * 3. Truncate at the last top-level comma and close with "}"
 * 4. Fall back to {}
 */
export function recoverPartialArgs(partial: string): Record<string, unknown> {
  if (!partial) return {};

  // 1. Try normal parse
  try {
    const r = JSON.parse(partial);
    if (r && typeof r === "object" && !Array.isArray(r)) return r;
  } catch {}

  // 2. Try appending common closers
  for (const closer of ['"}', "}", '"]}'  , "null}"]) {
    try {
      const r = JSON.parse(partial + closer);
      if (r && typeof r === "object" && !Array.isArray(r)) return r;
    } catch {}
  }

  // 3. Truncate at last comma and close
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
// Abstract base provider
// ------------------------------------------------------------------

/**
 * Interface that every provider adapter must implement.
 */
export abstract class BaseProvider {
  /**
   * Whether this provider requires strictly alternating user/assistant roles.
   * When true, the rendering pipeline merges consecutive same-role messages.
   */
  readonly requiresAlternatingRoles: boolean = false;

  /**
   * How to calculate the token budget for compact detection.
   * - "subtract_output": budget = contextLength - maxOutputTokens (default)
   * - "full_context": budget = contextLength, check only inputTokens
   */
  readonly budgetCalcMode: "subtract_output" | "full_context" = "subtract_output";

  /**
   * Send a message to the model and return a unified response.
   */
  abstract sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;

  /**
   * Async send with optional streaming callbacks.
   *
   * Delegates to `sendMessage` with the full options object, including
   * streaming callbacks and abort signal.  Each provider's `sendMessage`
   * checks for `onTextChunk`/`onReasoningChunk` and routes to its
   * streaming implementation when present.
   */
  async asyncSendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    return this.sendMessage(messages, tools, options);
  }
}
