/**
 * MiniMax Anthropic-compatible provider.
 *
 * Endpoints:
 *   - Global: https://api.minimax.io/anthropic
 *   - China:  https://api.minimaxi.com/anthropic
 *
 * Verified live (2026-05): standard Anthropic Messages shape; backend runs
 * automatic prefix cache (no `cache_control` needed 鈥?verified by hitting the
 * same prefix across two requests without any marker and seeing
 * `cache_read_input_tokens` jump on the second turn).
 *
 * MiniMax does emit a real-looking `signature` (64-char hex) on thinking
 * blocks, but it is NOT cryptographically validated 鈥?a fake signature
 * round-trips successfully. Open-source model, so we do not round-trip it.
 *
 * Vendor quirks: temperature is constrained to (0.0, 1.0) 鈥?exclusive of
 * both endpoints. We clamp on the boundaries.
 */

import { BaseAnthropicProvider } from "./anthropic-base.js";
import type { ModelConfig } from "../config/config.js";
import { getProviderDefaultBaseUrl } from "../providers/defaults.js";
import type { SendMessageOptions } from "./base.js";

export class MiniMaxAnthropicProvider extends BaseAnthropicProvider {
  constructor(config: ModelConfig) {
    super(config);
  }

  protected override _defaultBaseUrl(): string {
    return getProviderDefaultBaseUrl(this._config.provider) ?? "https://api.minimax.io/anthropic";
  }

  protected override _applySamplingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    const raw = options?.temperature !== undefined ? options.temperature : this._config.temperature;
    if (raw === undefined) return;
    // MiniMax: temperature 鈭?(0.0, 1.0), exclusive on both ends.
    let t = raw;
    if (t <= 0) t = 0.01;
    if (t >= 1) t = 0.99;
    kwargs["temperature"] = t;
  }
}
