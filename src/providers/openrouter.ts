/**
 * OpenRouter 提供者适配器。
 *
 * 扩展 OpenAIChatProvider，增加：
 * - 自动 base_url 默认值和 HTTP-Referer / X-Title 头
 * - OpenRouter 风格 reasoning 参数（extra_body 中的 reasoning: { effort }）
 * - 从非流式响应中提取 reasoning_details
 * - 在 assistant 消息上往返 reasoning_details
 */

import OpenAI from "openai";
import type { ModelConfig } from "../config/config.js";
import {
  ProviderResponse,
  type Message,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";
import {
  createThinkingArtifact,
  effectiveSealedSchema,
  effectiveThinkingEncryption,
  resolveMessageThinkingArtifact,
  selectThinkingTransmission,
  SEALED_SCHEMA_OPENROUTER_CHAT,
} from "../lib/thinking-artifact.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** 将 swarmflow 思考级别映射到 OpenRouter reasoning effort 值。 */
const EFFORT_MAP: Record<string, string> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",    // Anthropic "max" → OpenRouter 的最高 effort
  on: "high",       // 二元开/关模型 → 默认 high
  none: "none",     // OpenAI 风格的显式关闭
};

export class OpenRouterProvider extends OpenAIChatProvider {
  protected override _sealedSchemaForChatProvider(): string | null {
    return SEALED_SCHEMA_OPENROUTER_CHAT;
  }

