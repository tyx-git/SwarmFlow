/**
 * @deprecated 2026-05 鈥?superseded by XiaomiAnthropicProvider in `./xiaomi-anthropic.ts`.
 *
 * Kept in the tree for emergency rollback only. The registry no longer
 * dispatches the `xiaomi` provider id to this class. Once the new path has
 * soaked, delete this file.
 *
 * ---- Original docstring follows ----
 *
 * Xiaomi (MiMo) provider adapter.
 *
 * Extends OpenAIChatProvider with MiMo's thinking toggle:
 * - thinking.type: "enabled" / "disabled"
 *
 * Vendor docs do not expose effort sub-levels at the native API, so the
 * surfaced levels are the two documented behaviors: "off" / "on".
 */

import type { ModelConfig } from "../config/config.js";
import type { SendMessageOptions } from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

export class XiaomiProvider extends OpenAIChatProvider {
  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "Xiaomi provider requires a base_url. " +
          "Use provider 'xiaomi' (auto-configured) or set base_url explicitly.",
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
    const type = (level === "off" || level === "none") ? "disabled" : "enabled";
    kwargs["extra_body"] = {
      ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
      thinking: { type },
    };
  }
}
