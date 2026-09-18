/**
 * Anthropic Claude 提供者适配器。
 *
 * 在 BaseAnthropicProvider 之上的 Claude 特定行为：
 *   - thinking.signature 往返（闭源：完整性校验的 reasoning）
 *   - cache_control 断点放置（prompt caching 必需）
 *   - betas 转发（通过 SDK 选项发送 anthropic-beta 头）
 *   - Claude 4.6 / 4.7 使用 adaptive thinking，4.5- 使用手动 budget_tokens
 *   - Claude 4.7 采样锁定（无 temperature / top_p / top_k）
 *   - 原生 web_search_20250305 服务端工具
 */

import { BaseAnthropicProvider } from "./anthropic-base.js";
import type { SendMessageOptions } from "./base.js";

export class AnthropicProvider extends BaseAnthropicProvider {
  /**
   * Claude 4.6 / 4.7 使用 Adaptive Thinking：
   *   thinking: { type: "adaptive" }
   *   output_config: { effort: "low" | "medium" | "high" | "max" }
   * Opus 4.7 还接受 effort "xhigh"（4.7 独有）。
   *
   * Claude 4.5 及更早版本使用 Manual Extended Thinking：
   *   thinking: { type: "enabled", budget_tokens: N }
   *
   * 同时匹配 Anthropic API 使用的规范短横线形式（`claude-opus-4-7`）
   * 和 GitHub Copilot 模型目录使用的点号变体（`claude-opus-4.7`，
   * 包括 `-fast` 等后缀）。
   */
  private static readonly _ADAPTIVE_MODEL_RE =
    /^claude-(opus|sonnet)-4[.-][67]/;

  /** Opus 4.7+ 会以 HTTP 400 拒绝任何非默认 temperature/top_p/top_k。 */
  private static readonly _NO_SAMPLING_PARAMS_RE =
    /^claude-(opus|sonnet)-4[.-]7/;

  /** Opus 4.7 引入了 `xhigh` effort 级别（位于 high 和 max 之间）。 */
  private static readonly _XHIGH_EFFORT_RE =
    /^claude-(opus|sonnet)-4[.-]7/;

  protected override _emitSignature(): boolean {
    return true;
  }

  protected override _supportsBetas(): boolean {
    return true;
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
    if (AnthropicProvider._NO_SAMPLING_PARAMS_RE.test(this._config.model)) return;
    const t = options?.temperature !== undefined ? options.temperature : this._config.temperature;
    if (t !== undefined) {
      kwargs["temperature"] = t;
    }
  }

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;

    const level = options?.thinkingLevel;
    const model = this._config.model;
    const noSamplingParams = AnthropicProvider._NO_SAMPLING_PARAMS_RE.test(model);

    if (level === "off" || level === "none") {
      kwargs["thinking"] = { type: "disabled" };
      return;
    }

    if (AnthropicProvider._ADAPTIVE_MODEL_RE.test(model)) {
      kwargs["thinking"] = { type: "adaptive" };

      const validEfforts = AnthropicProvider._XHIGH_EFFORT_RE.test(model)
        ? ["low", "medium", "high", "xhigh", "max"]
        : ["low", "medium", "high", "max"];
      let effort: string;
      if (level && validEfforts.includes(level)) {
        effort = level;
      } else {
        effort = "high";
      }
      kwargs["output_config"] = { effort };
    } else {
      let budget: number;
      if (level === "low") {
        budget = 2048;
      } else if (level === "medium") {
        budget = 5000;
      } else if (level === "high") {
        budget = 10_000;
      } else {
        budget = this._config.thinkingBudget || 10_000;
      }
      budget = Math.max(budget, 1024);
      const currentMax = (kwargs["max_tokens"] as number) || this._config.maxTokens;
      if (currentMax <= budget) {
        kwargs["max_tokens"] = budget + currentMax;
      }
      kwargs["thinking"] = { type: "enabled", budget_tokens: budget };
    }
    if (!noSamplingParams) {
      kwargs["temperature"] = 1; // 4.6 及更早版本在启用 thinking 时要求 temperature=1
    }
  }

  protected override _applyCacheBreakpoint(kwargs: Record<string, unknown>): void {
    const marker = { type: "ephemeral" };

    const markLastBlock = (value: unknown): boolean => {
      if (Array.isArray(value) && value.length > 0) {
        const last = value[value.length - 1];
        if (last && typeof last === "object") {
          (last as Record<string, unknown>)["cache_control"] = marker;
          return true;
        }
      }
      return false;
    };

    // 1. Tools — 仅系统断点不会缓存 tools 数组，
    //    没有这个标记时，工具 schema（约 5k tokens）每次调用都会不走缓存地重发。
    //    标记最后一个工具定义会缓存 tools 段。
    markLastBlock(kwargs["tools"]);

    // 2. System — 缓存（静态）系统提示符。
    const system = kwargs["system"];
    if (typeof system === "string" && system.length > 0) {
      kwargs["system"] = [{
        type: "text",
        text: system,
        cache_control: marker,
      }];
    } else {
      markLastBlock(system);
    }

    // 3. Messages — 通过标记最后一条消息增量缓存对话前缀。
    //    对单回合无影响；在多回合对话中，可避免后续每回合都不走缓存地重读全部历史。
    const messages = kwargs["messages"] as Record<string, unknown>[] | undefined;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const content = msg?.["content"];
        if (typeof content === "string" && content.length > 0) {
          msg["content"] = [{
            type: "text",
            text: content,
            cache_control: marker,
          }];
          break;
        }
        if (markLastBlock(content)) break;
      }
    }
  }
}
