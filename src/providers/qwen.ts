/**
 * Qwen / DashScope Chat Completions provider adapter.
 *
 * Deprecated rollback path: direct Qwen presets now use qwen-responses.ts.
 *
 * Extends OpenAIChatProvider with Qwen-specific Chat Completions controls.
 *
 * DashScope's OpenAI-compatible API accepts these vendor extensions as
 * top-level request fields when called through the Node OpenAI SDK. Python
 * examples often show them under `extra_body`, but that shape is not
 * serialized correctly by the Node client.
 */

import type { ModelConfig } from "../config/config.js";
import type { SendMessageOptions, ToolDef } from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

export class QwenProvider extends OpenAIChatProvider {
  private static readonly _DASHSCOPE_TOP_LEVEL_KEYS = new Set([
    "enable_thinking",
    "thinking_budget",
    "preserve_thinking",
    "enable_search",
    "search_options",
    "skill",
  ]);

  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "Qwen provider requires a base_url. " +
          "Use provider 'qwen', 'qwen-intl', or 'qwen-us' (auto-configured) or set base_url explicitly.",
      );
    }
    super(config);
  }

  private _hoistDashScopeTopLevelFields(kwargs: Record<string, unknown>): void {
    const extraBody = kwargs["extra_body"];
    if (!extraBody || typeof extraBody !== "object" || Array.isArray(extraBody)) {
      return;
    }

    const body = extraBody as Record<string, unknown>;
    for (const key of QwenProvider._DASHSCOPE_TOP_LEVEL_KEYS) {
      if (!(key in body) || key in kwargs) continue;
      kwargs[key] = body[key];
      delete body[key];
    }
  }

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;

    this._hoistDashScopeTopLevelFields(kwargs);

    const level = options?.thinkingLevel;
    const thinkingOff = level === "off" || level === "none";

    kwargs["enable_thinking"] = !thinkingOff;

    if (!thinkingOff) {
      kwargs["preserve_thinking"] = true;
      if (this._config.thinkingBudget > 0) {
        kwargs["thinking_budget"] = this._config.thinkingBudget;
      }
    } else {
      delete kwargs["preserve_thinking"];
      delete kwargs["thinking_budget"];
    }
  }

  protected override _augmentRequestKwargs(
    kwargs: Record<string, unknown>,
    ctx: {
      hasNativeWebSearch: boolean;
      tools?: ToolDef[];
      options?: SendMessageOptions;
    },
  ): void {
    this._hoistDashScopeTopLevelFields(kwargs);
    if (!ctx.hasNativeWebSearch) return;

    delete kwargs["web_search_options"];
    kwargs["enable_search"] = true;
  }
}
