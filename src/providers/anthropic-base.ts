/**
 * Shared base for all providers that speak the Anthropic Messages API.
 *
 * Pure protocol mechanics live here: message/tool conversion, response parsing,
 * streaming event handling, and the strict-alternating-roles merge required by
 * /v1/messages. Vendor-specific behavior is exposed via protected hooks:
 *
 *   - _defaultBaseUrl()              鈥?fallback base URL when config has none
 *   - _applyThinkingParams()         鈥?write `thinking` / `output_config`
 *   - _applyCacheBreakpoint()        鈥?emit `cache_control` markers
 *   - _applySamplingParams()         鈥?write `temperature` (and friends)
 *   - _emitSignature()               鈥?keep `signature` on thinking blocks
 *   - _supportsBetas()               鈥?forward `betas` from config.extra
 *   - _convertWebSearchTool()        鈥?server-side web search tool shape
 *
 * Defaults are tuned for open-source vendors (Kimi / DeepSeek / MiniMax / Xiaomi):
 * no signature, no cache_control, no betas, no native server web search.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelConfig } from "../config/config.js";
import {
  BaseProvider,
  Citation,
  finalizeToolCall,
  ProviderResponse,
  ToolCall,
  Usage,
  type Message,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";
import {
  buildAnthropicPlainThinkingPayload,
  createThinkingArtifact,
  effectiveSealedSchema,
  effectiveThinkingEncryption,
  isAnthropicMessagesSealedPayload,
  resolveMessageThinkingArtifact,
  selectThinkingTransmission,
  SEALED_SCHEMA_ANTHROPIC_MESSAGES,
  type ThinkingArtifact,
} from "../lib/thinking-artifact.js";

export abstract class BaseAnthropicProvider extends BaseProvider {
  override readonly requiresAlternatingRoles = true;

  protected _config: ModelConfig;
  protected _client: Anthropic;

  constructor(config: ModelConfig) {
    super();
    this._config = config;
    const opts: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: config.apiKey,
    };
    const baseUrl = config.baseUrl || this._defaultBaseUrl();
    if (baseUrl) {
      opts.baseURL = baseUrl;
    }
    const wrappedFetch = this._wrapFetch();
    if (wrappedFetch) {
      opts.fetch = wrappedFetch;
    }
    this._client = new Anthropic(opts);
  }

  // ------------------------------------------------------------------
  // Vendor hooks 鈥?override in subclasses
  // ------------------------------------------------------------------

  /** Default base URL when none provided in config. */
  protected _defaultBaseUrl(): string | undefined {
    return undefined;
  }

  /**
   * Optional fetch wrapper for vendors whose streaming responses need to be
   * repaired before the SDK consumes them. Default: no wrapper (use the SDK's
   * own fetch). Override to return a wrapped fetch 鈥?see
   * `makeAnthropicSSERepairFetch`.
   */
  protected _wrapFetch():
    | ((url: string | URL | Request, init?: RequestInit) => Promise<Response>)
    | undefined {
    return undefined;
  }

  /** Whether to preserve / forward `signature` on thinking blocks. Anthropic-only. */
  protected _emitSignature(): boolean {
    return false;
  }

  /**
   * Whether this vendor prepends a synthetic "search preamble" text block (a
   * leading text block immediately followed by a server_tool_use web search)
   * that should not be shown to the user. Kimi does this on every web-search
   * turn (e.g. "Search results for query: ..."). When true, `_callStream`
   * buffers a leading text block and drops it if a server_tool_use follows.
   *
   * Note: the non-streaming `_parseResponse` and the streaming finalText
   * re-derivation already drop this block from the stored text via a
   * server_tool_use lookahead; this hook only governs the *live* stream so the
   * preamble never reaches `onTextChunk`.
   */
  protected _dropsLeadingSearchPreamble(): boolean {
    return false;
  }

  /** Whether `config.extra.betas` should be forwarded as request kwargs. Anthropic-only. */
  protected _supportsBetas(): boolean {
    return false;
  }

  /** Additional config.extra keys this provider wants forwarded verbatim. */
  protected _allowedExtraConfigKeys(): readonly string[] {
    return [];
  }

  /**
   * Vendor-specific thinking params. Default: respect "off"/"none" only.
   * Subclasses extend for effort / budget_tokens / adaptive behaviors.
   */
  protected _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;
    const level = options?.thinkingLevel;
    if (level === "off" || level === "none") {
      kwargs["thinking"] = { type: "disabled" };
      return;
    }
    kwargs["thinking"] = { type: "enabled" };
  }

  /**
   * Vendor-specific cache marker placement.  Default: no-op.
   * Most open-source vendors run automatic prefix caching server-side, so a
   * client-side cache_control marker is either silently ignored or unneeded.
   */
  protected _applyCacheBreakpoint(_kwargs: Record<string, unknown>): void {
    // no-op
  }

  /** Default sampling: take temperature from request or config. */
  protected _applySamplingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    const t = options?.temperature !== undefined ? options.temperature : this._config.temperature;
    if (t !== undefined) {
      kwargs["temperature"] = t;
    }
  }

  /**
   * Translate the unified `web_search` tool into a server-side native tool.
   * Default: register as a regular function tool. Anthropic itself uses
   * `web_search_20250305`.
   */
  protected _convertWebSearchTool(): Record<string, unknown> | null {
    return null;
  }

  // ------------------------------------------------------------------
  // Tool conversion
  // ------------------------------------------------------------------

  protected _convertTools(tools: ToolDef[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const t of tools) {
      if (t.name === "web_search" && this._config.supportsWebSearch) {
        const native = this._convertWebSearchTool();
        if (native) {
          result.push(native);
          continue;
        }
      }
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      });
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Message conversion
  // ------------------------------------------------------------------

  protected _convertMessages(
    messages: Message[],
  ): { system: string | null; converted: Record<string, unknown>[] } {
    let system: string | null = null;
    const converted: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = msg.content as string;
      } else if ((msg as Record<string, unknown>)["role"] === "tool_result") {
        const m = msg as Record<string, unknown>;
        converted.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m["tool_call_id"],
              content: m["content"],
            },
          ],
        });
      } else if (
        msg.role === "assistant" &&
        (msg as Record<string, unknown>)["tool_calls"]
      ) {
        const m = msg as Record<string, unknown>;
        const content: Record<string, unknown>[] = [];
        const transmission = selectThinkingTransmission(
          resolveMessageThinkingArtifact(m),
          effectiveThinkingEncryption(this._config),
          effectiveSealedSchema(this._config),
        );
        if (transmission?.kind === "sealed" && Array.isArray(transmission.payload)) {
          for (const rb of transmission.payload) {
            content.push(this._sanitizeReasoningBlock(rb as Record<string, unknown>));
          }
        } else if (transmission?.kind === "plain") {
          content.push(...buildAnthropicPlainThinkingPayload(transmission.plainReplayText));
        }
        const text = (m["text"] as string) || (m["content"] as string) || "";
        if (text) {
          content.push({ type: "text", text });
        }
        const toolCalls = m["tool_calls"] as Record<string, unknown>[];
        for (const tc of toolCalls) {
          content.push({
            type: "tool_use",
            id: tc["id"],
            name: tc["name"],
            input: tc["arguments"],
          });
        }
        converted.push({ role: "assistant", content });
      } else if (msg.role === "assistant") {
        const m = msg as Record<string, unknown>;
        const content: Record<string, unknown>[] = [];
        const transmission = selectThinkingTransmission(
          resolveMessageThinkingArtifact(m),
          effectiveThinkingEncryption(this._config),
          effectiveSealedSchema(this._config),
        );
        if (transmission?.kind === "sealed" && Array.isArray(transmission.payload)) {
          for (const rb of transmission.payload) {
            content.push(this._sanitizeReasoningBlock(rb as Record<string, unknown>));
          }
        } else if (transmission?.kind === "plain") {
          content.push(...buildAnthropicPlainThinkingPayload(transmission.plainReplayText));
        }
        const text =
          (m["content"] as string) || (m["text"] as string) || "";
        if (text) {
          content.push({ type: "text", text });
        }
        if (content.length > 0) {
          converted.push({ role: "assistant", content });
        }
      } else {
        const rawContent = msg.content;
        if (Array.isArray(rawContent)) {
          const parts: Record<string, unknown>[] = [];
          for (const block of rawContent) {
            const b = block as Record<string, unknown>;
            if (b["type"] === "text") {
              parts.push({ type: "text", text: b["text"] });
            } else if (b["type"] === "image") {
              parts.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: b["media_type"],
                  data: b["data"],
                },
              });
            }
          }
          converted.push({ role: msg.role, content: parts });
        } else {
          converted.push({ role: msg.role, content: rawContent });
        }
      }
    }

    // Strict alternation merge: multiple tool_result turns (all role:"user")
    // and a following real user message must collapse into one user message
    // with combined content blocks.
    const merged: Record<string, unknown>[] = [];
    for (const msg of converted) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : null;
      if (prev && prev["role"] === msg["role"] && msg["role"] === "user") {
        const prevContent = prev["content"];
        const curContent = msg["content"];
        if (Array.isArray(prevContent) && Array.isArray(curContent)) {
          prev["content"] = [...prevContent, ...curContent];
        } else if (Array.isArray(prevContent)) {
          prev["content"] = [
            ...prevContent,
            { type: "text", text: String(curContent) },
          ];
        } else if (Array.isArray(curContent)) {
          prev["content"] = [
            { type: "text", text: String(prevContent) },
            ...curContent,
          ];
        } else {
          prev["content"] = `${prevContent}\n\n${curContent}`;
        }
      } else {
        merged.push(msg);
      }
    }

    return { system, converted: merged };
  }

  /**
   * Strip vendor-incompatible fields from a stored reasoning block before
   * sending it back. Subclasses that need `signature` round-trip override
   * _emitSignature() to true.
   */
  private _sanitizeReasoningBlock(block: Record<string, unknown>): Record<string, unknown> {
    const type = block["type"] as string;
    if (type === "thinking") {
      const out: Record<string, unknown> = {
        type: "thinking",
        thinking: block["thinking"] ?? "",
      };
      if (this._emitSignature() && typeof block["signature"] === "string" && block["signature"] !== "") {
        out["signature"] = block["signature"];
      }
      return out;
    }
    if (type === "redacted_thinking") {
      return {
        type: "redacted_thinking",
        data: block["data"] ?? "",
      };
    }
    return block;
  }

  protected _buildThinkingArtifact(
    plainReplayText: string,
    reasoningBlocks: unknown,
  ): ThinkingArtifact | null {
    const targetEncryption = effectiveThinkingEncryption(this._config);
    const replayText = plainReplayText.trim();
    if (!replayText && (reasoningBlocks === undefined || reasoningBlocks === null)) {
      return null;
    }
    if (targetEncryption === "anthropic" && isAnthropicMessagesSealedPayload(reasoningBlocks)) {
      return createThinkingArtifact(
        "anthropic",
        replayText,
        reasoningBlocks,
        SEALED_SCHEMA_ANTHROPIC_MESSAGES,
      );
    }
    return createThinkingArtifact("none", replayText);
  }

  // ------------------------------------------------------------------
  // Response parsing
  // ------------------------------------------------------------------

  protected _parseResponse(resp: Anthropic.Message): ProviderResponse {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const reasoningBlocks: Record<string, unknown>[] = [];
    const toolCalls: ToolCall[] = [];
    const citations: Citation[] = [];

    const blocks = resp.content;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === "text") {
        // Drop server-tool-use preamble text. Some vendors (notably Kimi via
        // /anthropic with web_search_20250305) emit an internal "Search results
        // for query: ..." text block immediately before the server_tool_use
        // block. Native Anthropic does not. Filter the noise so the agent's
        // text field stays clean.
        const next = blocks[i + 1];
        if (next && (next as unknown as Record<string, unknown>)["type"] === "server_tool_use") {
          continue;
        }
        textParts.push(block.text);
        const blockAny = block as unknown as Record<string, unknown>;
        if (blockAny["citations"] && Array.isArray(blockAny["citations"])) {
          for (const c of blockAny["citations"] as Record<string, unknown>[]) {
            citations.push({
              url: (c["url"] as string) || "",
              title: (c["title"] as string) || "",
              citedText: (c["cited_text"] as string) || "",
            });
          }
        }
      } else if (block.type === "thinking") {
        thinkingParts.push(block.thinking);
        const stored: Record<string, unknown> = {
          type: "thinking",
          thinking: block.thinking,
        };
        if (this._emitSignature()) {
          stored["signature"] = (block as unknown as Record<string, unknown>)["signature"] || "";
        }
        reasoningBlocks.push(stored);
      } else if (block.type === "redacted_thinking") {
        reasoningBlocks.push({
          type: "redacted_thinking",
          data: (block as unknown as Record<string, unknown>)["data"] || "",
        });
      } else if (block.type === "tool_use") {
        const input = block.input;
        if (typeof input === "object" && input !== null) {
          toolCalls.push({
            id: block.id,
            name: block.name,
            rawArguments: JSON.stringify(input),
            arguments: input as Record<string, unknown>,
            parseError: null,
          });
        } else {
          toolCalls.push(finalizeToolCall(block.id, block.name, String(input ?? ""), `${block.name} response`));
        }
      }
      // server_tool_use, web_search_tool_result 鈥?handled transparently
    }

    const respUsage = resp.usage as unknown as Record<string, number> | undefined;
    const cacheCreation = respUsage?.["cache_creation_input_tokens"] ?? 0;
    const cacheRead = respUsage?.["cache_read_input_tokens"] ?? 0;
    const usage = new Usage(
      (resp.usage?.input_tokens ?? 0) + cacheCreation + cacheRead,
      resp.usage?.output_tokens ?? 0,
      cacheCreation,
      cacheRead,
    );

    const storedReasoningState = effectiveThinkingEncryption(this._config) === "anthropic"
      ? (reasoningBlocks.length > 0 ? reasoningBlocks : null)
      : (thinkingParts.length > 0 ? thinkingParts.join("") : null);

    return new ProviderResponse({
      text: textParts.join(""),
      toolCalls,
      usage,
      raw: resp,
      reasoningContent: thinkingParts.length > 0 ? thinkingParts.join("") : "",
      reasoningState: storedReasoningState,
      thinkingArtifact: this._buildThinkingArtifact(
        thinkingParts.length > 0 ? thinkingParts.join("") : "",
        reasoningBlocks.length > 0 ? reasoningBlocks : null,
      ),
      citations,
    });
  }

  // ------------------------------------------------------------------
  // Core API call
  // ------------------------------------------------------------------

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { system, converted } = this._convertMessages(messages);

    const kwargs: Record<string, unknown> = {
      model: this._config.model,
      messages: converted,
      max_tokens: options?.maxTokens || this._config.maxTokens,
    };
    this._applySamplingParams(kwargs, options);
    if (system) {
      kwargs["system"] = system;
    }
    if (tools && tools.length > 0) {
      kwargs["tools"] = this._convertTools(tools);
    }
    this._forwardExtraConfig(kwargs);
    this._applyThinkingParams(kwargs, options);
    this._applyCacheBreakpoint(kwargs);

    if (options?.onTextChunk || options?.onReasoningChunk || options?.onToolCallPartial) {
      return this._callStream(
        kwargs,
        options.onTextChunk,
        options.onReasoningChunk,
        options?.signal,
        options?.onToolCallPartial,
        options?.onToolCallClosed,
      );
    }

    const resp = await this._client.messages.create(
      kwargs as unknown as Anthropic.MessageCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
    return this._parseResponse(resp);
  }

  /**
   * Merge `config.extra` into request kwargs.  Drops `betas` unless the
   * subclass opts in via _supportsBetas(). Everything else must be explicitly
   * whitelisted by the subclass to avoid leaking old Chat/Responses-only
   * fields (`extra_body`, `reasoning_effort`, `web_search_options`, `top_p`,
   * etc.) into Anthropic Messages requests.
   */
  private _forwardExtraConfig(kwargs: Record<string, unknown>): void {
    if (!this._config.extra) return;
    const allowed = new Set(this._allowedExtraConfigKeys());
    for (const [k, v] of Object.entries(this._config.extra)) {
      if (k === "betas") {
        if (this._supportsBetas()) {
          kwargs[k] = v;
        }
        continue;
      }
      if (!allowed.has(k)) continue;
      kwargs[k] = v;
    }
  }

  // ------------------------------------------------------------------
  // Streaming
  // ------------------------------------------------------------------

  protected async _callStream(
    kwargs: Record<string, unknown>,
    onTextChunk?: (chunk: string) => void,
    onReasoningChunk?: (chunk: string) => void,
    signal?: AbortSignal,
    onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void,
    onToolCallClosed?: (call: ToolCall) => void,
  ): Promise<ProviderResponse> {
    const emitSignature = this._emitSignature();
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const reasoningBlocks: Record<string, unknown>[] = [];
    const citations: Citation[] = [];

    let currentThinking: Record<string, string> | null = null;
    const indexToBlockId = new Map<number, string>();
    const blockNameById = new Map<string, string>();
    const toolJsonById = new Map<string, string>();

    // Leading-search-preamble suppression (e.g. Kimi). We buffer a leading text
    // block and only release it once we see the following block: if that block
    // is a server_tool_use web search, the text was a synthetic preamble and we
    // drop it; otherwise we flush it. Only the very first block is ever buffered,
    // so the real answer (which follows thinking / search) always streams live.
    const dropLeadingPreamble = this._dropsLeadingSearchPreamble();
    let forwardedFirstBlock = false;
    let pendingLeading: { index: number; text: string } | null = null;
    const flushPendingLeading = () => {
      if (pendingLeading && pendingLeading.text) {
        textParts.push(pendingLeading.text);
        if (onTextChunk) onTextChunk(pendingLeading.text);
      }
      pendingLeading = null;
    };

    const stream = this._client.messages.stream(
      kwargs as unknown as Anthropic.MessageCreateParamsStreaming,
      signal ? { signal } : undefined,
    );

    for await (const event of stream) {
      const eventType = (event as unknown as Record<string, unknown>)["type"] as string;

      if (eventType === "content_block_start") {
        const index = (event as unknown as Record<string, unknown>)["index"] as number | undefined;
        const block = (event as unknown as Record<string, unknown>)[
          "content_block"
        ] as Record<string, unknown> | undefined;
        const blockType = block?.["type"] as string | undefined;

        // Resolve a buffered leading text block now that we know what follows it.
        if (pendingLeading !== null) {
          if (blockType === "server_tool_use") {
            // Leading text immediately followed by a server web search 鈫?it was
            // a synthetic preamble. Drop it (never reached onTextChunk).
            pendingLeading = null;
          } else {
            flushPendingLeading();
          }
          forwardedFirstBlock = true;
        }

        // Begin buffering a brand-new leading text block (candidate preamble).
        if (dropLeadingPreamble && !forwardedFirstBlock && blockType === "text") {
          pendingLeading = { index: index ?? -1, text: "" };
        } else if (blockType !== undefined) {
          forwardedFirstBlock = true;
        }

        if (block?.["type"] === "thinking") {
          currentThinking = emitSignature
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "thinking", thinking: "" };
        } else if (block?.["type"] === "redacted_thinking") {
          reasoningBlocks.push({
            type: "redacted_thinking",
            data: (block["data"] as string) || "",
          });
        } else if (block?.["type"] === "tool_use") {
          const blockId = (block["id"] as string) || "";
          const blockName = (block["name"] as string) || "";
          if (index !== undefined && blockId) {
            indexToBlockId.set(index, blockId);
          }
          if (blockId && !toolJsonById.has(blockId)) {
            toolJsonById.set(blockId, "");
          }
          if (blockId && blockName) {
            blockNameById.set(blockId, blockName);
            onToolCallPartial?.(blockId, blockName, toolJsonById.get(blockId) ?? "");
          }
        }
      } else if (eventType === "content_block_delta") {
        const index = (event as unknown as Record<string, unknown>)["index"] as number | undefined;
        const delta = (event as unknown as Record<string, unknown>)["delta"] as
          | Record<string, unknown>
          | undefined;
        if (!delta) continue;
        const deltaType = delta["type"] as string;
        if (deltaType === "thinking_delta") {
          const text = (delta["thinking"] as string) || "";
          if (text) {
            thinkingParts.push(text);
            if (currentThinking) currentThinking["thinking"] += text;
            if (onReasoningChunk) onReasoningChunk(text);
          }
        } else if (deltaType === "text_delta") {
          const text = (delta["text"] as string) || "";
          if (text) {
            if (pendingLeading !== null && index === pendingLeading.index) {
              // Buffer instead of emitting 鈥?may be a search preamble.
              pendingLeading.text += text;
            } else {
              textParts.push(text);
              if (onTextChunk) onTextChunk(text);
            }
          }
        } else if (deltaType === "signature_delta") {
          if (emitSignature) {
            const sig = (delta["signature"] as string) || "";
            if (sig && currentThinking) currentThinking["signature"] += sig;
          }
        } else if (deltaType === "input_json_delta") {
          const partial = (delta["partial_json"] as string) || "";
          if (partial && onToolCallPartial && index !== undefined) {
            const blockId = indexToBlockId.get(index);
            if (blockId) {
              const merged = (toolJsonById.get(blockId) ?? "") + partial;
              toolJsonById.set(blockId, merged);
              const blockName = blockNameById.get(blockId);
              if (blockName) {
                onToolCallPartial(blockId, blockName, merged);
              }
            }
          }
        }
      } else if (eventType === "content_block_stop") {
        if (currentThinking) {
          reasoningBlocks.push(currentThinking);
          currentThinking = null;
        }
        const index = (event as unknown as Record<string, unknown>)["index"] as number | undefined;
        if (index !== undefined) {
          const blockId = indexToBlockId.get(index);
          const blockName = blockId ? blockNameById.get(blockId) : undefined;
          if (blockId && blockName && onToolCallClosed) {
            onToolCallClosed(finalizeToolCall(
              blockId,
              blockName,
              toolJsonById.get(blockId) ?? "",
              `${blockName} stream`,
            ));
          }
        }
      }
    }

    // A leading text block that was never followed by another block (i.e. it is
    // the whole message, not a preamble) is still buffered 鈥?release it now.
    flushPendingLeading();

    const response = await stream.finalMessage();

    // Re-derive the final text from the parsed message so the preamble filter
    // (drop text blocks immediately followed by server_tool_use) applies to
    // both streaming and non-streaming paths. The streamed `textParts` array
    // is built from raw deltas without lookahead, so it would otherwise
    // include vendor preambles like Kimi's "Search results for query: ...".
    let finalText = "";
    {
      const respBlocks = response.content;
      for (let i = 0; i < respBlocks.length; i++) {
        const block = respBlocks[i];
        if (block.type === "text") {
          const next = respBlocks[i + 1];
          if (next && (next as unknown as Record<string, unknown>)["type"] === "server_tool_use") {
            continue;
          }
          finalText += block.text;
          const blockAny = block as unknown as Record<string, unknown>;
          if (blockAny["citations"] && Array.isArray(blockAny["citations"])) {
            for (const c of blockAny["citations"] as Record<string, unknown>[]) {
              citations.push({
                url: (c["url"] as string) || "",
                title: (c["title"] as string) || "",
                citedText: (c["cited_text"] as string) || "",
              });
            }
          }
        }
      }
    }
    // Fallback if the final message can't be inspected for some reason
    if (!finalText && textParts.length > 0) {
      finalText = textParts.join("");
    }

    const streamUsage = response.usage as unknown as Record<string, number> | undefined;
    const streamCacheCreation = streamUsage?.["cache_creation_input_tokens"] ?? 0;
    const streamCacheRead = streamUsage?.["cache_read_input_tokens"] ?? 0;
    const usage = new Usage(
      (response.usage?.input_tokens ?? 0) + streamCacheCreation + streamCacheRead,
      response.usage?.output_tokens ?? 0,
      streamCacheCreation,
      streamCacheRead,
    );

    const reasoningText = thinkingParts.length > 0 ? thinkingParts.join("") : "";
    const storedReasoningState = effectiveThinkingEncryption(this._config) === "anthropic"
      ? (reasoningBlocks.length > 0 ? reasoningBlocks : null)
      : (reasoningText || null);

    return new ProviderResponse({
      text: finalText,
      toolCalls: [],
      usage,
      raw: response,
      reasoningContent: reasoningText,
      reasoningState: storedReasoningState,
      thinkingArtifact: this._buildThinkingArtifact(reasoningText, reasoningBlocks.length > 0 ? reasoningBlocks : null),
      citations,
    });
  }
}
