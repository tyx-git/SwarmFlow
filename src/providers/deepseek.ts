/**
 * @deprecated 2026-05 鈥?superseded by DeepSeekAnthropicProvider in `./deepseek-anthropic.ts`.
 *
 * Kept in the tree for emergency rollback only. The registry no longer
 * dispatches the `deepseek` provider id to this class. Once the new path
 * has soaked, delete this file.
 *
 * ---- Original docstring follows ----
 *
 * DeepSeek provider adapter.
 *
 * Extends OpenAIChatProvider with DeepSeek's thinking control:
 * - thinking.type: "enabled" / "disabled" toggles reasoning mode
 * - reasoning_effort: "high" / "max" picks effort within thinking mode
 *   (DeepSeek auto-maps low/medium 鈫?high and xhigh 鈫?max, so we surface
 *   only the three documented behaviors as levels: off / high / max)
 */

import type { ModelConfig } from "../config/config.js";
import type { SendMessageOptions } from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

export class DeepSeekProvider extends OpenAIChatProvider {
  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "DeepSeek provider requires a base_url. " +
          "Use provider 'deepseek' (auto-configured) or set base_url explicitly.",
      );
    }
    super(config);
  }

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;
    const level = options?.thinkingLevel;

    if (level === "off" || level === "none") {
      kwargs["extra_body"] = {
        ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
        thinking: { type: "disabled" },
      };
      return;
    }

    kwargs["extra_body"] = {
      ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
      thinking: { type: "enabled" },
    };
    kwargs["reasoning_effort"] = level === "max" ? "max" : "high";
  }
}
