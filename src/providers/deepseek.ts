/**
 * @deprecated 2026-05 — 已由 `./deepseek-anthropic.ts` 中的 DeepSeekAnthropicProvider 取代。
 *
 * 仅保留在代码树中用于紧急回滚。注册表不再将 `deepseek` provider id
 * 分派到此类。新路径稳定后删除此文件。
 *
 * ---- 原始文档字符串如下 ----
 *
 * DeepSeek 提供者适配器。
 *
 * 在 OpenAIChatProvider 之上扩展 DeepSeek 的 thinking 控制：
 * - thinking.type: "enabled" / "disabled" 切换 reasoning 模式
 * - reasoning_effort: "high" / "max" 在 thinking 模式中选择 effort
 *   （DeepSeek 会自动将 low/medium 映射到 high，将 xhigh 映射到 max，
 *   因此我们只将三个已记录行为作为级别暴露：off / high / max）
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
