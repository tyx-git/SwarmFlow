/**
 * Kimi (Moonshot) Anthropic 兼容提供者。
 *
 * 端点：
 *   - Global: https://api.moonshot.ai/anthropic
 *   - China:  https://api.moonshot.cn/anthropic
 *
 * 实机验证（2026-05）：端点返回标准 Anthropic Messages 形状，
 * 包含结构化 thinking/text 块。后端运行自动前缀缓存 — 不需要 `cache_control` 标记。
 * `thinking.signature` 缺失（开源模型），因此我们不对其往返。
 *
 * 供应商特性：K2.5 thinking 要求 temperature=1。
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
   * Kimi 的 `/anthropic` web_search 在退化（空）搜索时会发出没有
   * `partial_json` 字段的 `input_json_delta` 事件，这会让 SDK 的流解析器崩溃。
   * 在 SDK 看到之前修复 SSE。
   */
  protected override _wrapFetch() {
    return makeAnthropicSSERepairFetch();
  }

  /**
   * Kimi 在每个搜索回合的服务端 web_search 前都会预置
   * "Search results for query: ..." 文本块。
   * 在实时流中抑制它（仅在实际启用网页搜索时相关）。
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
      // Kimi K2.5/K2.6 thinking 模式要求 temperature=1。
      kwargs["temperature"] = 1;
      return;
    }
    const t = options?.temperature !== undefined ? options.temperature : this._config.temperature;
    if (t !== undefined) {
      kwargs["temperature"] = t;
    }
  }
}
