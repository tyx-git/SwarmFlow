/**
 * MiniMax Anthropic 兼容提供者。
 *
 * 端点：
 *   - Global: https://api.minimax.io/anthropic
 *   - China:  https://api.minimaxi.com/anthropic
 *
 * 实机验证（2026-05）：标准 Anthropic Messages 形状；后端运行
 * 自动前缀缓存（不需要 `cache_control` — 已通过两次请求命中相同前缀且
 * 不携带任何标记，并观察到第二回合 `cache_read_input_tokens` 跳升来验证）。
 *
 * MiniMax 确实会在 thinking 块上发出看起来真实的 `signature`（64 字符 hex），
 * 但它不经过密码学验证 — 假签名也能成功往返。开源模型，因此我们不往返它。
 *
 * 供应商特性：temperature 被约束在 (0.0, 1.0) — 两端均不包含。
 * 我们会在边界处进行 clamp。
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
    // MiniMax: temperature ∈(0.0, 1.0), exclusive on both ends.
    let t = raw;
    if (t <= 0) t = 0.01;
    if (t >= 1) t = 0.99;
    kwargs["temperature"] = t;
  }
}
