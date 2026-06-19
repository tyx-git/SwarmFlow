/**
 * @deprecated 2026-05 — 已由 `./xiaomi-anthropic.ts` 中的 XiaomiAnthropicProvider 取代。
 *
 * 仅保留在代码树中用于紧急回滚。注册表不再将 `xiaomi` provider id
 * 分派到此类。新路径稳定后删除此文件。
 *
 * ---- 原始文档字符串如下 ----
 *
 * Xiaomi（MiMo）提供者适配器。
 *
 * 在 OpenAIChatProvider 之上扩展 MiMo 的 thinking 开关：
 * - thinking.type: "enabled" / "disabled"
 *
 * 供应商文档未在原生 API 暴露 effort 子级，因此暴露的级别是两个
 * 已记录行为："off" / "on"。
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
