/**
 * DeepSeek Anthropic 兼容提供者。
 *
 * 端点：https://api.deepseek.com/anthropic
 *
 * 实机验证（2026-05）：标准 Anthropic Messages 形状；后端运行
 * 自动前缀缓存（不需要 `cache_control`）；thinking 在服务端默认启用 —
 * 必须显式发送 `{ type: "disabled" }` 才能关闭。
 *
 * Thinking effort 通过 `output_config.effort: "high" | "max"` 控制
 *（max 会在服务端可测地扩展 prompt；budget_tokens 会被忽略）。
 *
 * 供应商会在 thinking 块上发送占位 `signature` 字段（值等于响应 id）。
 * 它不经过密码学验证 — 我们不往返它。
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
