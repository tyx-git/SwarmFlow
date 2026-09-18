/**
 * 所有使用 Anthropic Messages API 的提供者共享的基类。
 *
 * 纯协议机制位于此处：消息/工具转换、响应解析、
 * 流式事件处理，以及 /v1/messages 要求的严格角色交替合并。
 * 供应商特定行为通过 protected 钩子暴露：
 *
 *   - _defaultBaseUrl()              — 配置未提供时的备用 base URL
 *   - _applyThinkingParams()         — 写入 `thinking` / `output_config`
 *   - _applyCacheBreakpoint()        — 发出 `cache_control` 标记
 *   - _applySamplingParams()         — 写入 `temperature` 等采样参数
 *   - _emitSignature()               — 保留 thinking 块上的 `signature`
 *   - _supportsBetas()               — 从 config.extra 转发 `betas`
 *   - _convertWebSearchTool()        — 服务端网页搜索工具形状
 *
 * 默认值面向开源供应商（Kimi / DeepSeek / MiniMax / Xiaomi）调优：
 * 无 signature、无 cache_control、无 betas、无原生服务端网页搜索。
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
  // 供应商钩子 — 在子类中覆盖
  // ------------------------------------------------------------------

  /** 配置中未提供时的默认 base URL。 */
  protected _defaultBaseUrl(): string | undefined {
    return undefined;
  }

  /**
   * 可选 fetch 包装器，用于流式响应需要在 SDK 消费前修复的供应商。
   * 默认无包装器（使用 SDK 自带 fetch）。覆盖后返回包装后的 fetch — 见
   * `makeAnthropicSSERepairFetch`。
   */
  protected _wrapFetch():
    | ((url: string | URL | Request, init?: RequestInit) => Promise<Response>)
    | undefined {
    return undefined;
  }

  /** 是否保留/转发 thinking 块上的 `signature`。仅 Anthropic。 */
  protected _emitSignature(): boolean {
    return false;
  }

  /**
   * 此供应商是否会预置不应显示给用户的合成“搜索前言”文本块
   *（一个紧接 server_tool_use 网页搜索的前导文本块）。
   * Kimi 在每个网页搜索回合都会这样做（例如“Search results for query: ...”）。
   * 为 true 时，`_callStream` 会缓冲前导文本块，并在后续是 server_tool_use 时丢弃它。
   *
   * 注意：非流式 `_parseResponse` 和流式 finalText 重新派生已经通过
   * server_tool_use 前瞻从存储文本中丢弃此块；此钩子只控制*实时*流，
   * 确保前言永远不会到达 `onTextChunk`。
   */
  protected _dropsLeadingSearchPreamble(): boolean {
    return false;
  }

  /** 是否应将 `config.extra.betas` 作为请求 kwargs 转发。仅 Anthropic。 */
  protected _supportsBetas(): boolean {
    return false;
  }

  /** 此提供者希望逐字转发的额外 config.extra 键。 */
  protected _allowedExtraConfigKeys(): readonly string[] {
    return [];
  }

  /**
   * 供应商特定的思考参数。默认仅尊重 "off"/"none"。
   * 子类扩展 effort / budget_tokens / 自适应行为。
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
   * 供应商特定的缓存标记放置。默认：no-op。
   * 大多数开源供应商在服务端运行自动前缀缓存，因此客户端 cache_control
   * 标记要么被静默忽略，要么并不需要。
   */
  protected _applyCacheBreakpoint(_kwargs: Record<string, unknown>): void {
    // 无操作
  }

  /** 默认采样：从请求或配置获取 temperature。 */
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
   * 将统一的 `web_search` 工具翻译为服务端原生工具。
   * 默认：注册为常规函数工具。Anthropic 自身使用
   * `web_search_20250305`。
   */
  protected _convertWebSearchTool(): Record<string, unknown> | null {
    return null;
  }

  // ------------------------------------------------------------------
  // 工具转换
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
  // 消息转换
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

    // 严格交替合并：多个 tool_result 回合（全部 role:"user"）
    // 以及后续的真实用户消息必须折叠为一条用户消息，
    // 并合并内容块。
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
   * 发送回去之前，从存储的 reasoning 块中剥离供应商不兼容字段。
   * 需要 `signature` 往返的子类将 _emitSignature() 覆盖为 true。
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
  // 响应解析
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
        // 丢弃 server-tool-use 前言文本。一些供应商（尤其是通过 /anthropic
        // 使用 web_search_20250305 的 Kimi）会在 server_tool_use 块前立即发出
        // 内部的 "Search results for query: ..." 文本块。原生 Anthropic 不会这样做。
        // 过滤这些噪声，让 agent 的 text 字段保持干净。
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
      // server_tool_use、web_search_tool_result — 透明处理
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
  // 核心 API 调用
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
   * 将 `config.extra` 合并到请求 kwargs 中。除非子类通过 _supportsBetas() 选择加入，
   * 否则丢弃 `betas`。其他所有字段都必须由子类显式列入白名单，以避免将旧的
   * 仅 Chat/Responses 使用的字段（`extra_body`、`reasoning_effort`、
   * `web_search_options`、`top_p` 等）泄漏到 Anthropic Messages 请求中。
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
  // 流式传输
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

    // 抑制前导搜索前言（例如 Kimi）。我们缓冲一个前导文本块，
    // 只有看到后续块后才释放：如果后续块是 server_tool_use 网页搜索，
    // 该文本就是合成前言并会被丢弃；否则刷新它。只有第一个块会被缓冲，
    // 因此真正答案（跟在 thinking/search 之后）始终实时流式输出。
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

        // 既然知道后续内容，就解析已缓冲的前导文本块。
        if (pendingLeading !== null) {
          if (blockType === "server_tool_use") {
            // 前导文本紧跟服务端网页搜索 → 它是合成前言。
            // 丢弃它（永远不会到达 onTextChunk）。
            pendingLeading = null;
          } else {
            flushPendingLeading();
          }
          forwardedFirstBlock = true;
        }

        // 开始缓冲一个全新的前导文本块（候选前言）。
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
              // Buffer instead of emitting —may be a search preamble.
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
    // the whole message, not a preamble) is still buffered —release it now.
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
