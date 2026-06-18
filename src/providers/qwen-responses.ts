/**
 * Qwen / DashScope Responses API provider adapter.
 *
 * DashScope's OpenAI-compatible Responses endpoint mostly follows the OpenAI
 * Responses wire format, but Qwen-specific controls stay as top-level request
 * fields in the Node OpenAI SDK shape.
 */

import type { SendMessageOptions } from "./base.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";

export class QwenResponsesProvider extends OpenAIResponsesProvider {
  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;

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
    if (!this._config.supportsThinking) return false;
    const level = options?.thinkingLevel;
    return level !== "off" && level !== "none";
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
