/**
 * GLM (Zhipu AI) provider adapter.
 *
 * Extends OpenAIChatProvider with thinking support and
 * native web_search tool format.
 */

import type { ModelConfig } from "../config/config.js";
import type { ToolDef } from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

export class GLMProvider extends OpenAIChatProvider {
  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "GLM provider requires a base_url. " +
          "Use provider 'glm', 'glm-intl', 'glm-code', or 'glm-intl-code' (auto-configured) or set base_url.",
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
    if (level === "off" || level === "none") {
      kwargs["extra_body"] = {
        ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
        thinking: { type: "disabled" },
      };
      return;
    }
    kwargs["extra_body"] = {
      ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
      thinking: { type: "enabled", clear_thinking: false },
    };
  }

  protected override _convertTools(
    tools: ToolDef[],
  ): { toolsList: Record<string, unknown>[]; hasNativeWebSearch: boolean } {
    const result: Record<string, unknown>[] = [];
    for (const t of tools) {
      if (t.name === "web_search") {
        if (this._config.supportsWebSearch) {
          result.push({
            type: "web_search",
            web_search: {
              enable: true,
              search_result: true,
            },
          });
          continue;
        }
        // No native support 鈥?fall through to register as a regular function tool
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
