/**
 * DeepSeek Anthropic-compatible provider.
 *
 * Endpoint: https://api.deepseek.com/anthropic
 *
 * Verified live (2026-05): standard Anthropic Messages shape; backend runs
 * automatic prefix cache (no `cache_control` needed); thinking is server-side
 * default-enabled 鈥?must explicitly send `{ type: "disabled" }` to turn off.
 *
 * Thinking effort is controlled via `output_config.effort: "high" | "max"`
 * (max measurably expands the prompt server-side; budget_tokens is ignored).
 *
 * The vendor sends a placeholder `signature` field on thinking blocks (value
 * equals the response id). It is not cryptographically validated 鈥?we do not
 * round-trip it.
 */

import { getProviderDefaultBaseUrl } from "../providers/defaults.js";
import { BaseAnthropicProvider } from "./anthropic-base.js";
import type { SendMessageOptions } from "./base.js";

export class DeepSeekAnthropicProvider extends BaseAnthropicProvider {
  protected override _defaultBaseUrl(): string {
    return getProviderDefaultBaseUrl(this._config.provider) ?? "https://api.deepseek.com/anthropic";
  }

  protected override _applyThinkingParams(
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
    kwargs["output_config"] = { effort: level === "max" ? "max" : "high" };
  }
}
