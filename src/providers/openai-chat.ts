/**
 * OpenAI Chat Completions API 提供者。
 *
 * 也作为使用 OpenAI 兼容端点的 Kimi、GLM、MiniMax
 * 和 OpenRouter 提供者的基类。
 */

import OpenAI from "openai";
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
  createThinkingArtifact,
  effectiveSealedSchema,
  effectiveThinkingEncryption,
  resolveMessageThinkingArtifact,
  selectThinkingTransmission,
  type ThinkingArtifact,
} from "../lib/thinking-artifact.js";

type ToolArgsMode = "legacy" | "auto";

export class OpenAIChatProvider extends BaseProvider {
  protected _config: ModelConfig;
  protected _client: OpenAI;
  private _toolArgsMode: ToolArgsMode;

  constructor(config: ModelConfig) {
    super();
    this._config = config;
    this._client = this._buildClient(config);
    this._toolArgsMode = this._resolveToolArgsMode();
  }

  protected _buildClient(config: ModelConfig): OpenAI {
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: config.apiKey,
    };
    if (config.baseUrl) {
      opts.baseURL = config.baseUrl;
    }
    return new OpenAI(opts);
  }

  protected _buildThinkingArtifact(
    plainReplayText: string,
    reasoningState: unknown,
  ): ThinkingArtifact | null {
    const targetEncryption = effectiveThinkingEncryption(this._config);
    const replayText = plainReplayText.trim();
    if (!replayText && (reasoningState === undefined || reasoningState === null)) {
      return null;
    }
    const sealedPayload =
      targetEncryption !== "none" &&
      reasoningState !== undefined &&
      reasoningState !== null &&
      reasoningState !== plainReplayText &&
      reasoningState !== replayText
        ? reasoningState
        : undefined;
    // Base OpenAIChatProvider 不知道其密封负载遵循的线路格式 schema —
    // 发出密封负载的子类（例如 OpenRouter 包装其 reasoning_details 数组）
    // 会覆盖 _buildThinkingArtifact 或在自己路径中设置 schema。
    // 没有已知 schema 我们无法安全地往返密封数据，所以
    // 我们在这里省略 schema 标签 — 与密封选择中省略的效果相同。
    const sealedSchema = this._sealedSchemaForChatProvider();
    return createThinkingArtifact(targetEncryption, replayText, sealedPayload, sealedSchema);
  }

  /** 在子类中覆盖（例如 OpenRouter）以声明密封 schema。 */
  protected _sealedSchemaForChatProvider(): string | null {
    return null;
  }

  private _resolveToolArgsMode(): ToolArgsMode {
    const raw = process.env["SWARMFLOW_TOOL_ARGS_MODE"]?.trim().toLowerCase();
    if (raw === "legacy" || raw === "auto") {
      return raw;
    }
    return "auto";
  }

  private _mergeToolArgsChunk(previous: string, incoming: string): string {
    if (!incoming) return previous;
    if (this._toolArgsMode === "legacy") {
      return previous + incoming;
    }
    if (!previous) {
      return incoming;
    }
    if (incoming.startsWith(previous)) {
      return incoming;
    }
    return previous + incoming;
  }

  // ------------------------------------------------------------------
  // 工具转换
  // ------------------------------------------------------------------

  protected _convertTools(
    tools: ToolDef[],
  ): { toolsList: Record<string, unknown>[]; hasNativeWebSearch: boolean } {
    const result: Record<string, unknown>[] = [];
    let hasWebSearch = false;
    for (const t of tools) {
      if (t.name === "web_search") {
        if (this._config.supportsWebSearch) {
          hasWebSearch = true;
          continue;
        }
        // 没有原生支持 — 继续注册为常规函数工具
      }
      result.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      });
    }
    return { toolsList: result, hasNativeWebSearch: hasWebSearch };
  }

  // ------------------------------------------------------------------
  // 消息转换
  // ------------------------------------------------------------------

  protected _convertMessages(messages: Message[]): Record<string, unknown>[] {
    const converted: Record<string, unknown>[] = [];

    for (const msg of messages) {
      const m = msg as Record<string, unknown>;

      if (m["role"] === "tool_result") {
        // OpenAI Chat API 工具结果仅接受字符串内容；
        // 如果存在，则从多模态内容块中提取文本。
        const rawContent = m["content"];
        const textContent = Array.isArray(rawContent)
          ? (rawContent as Array<Record<string, unknown>>)
              .filter((b) => b["type"] === "text")
              .map((b) => b["text"] as string)
              .join("\n") || String(rawContent)
          : rawContent;
        const entry: Record<string, unknown> = {
          role: "tool",
          tool_call_id: m["tool_call_id"],
          content: textContent,
        };
        if (m["tool_name"]) {
          entry["name"] = m["tool_name"];
        }
        converted.push(entry);
      } else if (m["role"] === "assistant" && m["tool_calls"]) {
        const toolCallsOai: Record<string, unknown>[] = [];
        for (const tc of m["tool_calls"] as Record<string, unknown>[]) {
          const tcName = tc["name"] as string;
          let tcType = tc["type"] as string | undefined;
          if (tcType !== "function" && tcType !== "builtin_function") {
            tcType =
              typeof tcName === "string" && tcName.startsWith("$")
                ? "builtin_function"
                : "function";
          }
          toolCallsOai.push({
            id: tc["id"],
            type: tcType,
            function: {
              name: tcName,
              arguments: JSON.stringify(tc["arguments"]),
            },
          });
        }
        const entry: Record<string, unknown> = {
          role: "assistant",
          tool_calls: toolCallsOai,
        };
        const text = (m["text"] as string) || (m["content"] as string) || "";
        if (text) {
          entry["content"] = text;
        }
        const transmission = selectThinkingTransmission(
          resolveMessageThinkingArtifact(m),
          effectiveThinkingEncryption(this._config),
          effectiveSealedSchema(this._config),
        );
        if (transmission?.kind === "plain") {
          entry["reasoning_content"] = transmission.plainReplayText;
        } else if ("reasoning_content" in m) {
          entry["reasoning_content"] = m["reasoning_content"];
        } else if (this._config.supportsThinking) {
          entry["reasoning_content"] = "";
        }
        converted.push(entry);
      } else if (m["role"] === "assistant") {
        const text = (m["content"] as string) || (m["text"] as string) || "";
        const entry: Record<string, unknown> = {
          role: "assistant",
          content: text,
        };
        const transmission = selectThinkingTransmission(
          resolveMessageThinkingArtifact(m),
          effectiveThinkingEncryption(this._config),
          effectiveSealedSchema(this._config),
        );
        if (transmission?.kind === "plain") {
          entry["reasoning_content"] = transmission.plainReplayText;
        } else if ("reasoning_content" in m) {
          entry["reasoning_content"] = m["reasoning_content"];
        }
        converted.push(entry);
      } else {
        const content = m["content"];
        if (Array.isArray(content)) {
          const parts: Record<string, unknown>[] = [];
          for (const block of content as Record<string, unknown>[]) {
            if (block["type"] === "text") {
              parts.push({ type: "text", text: block["text"] });
            } else if (block["type"] === "image") {
              const dataUri = `data:${block["media_type"]};base64,${block["data"]}`;
              parts.push({
                type: "image_url",
                image_url: { url: dataUri },
              });
            }
          }
          converted.push({ role: m["role"], content: parts });
        } else {
          converted.push({ role: m["role"], content });
        }
      }
    }

    return converted;
  }

  // ------------------------------------------------------------------
  // 响应解析
  // ------------------------------------------------------------------

  private _parseResponse(resp: OpenAI.Chat.Completions.ChatCompletion): ProviderResponse {
    const choice = resp.choices[0];
    const message = choice.message;

    const text = message.content || "";
    const toolCalls: ToolCall[] = [];

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        toolCalls.push(finalizeToolCall(
          tc.id,
          tc.function.name,
          tc.function.arguments ?? "",
          `${tc.function.name} response`,
        ));
      }
    }

    let usage = new Usage();
    if (resp.usage) {
      const promptDetails = (resp.usage as unknown as Record<string, unknown>)["prompt_tokens_details"] as Record<string, number> | undefined;
      usage = new Usage(
        resp.usage.prompt_tokens ?? 0,
        resp.usage.completion_tokens ?? 0,
        0, // OpenAI 没有缓存创建
        promptDetails?.["cached_tokens"] ?? 0,
      );
    }

    // 如果存在则捕获 reasoning_content（Kimi: reasoning_content，Ollama: reasoning）
    const msgRecord = message as unknown as Record<string, unknown>;
    const reasoning =
      (msgRecord["reasoning_content"] as string) || (msgRecord["reasoning"] as string) || "";

    // 从注释中提取网络搜索引用（url_citation）
    const annotations =
      ((message as unknown as Record<string, unknown>)["annotations"] as Record<string, unknown>[]) || [];
    const citations: Citation[] = [];
    for (const ann of annotations) {
      if (ann["type"] === "url_citation") {
        citations.push({
          url: (ann["url"] as string) || "",
          title: (ann["title"] as string) || "",
        });
      }
    }

    return new ProviderResponse({
      text,
      toolCalls,
      usage,
      raw: resp,
      reasoningContent: reasoning,
      reasoningState: reasoning || null,
      thinkingArtifact: this._buildThinkingArtifact(reasoning, reasoning || null),
      citations,
    });
  }

  // ------------------------------------------------------------------
  // 思考参数
  // ------------------------------------------------------------------

  protected _applyThinkingParams(kwargs: Record<string, unknown>, _options?: SendMessageOptions): void {
    if (!this._config.supportsThinking) return;
    kwargs["reasoning_effort"] = "high";
    // o 系列不支持 temperature；使用 max_completion_tokens
    delete kwargs["temperature"];
    if ("max_tokens" in kwargs) {
      kwargs["max_completion_tokens"] = kwargs["max_tokens"];
      delete kwargs["max_tokens"];
    }
  }

  protected _augmentRequestKwargs(
    _kwargs: Record<string, unknown>,
    _ctx: {
      hasNativeWebSearch: boolean;
      tools?: ToolDef[];
      options?: SendMessageOptions;
    },
  ): void {
    // 子类可以注入提供者特定的请求参数。
  }

  // ------------------------------------------------------------------
  // 核心 API 调用
  // ------------------------------------------------------------------

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const conv = this._convertMessages(messages);

    const kwargs: Record<string, unknown> = {
      model: this._config.model,
      messages: conv,
      temperature:
        options?.temperature !== undefined
          ? options.temperature
          : this._config.temperature,
    };

    if (options?.maxTokens || this._config.maxTokens) {
      kwargs["max_tokens"] = options?.maxTokens || this._config.maxTokens;
    }

    if (tools && tools.length > 0) {
      const { toolsList, hasNativeWebSearch } = this._convertTools(tools);
      if (hasNativeWebSearch) {
        kwargs["web_search_options"] = {};
      }
      if (toolsList.length > 0) {
        kwargs["tools"] = toolsList;
      }
    }

    // 在思考参数之前应用 config.extra（思考有最终控制权）
    if (this._config.extra) {
      const extraBody = this._config.extra["extra_body"] as
        | Record<string, unknown>
        | undefined;
      for (const [k, v] of Object.entries(this._config.extra)) {
        if (k !== "extra_body") {
          kwargs[k] = v;
        }
      }
      if (extraBody) {
        kwargs["extra_body"] = {
          ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
          ...extraBody,
        };
      }
    }

    this._augmentRequestKwargs(kwargs, {
      hasNativeWebSearch:
        tools && tools.length > 0
          ? Boolean(kwargs["web_search_options"])
          : false,
      tools,
      options,
    });

    this._applyThinkingParams(kwargs, options);

    // 清理空的 extra_body
    if (
      kwargs["extra_body"] &&
      typeof kwargs["extra_body"] === "object" &&
      Object.keys(kwargs["extra_body"] as object).length === 0
    ) {
      delete kwargs["extra_body"];
    }

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

    const resp = await this._client.chat.completions.create(
      kwargs as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
    return this._parseResponse(resp);
  }

  // ------------------------------------------------------------------
  // 流式传输
  // ------------------------------------------------------------------

  private async _callStream(
    kwargs: Record<string, unknown>,
    onTextChunk?: (chunk: string) => void,
    onReasoningChunk?: (chunk: string) => void,
    signal?: AbortSignal,
    onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void,
    onToolCallClosed?: (call: ToolCall) => void,
  ): Promise<ProviderResponse> {
    kwargs["stream"] = true;
    kwargs["stream_options"] = { include_usage: true };

    const textParts: string[] = [];
    const toolAcc: Map<
      number,
      { id: string; name: string; argsSoFar: string; lastChunk: string; closed: boolean }
    > = new Map();
    let activeToolIndex: number | null = null;
    let usage = new Usage();
    const reasoningParts: string[] = [];
    const citations: Citation[] = [];
    let latestReasoningState: unknown = null;
    const toolArgsMode = this._toolArgsMode;
    let textSoFar = "";
    let reasoningSoFar = "";
    let rawTextSoFar = "";
    let visibleTextSoFar = "";
    const requestedReasoningSplit =
      !!(
        kwargs["extra_body"] &&
        typeof kwargs["extra_body"] === "object" &&
        (kwargs["extra_body"] as Record<string, unknown>)["reasoning_split"] === true
      );
    let hasVendorReasoningSplit = requestedReasoningSplit;
    // 跟踪 <think> 标签提取，用于将 reasoning 嵌入 content 的 API
    //（例如 MiniMax 在 delta.content 中发送 <think>...</think> 而不是 reasoning_details，
    // 或 LM Studio 将 <think> 标签作为普通文本输出到 content 中）。
    let thinkTagEmittedLen = 0;
    // 对没有供应商 reasoning split 的服务器（例如 LM Studio）检测 content 中的 <think>。
    // null = 尚未看到第一个 content delta；之后为 true/false。
    let contentHasInlineThink: boolean | null = null;

    function normalizeReasoningDetails(details: unknown): { text: string; state: unknown } | null {
      const collectText = (value: unknown): string => {
        if (!value) return "";
        if (typeof value === "string") return value;
        if (Array.isArray(value)) {
          return value
            .map((item) => collectText(item))
            .filter(Boolean)
            .join("\n");
        }
        if (typeof value === "object") {
          const obj = value as Record<string, unknown>;
          if (typeof obj["content"] === "string") return obj["content"] as string;
          if (typeof obj["text"] === "string") return obj["text"] as string;
        }
        return "";
      };

      if (details == null) return null;
      const text = collectText(details);
      return { text, state: details };
    }

    function appendMaybeCumulative(
      incoming: string,
      prevFull: string,
      parts: string[],
      onChunk?: (chunk: string) => void,
    ): string {
      if (!incoming) return prevFull;
      let emit = incoming;
      let nextFull = prevFull + incoming;
      if (prevFull && incoming.length > prevFull.length && incoming.startsWith(prevFull)) {
        emit = incoming.slice(prevFull.length);
        nextFull = incoming;
      } else if (!prevFull && incoming.length > 0) {
        nextFull = incoming;
      }
      if (emit) {
        parts.push(emit);
        if (onChunk) onChunk(emit);
      }
      return nextFull;
    }

    function reconcileMaybeCumulative(incoming: string, prevFull: string): string {
      if (!incoming) return prevFull;
      if (prevFull && incoming.length > prevFull.length && incoming.startsWith(prevFull)) {
        return incoming;
      }
      if (!prevFull) {
        return incoming;
      }
      return prevFull + incoming;
    }

    function stripLeadingThinkBlock(raw: string): string {
      if (!raw) return "";
      const leadingWs = raw.match(/^\s*/)?.[0] ?? "";
      const rest = raw.slice(leadingWs.length);
      if (!rest.startsWith("<think>")) {
        return raw;
      }
      const closeIdx = rest.indexOf("</think>");
      if (closeIdx < 0) {
        return "";
      }
      const afterThink = rest.slice(closeIdx + "</think>".length);
      return afterThink.replace(/^\r?\n+/, "");
    }

    function closeToolIndex(idx: number | null): void {
      if (idx === null) return;
      const acc = toolAcc.get(idx);
      if (!acc || acc.closed) return;
      acc.closed = true;
      activeToolIndex = null;
      if (onToolCallClosed && acc.id && acc.name) {
        let rawArguments = acc.argsSoFar;
        if (
          rawArguments
          && toolArgsMode === "auto"
          && acc.lastChunk
          && acc.lastChunk !== rawArguments
        ) {
          try {
            JSON.parse(rawArguments);
          } catch {
            try {
              JSON.parse(acc.lastChunk);
              rawArguments = acc.lastChunk;
            } catch {}
          }
        }
        onToolCallClosed(finalizeToolCall(acc.id, acc.name, rawArguments, `${acc.name} stream`));
      }
    }

    const response = await this._client.chat.completions.create(
      kwargs as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      signal ? { signal } : undefined,
    );

    for await (const chunk of response) {
      if (!chunk.choices || chunk.choices.length === 0) {
        if (chunk.usage) {
          const pd = (chunk.usage as unknown as Record<string, unknown>)[
            "prompt_tokens_details"
          ] as Record<string, number> | undefined;
          usage = new Usage(
            chunk.usage.prompt_tokens ?? 0,
            chunk.usage.completion_tokens ?? 0,
            0,
            pd?.["cached_tokens"] ?? 0,
          );
        }
        continue;
      }

      const delta = chunk.choices[0].delta;

      const annotations = (delta as unknown as Record<string, unknown>)[
        "annotations"
      ] as Record<string, unknown>[] | undefined;
      if (annotations) {
        for (const ann of annotations) {
          if (ann["type"] === "url_citation") {
            citations.push({
              url: (ann["url"] as string) || "",
              title: (ann["title"] as string) || "",
            });
          }
        }
      }

      // Reasoning / thinking 内容（Kimi: reasoning_content，Ollama: reasoning）
      const reasoning = ((delta as Record<string, unknown>)[
        "reasoning_content"
      ] ?? (delta as Record<string, unknown>)[
        "reasoning"
      ]) as string | undefined;
      if (reasoning) {
        closeToolIndex(activeToolIndex);
        reasoningSoFar = appendMaybeCumulative(
          reasoning,
          reasoningSoFar,
          reasoningParts,
          onReasoningChunk,
        );
      }

      // MiniMax reasoning_split（reasoning_details）及类似供应商扩展
      const reasoningDetails = (delta as Record<string, unknown>)[
        "reasoning_details"
      ];
      const normalizedReasoning = normalizeReasoningDetails(reasoningDetails);
      if (normalizedReasoning) {
        closeToolIndex(activeToolIndex);
        hasVendorReasoningSplit = true;
        latestReasoningState = normalizedReasoning.state;
        if (normalizedReasoning.text) {
          reasoningSoFar = appendMaybeCumulative(
            normalizedReasoning.text,
            reasoningSoFar,
            reasoningParts,
            onReasoningChunk,
          );
        }
      }

      // 文本内容
      if (delta.content) {
        closeToolIndex(activeToolIndex);
        if (hasVendorReasoningSplit) {
          rawTextSoFar = reconcileMaybeCumulative(delta.content, rawTextSoFar);

          // 将 <think> 内容提取为 reasoning（MiniMax 风格：reasoning 位于 content 标签中）
          const trimmed = rawTextSoFar.replace(/^\s*/, "");
          if (trimmed.startsWith("<think>")) {
            const tagStart = rawTextSoFar.indexOf("<think>") + "<think>".length;
            const closeIdx = rawTextSoFar.indexOf("</think>", tagStart);
            const thinkContent = closeIdx >= 0
              ? rawTextSoFar.slice(tagStart, closeIdx)
              : rawTextSoFar.slice(tagStart);
            const newPart = thinkContent.slice(thinkTagEmittedLen);
            if (newPart) {
              thinkTagEmittedLen = thinkContent.length;
              reasoningParts.push(newPart);
              reasoningSoFar += newPart;
              if (onReasoningChunk) onReasoningChunk(newPart);
            }
          }

          const visible = stripLeadingThinkBlock(rawTextSoFar);
          textSoFar = appendMaybeCumulative(visible, visibleTextSoFar, textParts, onTextChunk);
          visibleTextSoFar = textSoFar;
        } else {
          // 在第一个 content delta 上检测 <think> 标签（LM Studio、本地 LLM）。
          // <think> 在 Qwen/DeepSeek 中是单个特殊 token，所以第一个 chunk
          // 总是完整的 "<think>" 字符串。
          if (contentHasInlineThink === null) {
            contentHasInlineThink = delta.content.replace(/^\s*/, "").startsWith("<think>");
          }

          if (contentHasInlineThink) {
            rawTextSoFar = reconcileMaybeCumulative(delta.content, rawTextSoFar);
            const trimmed = rawTextSoFar.replace(/^\s*/, "");
            if (trimmed.startsWith("<think>")) {
              const tagStart = rawTextSoFar.indexOf("<think>") + "<think>".length;
              const closeIdx = rawTextSoFar.indexOf("</think>", tagStart);
              const thinkContent = closeIdx >= 0
                ? rawTextSoFar.slice(tagStart, closeIdx)
                : rawTextSoFar.slice(tagStart);
              const newPart = thinkContent.slice(thinkTagEmittedLen);
              if (newPart) {
                thinkTagEmittedLen = thinkContent.length;
                reasoningParts.push(newPart);
                reasoningSoFar += newPart;
                if (onReasoningChunk) onReasoningChunk(newPart);
              }
            }
            const visible = stripLeadingThinkBlock(rawTextSoFar);
            textSoFar = appendMaybeCumulative(visible, visibleTextSoFar, textParts, onTextChunk);
            visibleTextSoFar = textSoFar;
          } else {
            textSoFar = appendMaybeCumulative(delta.content, textSoFar, textParts, onTextChunk);
          }
        }
      }

      // 工具调用 delta（增量累积）
      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index;
          if (activeToolIndex !== null && activeToolIndex !== idx) {
            closeToolIndex(activeToolIndex);
          }
          if (!toolAcc.has(idx)) {
            const name = tcDelta.function?.name || "";
            const id = tcDelta.id || "";
            toolAcc.set(idx, {
              id,
              name,
              argsSoFar: "",
              lastChunk: "",
              closed: false,
            });
            if (name && id && onToolCallPartial) {
              onToolCallPartial(id, name, "");
            }
          } else {
            const acc = toolAcc.get(idx)!;
            const hadName = !!acc.name;
            if (tcDelta.id) acc.id = tcDelta.id;
            if (tcDelta.function?.name) acc.name = tcDelta.function.name;
            acc.closed = false;
            if (!hadName && acc.name && acc.id && onToolCallPartial) {
              onToolCallPartial(acc.id, acc.name, acc.argsSoFar);
            }
          }
          if (tcDelta.function?.arguments) {
            const acc = toolAcc.get(idx)!;
            acc.lastChunk = tcDelta.function.arguments;
            acc.argsSoFar = this._mergeToolArgsChunk(
              acc.argsSoFar,
              tcDelta.function.arguments,
            );
            if (onToolCallPartial && acc.id && acc.name) {
              onToolCallPartial(acc.id, acc.name, acc.argsSoFar);
            }
          }
          activeToolIndex = idx;
        }
      }

      // 最终 chunk 中的用量
      if (chunk.usage) {
        const promptDetails = (chunk.usage as unknown as Record<string, unknown>)[
          "prompt_tokens_details"
        ] as Record<string, number> | undefined;
        usage = new Usage(
          chunk.usage.prompt_tokens ?? 0,
          chunk.usage.completion_tokens ?? 0,
          0,
          promptDetails?.["cached_tokens"] ?? 0,
        );
      }
    }

    closeToolIndex(activeToolIndex);

    const reasoningText = reasoningParts.join("");

    return new ProviderResponse({
      text: textParts.join(""),
      toolCalls: [],
      usage,
      raw: null,
      reasoningContent: reasoningText,
      reasoningState: latestReasoningState ?? (reasoningText || null),
      thinkingArtifact: this._buildThinkingArtifact(
        reasoningText,
        latestReasoningState ?? (reasoningText || null),
      ),
      citations,
    });
  }
}
