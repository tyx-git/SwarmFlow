/**
 * Anthropic Claude provider adapter.
 *
 * Claude-specific behavior on top of BaseAnthropicProvider:
 *   - thinking.signature round-trip (closed-source: integrity-checked reasoning)
 *   - cache_control breakpoint placement (mandatory for prompt caching)
 *   - betas forwarding (anthropic-beta header via SDK option)
 *   - adaptive thinking for Claude 4.6 / 4.7 vs. manual budget_tokens for 4.5-
 *   - Claude 4.7 sampling lockout (no temperature / top_p / top_k)
 *   - native web_search_20250305 server tool
 */

import { BaseAnthropicProvider } from "./anthropic-base.js";
import type { SendMessageOptions } from "./base.js";

export class AnthropicProvider extends BaseAnthropicProvider {
  /**
   * Claude 4.6 / 4.7 use Adaptive Thinking:
   *   thinking: { type: "adaptive" }
   *   output_config: { effort: "low" | "medium" | "high" | "max" }
   * Opus 4.7 also accepts effort "xhigh" (exclusive to 4.7).
   *
   * Claude 4.5 and earlier use Manual Extended Thinking:
   *   thinking: { type: "enabled", budget_tokens: N }
   *
   * Matches both the canonical dashed form (`claude-opus-4-7`) used by the
   * Anthropic API and the dotted variant (`claude-opus-4.7`, including
   * suffixes like `-fast`) used by GitHub Copilot's model catalog.
   */
  private static readonly _ADAPTIVE_MODEL_RE =
    /^claude-(opus|sonnet)-4[.-][67]/;

  /** Opus 4.7+ rejects any non-default temperature/top_p/top_k with HTTP 400. */
  private static readonly _NO_SAMPLING_PARAMS_RE =
    /^claude-(opus|sonnet)-4[.-]7/;

  /** Opus 4.7 introduced the `xhigh` effort level (between high and max). */
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
      kwargs["temperature"] = 1; // 4.6 and earlier require temperature=1 with thinking
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

    // 1. Tools 鈥?a system breakpoint alone does NOT cache the tools array, so
    //    without this the tool schemas (~5k tokens) are re-sent uncached on
    //    every call. Marking the last tool definition caches the tools segment.
    markLastBlock(kwargs["tools"]);

    // 2. System 鈥?cache the (static) system prompt.
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

    // 3. Messages 鈥?cache the conversation prefix incrementally by marking the
    //    last message. No effect on a single turn; on a multi-turn conversation
    //    it saves re-reading the whole history uncached on every subsequent turn.
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
