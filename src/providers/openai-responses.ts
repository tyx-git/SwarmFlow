/**
 * OpenAI Responses API 提供者适配器。
 *
 * 使用 `client.responses.create()` 用于 o1/o3 和 GPT-5 模型。
 * 支持原生 reasoning 项目和 web_search_preview。
 */

import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";
import OpenAI from "openai";
import { getCodexAccountId } from "../auth/openai-oauth.js";
import { getExtendedCacheSupport, type ModelConfig } from "../config/config.js";
import { VERSION } from "../version.js";
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
  SEALED_SCHEMA_OPENAI_RESPONSES,
  type ThinkingArtifact,
} from "../lib/thinking-artifact.js";

// 在 OpenAI Responses API 上不支持 `temperature` 的模型。
const O_SERIES_RE = /^o\d/;
const GPT5_SERIES_RE = /^gpt-5(?:$|[.-])/;

function normalizeModelId(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function supportsTemperature(model: string): boolean {
  const normalized = normalizeModelId(model).toLowerCase();
  return !(
    O_SERIES_RE.test(normalized)
    || GPT5_SERIES_RE.test(normalized)
  );
}

export class OpenAIResponsesProvider extends BaseProvider {
  /**
   * GPT-5 系列使用独立的输入/输出限制（输入 ≥72K，输出 ≥28K）。
   * contextLength 存储输入限制；compact 检查应直接与其比较，
   * 而不是减去 maxOutputTokens。
   */
  override readonly budgetCalcMode = "full_context" as const;

  protected _config: ModelConfig;
  protected _client: OpenAI;

  constructor(config: ModelConfig) {
    super();
    this._config = config;
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: config.apiKey,
    };
    if (config.baseUrl) {
      opts.baseURL = config.baseUrl;
    }
    this._client = new OpenAI(opts);
  }

  private _isCodexProvider(): boolean {
    return this._config.provider === "openai-codex";
  }

  /**
   * 我们在客户端驱动的 Responses 后端（我们从不发送 `previous_response_id`）。
   * 推理仅通过重放经过清理的推理往返项目（type + summary + encrypted_content）
   * 以及 `include: ["reasoning.encrypted_content"]` 和 `store: false` 在各轮次之间传递。
   *
   * 包括：
   *   - openai (platform.openai.com/responses) — 我们自己管理对话，
   *     从不通过 previous_response_id 链接，所以服务器端 store=true 永远不会被读回；
   *     保留思维链（以及从中获益的缓存）的唯一方法是请求加密推理并自己回显。
   *   - openai-codex (chatgpt.com/backend-api/codex) — 拒绝 store=true
   *   - copilot (api.individual.githubcopilot.com/responses) — 拒绝 store=true
   *
   * 没有 encrypted_content，这些后端会丢弃回显的推理项目，丢失思维链
   *（在 codex/copilot 上产生 400 invalid_request_body）在后续轮次中。
   * 经 `experiments/copilot-probe/` 下的实验验证。
   */
  private _isStatelessResponsesBackend(): boolean {
    const p = this._config.provider;
    return p === "openai" || p === "openai-codex" || p === "copilot";
  }

  private _buildRequestOptions(
    signal?: AbortSignal,
    promptCacheKey?: string,
  ): Record<string, unknown> | undefined {
    const requestOptions: Record<string, unknown> = {};

    if (signal) {
      requestOptions["signal"] = signal;
    }

    if (this._isCodexProvider()) {
      // 镜像官方 Codex CLI 线路协议（codex_cli_rs）：一个诚实的
      // 发起者，一个 `<name>/<version> (<os> <release>; <arch>)` User-Agent，
      // 来自用户 OAuth JWT 的真实 ChatGPT-Account-Id，以及 `session_id`
      // 携带提示缓存密钥。CLI 仅在 User-Agent 中嵌入其版本（没有单独的 `version` 头），
      // 并发送 `session_id` 但不发送 `conversation_id` 头，所以我们完全匹配。

      const headers: Record<string, string> = {
        originator: "swarmflow",
        "User-Agent": `swarmflow/${VERSION} (${osPlatform()} ${osRelease()}; ${osArch()})`,
      };
      const accountId = getCodexAccountId(this._config.apiKey ?? "");
      if (accountId) {
        headers["ChatGPT-Account-Id"] = accountId;
      }
      if (promptCacheKey) {
        headers["session_id"] = promptCacheKey;
      }
      requestOptions["headers"] = headers;
    }

    return Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
  }

  private _ensureStatelessInclude(kwargs: Record<string, unknown>): void {
    if (!this._isStatelessResponsesBackend()) return;

    const existing = Array.isArray(kwargs["include"])
      ? (kwargs["include"] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    if (!existing.includes("reasoning.encrypted_content")) {
      existing.push("reasoning.encrypted_content");
    }

    kwargs["include"] = existing;
  }

  private _sanitizeStatelessRoundtripItems(items: unknown): Record<string, unknown>[] {
    if (!Array.isArray(items)) return [];

    const sanitized: Record<string, unknown>[] = [];

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const itemType = item["type"] as string;

      if (itemType === "reasoning") {
        const next: Record<string, unknown> = { type: "reasoning" };
        if (Array.isArray(item["summary"])) {
          next["summary"] = item["summary"];
        }
        if ("encrypted_content" in item) {
          next["encrypted_content"] = item["encrypted_content"];
        }
        sanitized.push(next);
        continue;
      }

      if (itemType === "function_call") {
        const next: Record<string, unknown> = { type: "function_call" };
        if (typeof item["call_id"] === "string") {
          next["call_id"] = item["call_id"];
        }
        if (typeof item["name"] === "string") {
          next["name"] = item["name"];
        }
        const args = item["arguments"];
        if (typeof args === "string") {
          next["arguments"] = args;
        } else if (args !== undefined) {
          next["arguments"] = JSON.stringify(args);
        }
        sanitized.push(next);
      }
    }

    return sanitized;
  }

  /**
   * 将捕获的推理项目塑造成我们在下一轮重放的往返状态。
   * 仅限推理：function_call 项目通过 `tool_calls` 单独重放
   *（见 `_buildInput`），所以在这里捆绑它们会在线路上造成重复。
   * 无状态后端获取清理后的形式（保留 encrypted_content，丢弃 id）。
   */
  private _reasoningRoundtripState(reasoningItems: Record<string, unknown>[]): unknown[] | null {
    if (reasoningItems.length === 0) return null;
    return this._isStatelessResponsesBackend()
      ? this._sanitizeStatelessRoundtripItems(reasoningItems)
      : reasoningItems;
  }

  private _buildThinkingArtifact(
    plainReplayText: string,
    reasoningState: unknown,
  ): ThinkingArtifact | null {
    const targetEncryption = effectiveThinkingEncryption(this._config);
    const replayText = plainReplayText.trim();
    if (!replayText && (reasoningState === undefined || reasoningState === null)) {
      return null;
    }
    const sealedPayload =
      Array.isArray(reasoningState) && reasoningState.length > 0
        ? reasoningState
        : undefined;
    const sealedSchema = sealedPayload ? SEALED_SCHEMA_OPENAI_RESPONSES : null;
    return createThinkingArtifact(targetEncryption, replayText, sealedPayload, sealedSchema);
  }

  // ------------------------------------------------------------------
  // 工具转换
  // ------------------------------------------------------------------

  private _convertTools(
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
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      });
    }
    return { toolsList: result, hasNativeWebSearch: hasWebSearch };
  }

  // ------------------------------------------------------------------
  // 输入转换
  // ------------------------------------------------------------------

  private _buildInput(messages: Message[]): Record<string, unknown>[] {
    const items: Record<string, unknown>[] = [];

    for (const msg of messages) {
      const m = msg as Record<string, unknown>;
      const role = m["role"] as string;

      if (role === "system") {
        items.push({ role: "developer", content: m["content"] });
      } else if (role === "user") {
        const content = m["content"];
        if (Array.isArray(content)) {
          const parts: Record<string, unknown>[] = [];
          for (const block of content as Record<string, unknown>[]) {
            if (block["type"] === "text") {
              parts.push({ type: "input_text", text: block["text"] });
            } else if (block["type"] === "image") {
              const dataUri = `data:${block["media_type"]};base64,${block["data"]}`;
              parts.push({ type: "input_image", image_url: dataUri });
            }
          }
          items.push({ role: "user", content: parts });
        } else {
          items.push({ role: "user", content });
        }
      } else if (role === "assistant") {
        const transmission = selectThinkingTransmission(
          resolveMessageThinkingArtifact(m),
          effectiveThinkingEncryption(this._config),
          effectiveSealedSchema(this._config),
        );
        if (transmission?.kind === "sealed" && Array.isArray(transmission.payload)) {
          const roundtripItems = this._isStatelessResponsesBackend()
            ? this._sanitizeStatelessRoundtripItems(transmission.payload)
            : (transmission.payload as Record<string, unknown>[]);
          items.push(...roundtripItems);
        } else if (transmission?.kind === "plain") {
          items.push(...this._plainThinkingInputItems(transmission.plainReplayText, m));
        }

        if (m["tool_calls"]) {
          const text = (m["content"] as string) || (m["text"] as string) || "";
          if (text) {
            items.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            });
          }
          for (const tc of m["tool_calls"] as Record<string, unknown>[]) {
            const args = tc["arguments"];
            items.push({
              type: "function_call",
              call_id: tc["id"],
              name: tc["name"],
              arguments:
                typeof args === "object" && args !== null
                  ? JSON.stringify(args)
                  : args,
            });
          }
        } else {
          const text = (m["content"] as string) || (m["text"] as string) || "";
          if (text) {
            items.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            });
          }
        }
      } else if (role === "tool_result") {
        // OpenAI Responses API 仅接受字符串输出；
        // 如果存在，则从多模态内容块中提取文本。
        const rawOutput = m["content"];
        const textOutput = Array.isArray(rawOutput)
          ? (rawOutput as Array<Record<string, unknown>>)
              .filter((b) => b["type"] === "text")
              .map((b) => b["text"] as string)
              .join("\n") || String(rawOutput)
          : rawOutput;
        items.push({
          type: "function_call_output",
          call_id: m["tool_call_id"],
          output: textOutput,
        });
      }
    }

    return items;
  }

  // ------------------------------------------------------------------
  // 响应解析
  // ------------------------------------------------------------------

  private _parseResponse(response: Record<string, unknown>): ProviderResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const reasoningTextParts: string[] = [];
    const reasoningItems: unknown[] = [];
    const citations: Citation[] = [];

    const output = (response["output"] as Record<string, unknown>[]) || [];
    for (const item of output) {
      const itemType = item["type"] as string;

      if (itemType === "reasoning") {
        reasoningItems.push(item);
        const summary = item["summary"] as Record<string, unknown>[] | undefined;
        if (summary) {
          for (const s of summary) {
            const text = (s["text"] as string) || "";
            if (text) reasoningTextParts.push(text);
          }
        }
      } else if (itemType === "message") {
        const content =
          (item["content"] as Record<string, unknown>[]) || [];
        for (const part of content) {
          const partType = part["type"] as string;
          if (partType === "output_text") {
            textParts.push((part["text"] as string) || "");
            const annotations = part["annotations"] as Record<string, unknown>[] | undefined;
            if (annotations) {
              for (const ann of annotations) {
                if ((ann["type"] as string) === "url_citation") {
                  citations.push({
                    url: (ann["url"] as string) || "",
                    title: (ann["title"] as string) || "",
                    citedText: (ann["cited_text"] as string) || "",
                  });
                } else {
                  const nested = ann["url_citation"] as Record<string, unknown> | undefined;
                  if (nested) {
                    citations.push({
                      url: (nested["url"] as string) || "",
                      title: (nested["title"] as string) || "",
                      citedText: (nested["cited_text"] as string) || "",
                    });
                  }
                }
              }
            }
          } else if (partType === "refusal") {
            textParts.push(`[Refusal: ${(part["refusal"] as string) || ""}]`);
          }
        }
      } else if (itemType === "function_call") {
        const callId = (item["call_id"] as string) || "";
        const name = (item["name"] as string) || "";
        const argsStr = (item["arguments"] as string) || "{}";
        if (typeof item["arguments"] === "string") {
          toolCalls.push(finalizeToolCall(callId, name, argsStr, `${name} response`));
        } else {
          toolCalls.push({
            id: callId,
            name,
            rawArguments: JSON.stringify((item["arguments"] as Record<string, unknown>) ?? {}),
            arguments: (item["arguments"] as Record<string, unknown>) ?? {},
            parseError: null,
          });
        }
      } else if (itemType === "web_search_call") {
        this._appendWebSearchCallCitations(item, citations);
      }
    }

    // Usage
    let usage = new Usage();
    const respUsage = response["usage"] as Record<string, unknown> | undefined;
    if (respUsage) {
      const inputDetails = respUsage["input_tokens_details"] as Record<string, number> | undefined;
      usage = new Usage(
        (respUsage["input_tokens"] as number) || 0,
        (respUsage["output_tokens"] as number) || 0,
        0, // OpenAI 没有缓存创建
        inputDetails?.["cached_tokens"] ?? 0,
      );
    }

    const reasoningContent = reasoningTextParts.length > 0
      ? reasoningTextParts.join("\n")
      : "";

    const reasoningState = this._reasoningRoundtripState(reasoningItems as Record<string, unknown>[]);

    return new ProviderResponse({
      text: textParts.join("\n"),
      toolCalls,
      usage,
      raw: response,
      reasoningContent,
      reasoningState,
      thinkingArtifact: this._buildThinkingArtifact(reasoningContent, reasoningState),
      citations,
    });
  }

  // ------------------------------------------------------------------
  // Thinking / reasoning 参数
  // ------------------------------------------------------------------

  protected _applyThinkingParams(kwargs: Record<string, unknown>, options?: SendMessageOptions): void {
    if (!this._config.supportsThinking) return;

    const level = options?.thinkingLevel;

    if (level === "off" || level === "none") {
      kwargs["reasoning"] = { effort: "none", summary: "auto" };
      return;
    }

    let effort: string;
    if (level && ["minimal", "low", "medium", "high", "xhigh"].includes(level)) {
      effort = level;
    } else {
      // 默认：从预算推导
      const budget = this._config.thinkingBudget;
      if (budget > 0 && budget < 5_000) {
        effort = "low";
      } else if (budget >= 5_000 && budget < 10_000) {
        effort = "medium";
      } else {
        effort = "high";
      }
    }
    kwargs["reasoning"] = { effort, summary: "auto" };
  }

  protected _nativeWebSearchTool(): Record<string, unknown> {
    return { type: "web_search_preview" };
  }

  protected _supportsMaxOutputTokens(): boolean {
    return true;
  }

  protected _supportsPromptCacheKey(): boolean {
    return true;
  }

  protected _forceStream(_options?: SendMessageOptions): boolean {
    return false;
  }

  protected _plainThinkingInputItems(
    _plainReplayText: string,
    _message: Record<string, unknown>,
  ): Record<string, unknown>[] {
    return [];
  }

  private _appendWebSearchCallCitations(
    item: Record<string, unknown> | undefined,
    citations: Citation[],
  ): void {
    if (!item || item["type"] !== "web_search_call") return;

    const action = item["action"] as Record<string, unknown> | undefined;
    const query = typeof action?.["query"] === "string" ? action["query"] : "";
    const sources = action?.["sources"] as Record<string, unknown>[] | undefined;
    if (!Array.isArray(sources)) return;

    for (const source of sources) {
      const url = typeof source["url"] === "string" ? source["url"] : "";
      if (!url) continue;
      this._appendUniqueCitation(citations, {
        url,
        title: typeof source["title"] === "string" ? source["title"] : "",
        citedText: query || undefined,
      });
    }
  }

  private _appendUniqueCitation(citations: Citation[], citation: Citation): void {
    const exists = citations.some((existing) =>
      existing.url === citation.url
      && existing.title === citation.title
      && existing.citedText === citation.citedText
    );
    if (!exists) citations.push(citation);
  }

  private _mergeCitations(target: Citation[], source: Citation[]): void {
    for (const citation of source) {
      this._appendUniqueCitation(target, citation);
    }
  }

  // ------------------------------------------------------------------
  // 核心 API 调用
  // ------------------------------------------------------------------

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const inputItems = this._buildInput(messages);
    const requestOptions = this._buildRequestOptions(
      options?.signal,
      options?.promptCacheKey,
    );

    const kwargs: Record<string, unknown> = {
      model: this._config.model,
      input: inputItems,
    };

    // Codex 后端要求系统提示符作为顶层 `instructions`，
    // 而不是 input 数组中的 developer-role 项。
    if (this._config.provider === "openai-codex") {
      const systemParts: string[] = [];
      const filtered: Record<string, unknown>[] = [];
      for (const item of inputItems) {
        if ((item as { role?: string }).role === "developer") {
          systemParts.push(String(item["content"] ?? ""));
        } else {
          filtered.push(item);
        }
      }
      if (systemParts.length > 0) {
        kwargs["instructions"] = systemParts.join("\n\n");
        kwargs["input"] = filtered;
      }
    }

    // Codex 后端不支持 temperature 或 max_output_tokens。
    const isCodex = this._isCodexProvider();

    // Temperature（跳过拒绝此字段的模型家族和 Codex）。
    if (!isCodex && supportsTemperature(this._config.model)) {
      const temp =
        options?.temperature !== undefined
          ? options.temperature
          : this._config.temperature;
      if (temp !== undefined) {
        kwargs["temperature"] = temp;
      }
    }

    if (!isCodex && this._supportsMaxOutputTokens() && (options?.maxTokens || this._config.maxTokens)) {
      kwargs["max_output_tokens"] = options?.maxTokens || this._config.maxTokens;
    }

    if (tools && tools.length > 0) {
      const { toolsList, hasNativeWebSearch } = this._convertTools(tools);
      if (hasNativeWebSearch) {
        toolsList.push(this._nativeWebSearchTool());
      }
      if (toolsList.length > 0) {
        kwargs["tools"] = toolsList;
      }
    }

    if (this._config.extra) {
      Object.assign(kwargs, this._config.extra);
    }
    this._applyThinkingParams(kwargs, options);
    this._ensureStatelessInclude(kwargs);

    // 客户端管理的对话（无 previous_response_id）：强制无状态，
    // 让后端依赖我们重放的加密 reasoning 项，而不是服务器状态。
    // openai 默认 store=true；codex/copilot 会直接拒绝 store=true。
    if (this._isStatelessResponsesBackend()) {
      kwargs["store"] = false;
    }

    // Prompt cache 优化
    if (this._supportsPromptCacheKey() && options?.promptCacheKey) {
      kwargs["prompt_cache_key"] = options.promptCacheKey;
    }
    // prompt_cache_retention：无状态后端（Codex、Copilot）会拒绝它 —
    // 它们本来就从不持久化响应。其他模型由能力表门控。
    if (!this._isStatelessResponsesBackend() && getExtendedCacheSupport(this._config.model)) {
      kwargs["prompt_cache_retention"] = "24h";
    }

    // Codex 后端（chatgpt.com）遇到官方 Codex CLI 从不发送的字段时会静默退化
    //（不是 4xx），这被怀疑是固定延迟慢路径的来源之一（参见 openclaw #65260）。
    // 在合并 `extra` 后最后剥离它们，避免被重新引入。我们保留 CLI 确实发送的字段
    //（prompt_cache_key、service_tier、text、reasoning、include、store）。
    if (isCodex) {
      for (const field of [
        "temperature",
        "max_output_tokens",
        "top_p",
        "metadata",
        "prompt_cache_retention",
      ]) {
        delete kwargs[field];
      }
    }

    // Codex 后端要求所有请求 stream=true。
    if (
      options?.onTextChunk
      || options?.onReasoningChunk
      || options?.onToolCallPartial
      || this._config.provider === "openai-codex"
      || this._forceStream(options)
    ) {
      return this._callStream(
        kwargs,
        requestOptions,
        options?.onTextChunk,
        options?.onReasoningChunk,
        options?.onToolCallPartial,
        options?.onToolCallClosed,
      );
    }

    const response = await (this._client as unknown as { responses: { create: (params: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<Record<string, unknown>> } }).responses.create(kwargs, requestOptions);
    return this._parseResponse(response);
  }

  // ------------------------------------------------------------------
  // 流式传输
  // ------------------------------------------------------------------

  private async _callStream(
    kwargs: Record<string, unknown>,
    requestOptions?: Record<string, unknown>,
    onTextChunk?: (chunk: string) => void,
    onReasoningChunk?: (chunk: string) => void,
    onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void,
    onToolCallClosed?: (call: ToolCall) => void,
  ): Promise<ProviderResponse> {
    kwargs["stream"] = true;

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    type StreamToolAcc = {
      callId: string;
      itemId?: string;
      name: string;
      rawArguments: string;
      closed: boolean;
    };
    const toolAcc: Map<string, StreamToolAcc> = new Map();
    const itemIdToCallId: Map<string, string> = new Map();
    const outputIndexToCallId: Map<number, string> = new Map();
    const streamCitations: Citation[] = [];
    const streamedReasoningItems: Record<string, unknown>[] = [];
    let activeFunctionCallId: string | null = null;
    let finalResponse: Record<string, unknown> | null = null;

    const getEventString = (value: unknown): string => typeof value === "string" ? value : "";
    const getEventNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;

    const resolveToolAcc = (id: string | null): StreamToolAcc | undefined => {
      if (!id) return undefined;
      const callId = itemIdToCallId.get(id) ?? id;
      return toolAcc.get(callId);
    };

    const ensureToolAcc = (ids: {
      callId?: string;
      itemId?: string;
      name?: string;
      outputIndex?: number;
    }): StreamToolAcc | null => {
      const itemId = ids.itemId || undefined;
      const outputIndexCallId =
        ids.outputIndex !== undefined ? outputIndexToCallId.get(ids.outputIndex) : undefined;
      const provisionalOutputKey =
        ids.outputIndex !== undefined ? `output_index:${ids.outputIndex}` : undefined;
      const requestedCallId =
        ids.callId
        || (itemId ? itemIdToCallId.get(itemId) : undefined)
        || outputIndexCallId
        || itemId
        || provisionalOutputKey;
      if (!requestedCallId) return null;

      let acc = toolAcc.get(requestedCallId);

      // 标准 Responses 事件按输出 item id 流式传输参数增量。
      // 某些 Codex 后端事件最初可能只能通过 output_index 识别。
      // 一旦 output_item 事件提供稳定 call_id，就把临时记录合并进去。
      if (!acc && ids.callId) {
        const provisionalKey =
          (itemId && toolAcc.has(itemId) ? itemId : undefined)
          || (outputIndexCallId && toolAcc.has(outputIndexCallId) ? outputIndexCallId : undefined)
          || (provisionalOutputKey && toolAcc.has(provisionalOutputKey) ? provisionalOutputKey : undefined);
        const provisional = provisionalKey ? toolAcc.get(provisionalKey) : undefined;
        if (provisional) {
          toolAcc.delete(provisionalKey!);
          provisional.callId = ids.callId;
          acc = provisional;
          toolAcc.set(ids.callId, acc);
          if (
            activeFunctionCallId === itemId
            || activeFunctionCallId === outputIndexCallId
            || activeFunctionCallId === provisionalOutputKey
          ) {
            activeFunctionCallId = ids.callId;
          }
        }
      }

      if (!acc) {
        acc = {
          callId: requestedCallId,
          itemId,
          name: "",
          rawArguments: "",
          closed: false,
        };
        toolAcc.set(requestedCallId, acc);
      }

      if (itemId) {
        acc.itemId = itemId;
        itemIdToCallId.set(itemId, acc.callId);
      }
      if (ids.outputIndex !== undefined) {
        outputIndexToCallId.set(ids.outputIndex, acc.callId);
      }
      if (ids.name) {
        acc.name = ids.name;
      }
      return acc;
    };

    const emitToolPartial = (acc: StreamToolAcc | undefined): void => {
      if (!acc || !acc.name || !onToolCallPartial) return;
      onToolCallPartial(acc.callId, acc.name, acc.rawArguments);
    };

    const closeToolCall = (id: string | null, argsOverride?: string): void => {
      const acc = resolveToolAcc(id);
      if (!acc || acc.closed || !acc.name) return;
      if (typeof argsOverride === "string") {
        acc.rawArguments = argsOverride;
      }
      acc.closed = true;
      if (activeFunctionCallId === acc.callId || activeFunctionCallId === acc.itemId) {
        activeFunctionCallId = null;
      }
      onToolCallClosed?.(finalizeToolCall(acc.callId, acc.name, acc.rawArguments, `${acc.name} stream`));
    };

    const closeAllOpenToolCalls = (): void => {
      for (const [callId, acc] of toolAcc) {
        if (!acc.closed) closeToolCall(callId);
      }
    };

    const responseStream = await (this._client as unknown as { responses: { create: (params: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>> } }).responses.create(kwargs, requestOptions);

    for await (const event of responseStream) {
      const eventType = event["type"] as string;

      if (eventType === "response.output_text.delta") {
        closeAllOpenToolCalls();
        const delta = (event["delta"] as string) || "";
        if (delta) {
          textParts.push(delta);
          if (onTextChunk) onTextChunk(delta);
        }
      } else if (eventType === "response.reasoning_summary_text.delta") {
        closeAllOpenToolCalls();
        const delta = (event["delta"] as string) || "";
        if (delta) {
          reasoningParts.push(delta);
          if (onReasoningChunk) onReasoningChunk(delta);
        }
      } else if (eventType === "response.function_call_arguments.delta") {
        const itemId = getEventString(event["item_id"]);
        const callId = getEventString(event["call_id"]);
        const outputIndex = getEventNumber(event["output_index"]);
        const delta = (event["delta"] as string) || "";
        const acc = ensureToolAcc({ callId, itemId, outputIndex });
        if (delta) {
          if (!acc) continue;
          acc.rawArguments += delta;
          acc.closed = false;
          emitToolPartial(acc);
        }
        activeFunctionCallId = acc?.callId ?? (callId || itemId || activeFunctionCallId);
      } else if (eventType === "response.output_item.added") {
        const item = event["item"] as Record<string, unknown> | undefined;
        if (item && item["type"] === "function_call") {
          const itemId = getEventString(item["id"]);
          const callId = getEventString(item["call_id"]) || itemId;
          const name = getEventString(item["name"]);
          const outputIndex = getEventNumber(event["output_index"]);
          if (callId || itemId) {
            const acc = ensureToolAcc({ callId, itemId, name, outputIndex });
            if (acc) {
              acc.closed = false;
              emitToolPartial(acc);
            }
          }
        }
        this._appendWebSearchCallCitations(item, streamCitations);
      } else if (
        eventType === "response.output_item.done"
        || eventType === "response.output_item.completed"
      ) {
        const item = event["item"] as Record<string, unknown> | undefined;
        if (item?.["type"] === "function_call") {
          const itemId = getEventString(item["id"]);
          const callId = getEventString(item["call_id"]) || itemId;
          const name = getEventString(item["name"]);
          const outputIndex = getEventNumber(event["output_index"]);
          const acc = ensureToolAcc({ callId, itemId, name, outputIndex });
          const argsStr = typeof item["arguments"] === "string"
            ? item["arguments"] as string
            : (acc?.rawArguments ?? "");
          closeToolCall(acc?.callId ?? (callId || itemId || activeFunctionCallId), argsStr);
        } else if (item?.["type"] === "reasoning") {
          // openai 和 codex 的 reasoning 项（携带 encrypted_content）都会到达这里。
          // Codex 后端会让 response.completed.output 为空，因此这是唯一能观察到
          // 加密 reasoning 的位置 — 现在就捕获它。
          streamedReasoningItems.push(item);
        }
        this._appendWebSearchCallCitations(item, streamCitations);
      } else if (
        eventType === "response.function_call_arguments.done"
        || eventType === "response.function_call.done"
      ) {
        const itemId = getEventString(event["item_id"]);
        const callId = getEventString(event["call_id"]);
        const name = getEventString(event["name"]);
        const outputIndex = getEventNumber(event["output_index"]);
        const acc = ensureToolAcc({ callId, itemId, name, outputIndex });
        const argsStr = typeof event["arguments"] === "string"
          ? event["arguments"] as string
          : (acc?.rawArguments ?? "");
        closeToolCall(acc?.callId ?? (callId || itemId || activeFunctionCallId), argsStr);
      } else if (
        eventType === "response.completed"
        || eventType === "response.incomplete"
        || eventType === "response.done"
      ) {
        closeAllOpenToolCalls();
        finalResponse = (event["response"] as Record<string, unknown>) || null;
      }
    }

    // 如果拿到最终响应，使用完整解析
    if (finalResponse) {
      closeAllOpenToolCalls();
      const result = this._parseResponse(finalResponse);
      if (textParts.length > 0 && !result.text) {
        result.text = textParts.join("");
      }
      // 流式 output_item.done 事件是 openai 和 codex reasoning 项
      //（带 encrypted_content）的通用来源。优先使用它们，而不是 Codex 后端返回为空的
      // response.completed.output。
      const streamedReasoningState = this._reasoningRoundtripState(streamedReasoningItems);
      if (streamedReasoningState) {
        const reasoningText = reasoningParts.join("") || result.reasoningContent || "";
        result.reasoningContent = reasoningText;
        result.reasoningState = streamedReasoningState;
        result.thinkingArtifact = this._buildThinkingArtifact(reasoningText, streamedReasoningState);
      } else if (reasoningParts.length > 0 && !result.reasoningContent) {
        result.reasoningContent = reasoningParts.join("");
        if (!result.reasoningState) {
          result.reasoningState = result.reasoningContent || null;
        }
        if (!result.thinkingArtifact) {
          result.thinkingArtifact = this._buildThinkingArtifact(
            result.reasoningContent,
            result.reasoningState,
          );
        }
      }
      this._mergeCitations(result.citations, streamCitations);
      if (onToolCallClosed) {
        result.toolCalls = [];
      }
      return result;
    }

    const reasoningText = reasoningParts.join("");

    return new ProviderResponse({
      text: textParts.join(""),
      toolCalls: [],
      usage: new Usage(),
      raw: null,
      reasoningContent: reasoningText,
      reasoningState: reasoningText || null,
      thinkingArtifact: this._buildThinkingArtifact(reasoningText, reasoningText || null),
      citations: streamCitations,
    });
  }
}
