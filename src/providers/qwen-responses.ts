/**
 * Qwen / DashScope Responses API 提供者适配器。
 *
 * DashScope 的 OpenAI 兼容 Responses 端点大体遵循 OpenAI
 * Responses 线路格式，但 Qwen 特定控制项在 Node OpenAI SDK 形状中
 * 仍作为顶层请求字段保留。
 */

import type { SendMessageOptions } from "./base.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";

export class QwenResponsesProvider extends OpenAIResponsesProvider {
  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    const level = options?.thinkingLevel;
    const thinkingOff = level === "off" || level === "none";
    kwargs["enable_thinking"] = !thinkingOff;
  }

  protected override _nativeWebSearchTool(): Record<string, unknown> {
    return { type: "web_search" };
  }

  protected override _supportsMaxOutputTokens(): boolean {
    return false;
  }

  protected override _supportsPromptCacheKey(): boolean {
    return false;
  }

  protected override _forceStream(options?: SendMessageOptions): boolean {
    // Qwen Responses requires streaming for reasoning/tool events. Keep the
    // historical behavior for the default call path while allowing explicit
    // `off` to use the normal non-streaming response.
    const level = options?.thinkingLevel;
    return level === undefined || (level !== "off" && level !== "none");
  }

  protected override _plainThinkingInputItems(
    plainReplayText: string,
  ): Record<string, unknown>[] {
    const text = plainReplayText.trim();
    if (!text) return [];
    return [{
      type: "reasoning",
      summary: [{ type: "summary_text", text }],
    }];
  }
}