  constructor(config: ModelConfig) {
    const headerExtra = config.extra ?? {};
    const sanitizedExtra = Object.fromEntries(
      Object.entries(headerExtra).filter(
        ([k]) => k !== "http_referer" && k !== "x_title",
      ),
    );
    super({
      ...config,
      extra: sanitizedExtra,
    });
    // 使用 OpenRouter 特定设置重建客户端
    const baseUrl = config.baseUrl || OPENROUTER_BASE_URL;
    const headers: Record<string, string> = {};
    if (config.extra?.["http_referer"]) {
      headers["HTTP-Referer"] = config.extra["http_referer"] as string;
    }
    if (config.extra?.["x_title"]) {
      headers["X-Title"] = config.extra["x_title"] as string;
    }
    this._client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: baseUrl,
      defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
    });
  }

  // ------------------------------------------------------------------
  // Thinking / reasoning 参数 — OpenRouter 统一格式
  // ------------------------------------------------------------------

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;

    const level = options?.thinkingLevel;

    // 显式禁用 reasoning
    if (level === "off" || level === "none") {
      const extraBody = (kwargs["extra_body"] as Record<string, unknown>) || {};
      extraBody["reasoning"] = { effort: "none" };
      kwargs["extra_body"] = extraBody;
      return;
    }

    // 构建 reasoning 配置
    const reasoningConfig: Record<string, unknown> = {};

    if (this._config.thinkingBudget > 0) {
      // 显式设置 thinkingBudget 时对 reasoning 使用 max_tokens
      reasoningConfig["max_tokens"] = this._config.thinkingBudget;
    } else {
      // 将思考级别映射为 effort
      const effort = level ? (EFFORT_MAP[level] ?? "high") : "high";
      reasoningConfig["effort"] = effort;
    }

    const extraBody = (kwargs["extra_body"] as Record<string, unknown>) || {};
    extraBody["reasoning"] = reasoningConfig;
    kwargs["extra_body"] = extraBody;

    // 不要删除 temperature，也不要将 max_tokens 替换为 max_completion_tokens。
    // OpenRouter 会按模型在内部规范化这些参数。
  }

  protected override _augmentRequestKwargs(
    kwargs: Record<string, unknown>,
    ctx: {
      hasNativeWebSearch: boolean;
      tools?: ToolDef[];
      options?: SendMessageOptions;
    },
  ): void {
    if (!ctx.hasNativeWebSearch) return;

    const existing = Array.isArray(kwargs["plugins"])
      ? [...(kwargs["plugins"] as Record<string, unknown>[])]
      : [];
    const hasWebPlugin = existing.some((plugin) =>
      plugin && typeof plugin === "object" && plugin["id"] === "web"
    );
    if (!hasWebPlugin) {
      existing.push({ id: "web" });
    }
    kwargs["plugins"] = existing;
  }

  // ------------------------------------------------------------------
  // 响应后处理 — 提取 reasoning_details
  // ------------------------------------------------------------------

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const result = await super.sendMessage(messages, tools, options);

    // 非流式：基类 _parseResponse（private）只提取 reasoning_content（字符串）。
    // OpenRouter 还会返回 reasoning_details（结构化数组），我们需要它来忠实往返。
    // 流式已通过 _callStream 处理 reasoning_details。
    if (result.raw && (!result.reasoningContent || result.reasoningState === result.reasoningContent)) {
      try {
        const raw = result.raw as Record<string, unknown>;
        const choices = (raw["choices"] as Record<string, unknown>[]) || [];
        if (choices.length > 0) {
          const message = choices[0]["message"] as Record<string, unknown> | undefined;
          if (message) {
            const details = message["reasoning_details"] as unknown[] | undefined;
            if (Array.isArray(details) && details.length > 0) {
              const texts: string[] = [];
              for (const item of details) {
                if (typeof item === "string") {
                  texts.push(item);
                  continue;
                }
                if (item && typeof item === "object") {
                  const obj = item as Record<string, unknown>;
                  const text = (obj["content"] as string)
                    || (obj["text"] as string)
                    || "";
                  if (text) texts.push(text);
                  // 从 summary 数组中提取
                  if (Array.isArray(obj["summary"])) {
                    for (const s of obj["summary"] as Record<string, unknown>[]) {
                      const st = (s["text"] as string) || "";
                      if (st) texts.push(st);
                    }
                  }
                }
              }
              if (texts.length > 0) {
                result.reasoningContent = texts.join("\n");
                result.reasoningState = details; // 保留结构化数据以便往返
                result.thinkingArtifact = createThinkingArtifact(
                  effectiveThinkingEncryption(this._config),
                  result.reasoningContent,
                  details,
                  SEALED_SCHEMA_OPENROUTER_CHAT,
                );
              }
            }
          }
        }
      } catch {
        // 忽略提取错误 — 基类的 reasoning_content 仍可使用
      }
    }

    return result;
  }

  // ------------------------------------------------------------------
  // 消息转换 — reasoning_details 往返
  // ------------------------------------------------------------------

  protected override _convertMessages(
    messages: Message[],
  ): Record<string, unknown>[] {
    const converted = super._convertMessages(messages);

    // 使用来自 _reasoning_state 的 reasoning_details 丰富 assistant 消息，
    // 以便通过 OpenRouter 忠实往返。
    // 使用简单的序号映射：基类会保留 assistant 消息顺序。
    const originals = messages as unknown as Record<string, unknown>[];
    const origAssistantIndices: number[] = [];
    const convAssistantIndices: number[] = [];

    for (let i = 0; i < originals.length; i++) {
      if (originals[i]["role"] === "assistant") origAssistantIndices.push(i);
    }
    for (let i = 0; i < converted.length; i++) {
      if (converted[i]["role"] === "assistant") convAssistantIndices.push(i);
    }

    const count = Math.min(origAssistantIndices.length, convAssistantIndices.length);
    for (let i = 0; i < count; i++) {
      const orig = originals[origAssistantIndices[i]];
      const conv = converted[convAssistantIndices[i]];
      const transmission = selectThinkingTransmission(
        resolveMessageThinkingArtifact(orig),
        effectiveThinkingEncryption(this._config),
        effectiveSealedSchema(this._config),
      );
      if (transmission?.kind === "sealed" && Array.isArray(transmission.payload)) {
        conv["reasoning_details"] = transmission.payload;
      }
    }

    return converted;
  }
}
