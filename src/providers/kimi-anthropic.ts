/**
 * Kimi (Moonshot) Anthropic-compatible provider.
 *
 * Endpoints:
 *   - Global: https://api.moonshot.ai/anthropic
 *   - China:  https://api.moonshot.cn/anthropic
 *
 * Verified live (2026-05): the endpoint returns standard Anthropic Messages
 * shape with structured thinking/text blocks. Backend runs automatic prefix
 * cache 鈥?`cache_control` markers are unnecessary. `thinking.signature` is
 * absent (open-source model) so we do not round-trip it.
 *
 * Vendor quirks: K2.5 thinking requires temperature=1.
 */

import type { ModelConfig } from "../config/config.js";
import { getProviderDefaultBaseUrl } from "../providers/defaults.js";
import { makeAnthropicSSERepairFetch } from "./anthropic-sse-repair.js";
import { BaseAnthropicProvider } from "./anthropic-base.js";
import type { SendMessageOptions } from "./base.js";

export class KimiAnthropicProvider extends BaseAnthropicProvider {
  constructor(config: ModelConfig) {
    super(config);
  }

  protected override _defaultBaseUrl(): string {
    return getProviderDefaultBaseUrl(this._config.provider) ?? "https://api.moonshot.ai/anthropic";
  }

  /**
   * Kimi's `/anthropic` web_search emits `input_json_delta` events without a
   * `partial_json` field on degenerate (empty) searches, which crashes the
   * SDK's stream parser. Repair the SSE before the SDK sees it.
   */
  protected override _wrapFetch() {
    return makeAnthropicSSERepairFetch();
  }

  /**
   * Kimi prepends a "Search results for query: ..." text block before its
   * server-side web_search on every search turn. Suppress it from the live
   * stream (only relevant when web search is actually enabled).
   */
  protected override _dropsLeadingSearchPreamble(): boolean {
    return this._config.supportsWebSearch;
  }

  protected override _convertWebSearchTool(): Record<string, unknown> {
    return {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 20,
    };
  }

  protected override _applySamplingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    const thinkingOff = options?.thinkingLevel === "off" || options?.thinkingLevel === "none";
    if (this._config.supportsThinking && !thinkingOff) {
      // Kimi K2.5/K2.6 thinking mode requires temperature=1.
      kwargs["temperature"] = 1;
      return;
    }
    const t = options?.temperature !== undefined ? options.temperature : this._config.temperature;
    if (t !== undefined) {
      kwargs["temperature"] = t;
    }
  }
}
