/**
 * @deprecated 2026-05 — 已由 `./kimi-anthropic.ts` 中的 KimiAnthropicProvider 取代。
 *
 * 仅保留在代码树中用于紧急回滚。注册表不再将 `kimi*` provider id
 * 分派到此类 — 实际接线见 registry.ts。新路径稳定后删除此文件。
 *
 * ---- 原始文档字符串如下 ----
 *
 * Kimi（Moonshot）提供者适配器。
 *
 * 在 OpenAIChatProvider 之上扩展：
 * - builtin_function.$web_search 工具转换（echo 由 tool loop 处理）
 * - thinking 模式强制 temperature=1
 * - 对所有 assistant 消息强制 reasoning_content
 */

import type { ModelConfig } from "../config/config.js";
import type { Message, ToolDef } from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

export class KimiProvider extends OpenAIChatProvider {
  private _thinkingEnabledForRequest = true;

  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "Kimi provider requires a base_url. " +
          "Use provider 'kimi', 'kimi-cn', or 'kimi-code', or set base_url explicitly.",
      );
    }
    super(config);
  }

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: import("./base.js").SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;
    const level = options?.thinkingLevel;
    if (level === "off" || level === "none") return;
    // Kimi K2.5 thinking 要求 temperature=1
    kwargs["temperature"] = 1;
  }

  protected override _convertMessages(
    messages: Message[],
  ): Record<string, unknown>[] {
    const converted = super._convertMessages(messages);
    if (!this._thinkingEnabledForRequest) {
      for (const msg of converted) {
        if (msg["role"] === "assistant") {
          delete msg["reasoning_content"];
        }
      }
      return converted;
    }
    // thinking 激活时，Kimi 要求所有 assistant 消息都带 reasoning_content。
    // 确保有非空回退。
    for (const msg of converted) {
      if (msg["role"] !== "assistant") continue;

      const rc = msg["reasoning_content"];
      if (typeof rc === "string" && rc.trim()) continue;

      const content = msg["content"];
      if (typeof content === "string" && content.trim()) {
        msg["reasoning_content"] = content;
      } else {
        msg["reasoning_content"] = "[assistant tool call]";
      }
    }
    return converted;
  }

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: import("./base.js").SendMessageOptions,
  ): Promise<import("./base.js").ProviderResponse> {
    this._thinkingEnabledForRequest = !(
      options?.thinkingLevel === "off" || options?.thinkingLevel === "none"
    );
    try {
      return await super.sendMessage(messages, tools, options);
    } finally {
      this._thinkingEnabledForRequest = true;
    }
  }

  protected override _convertTools(
    tools: ToolDef[],
  ): { toolsList: Record<string, unknown>[]; hasNativeWebSearch: boolean } {
    const result: Record<string, unknown>[] = [];
    for (const t of tools) {
      if (t.name === "web_search") {
        if (this._config.supportsWebSearch) {
          result.push({
            type: "builtin_function",
            function: { name: "$web_search" },
          });
          continue;
        }
        // 没有原生支持 — 继续注册为常规函数工具
      }
      result.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      });
    }
    return { toolsList: result, hasNativeWebSearch: false };
  }
}
