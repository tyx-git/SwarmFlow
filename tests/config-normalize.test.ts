import { describe, expect, it } from "vitest";

import {
  formatDisplayModelName,
  formatScopedModelName,
  normalizeModelId,
  getContextLength,
  getMultimodalSupport,
  getWebSearchSupport,
  getThinkingLevels,
  getModelMaxOutputTokens,
  getExtendedCacheSupport,
} from "../src/config/config.js";

describe("model identifiers and user supplied capabilities", () => {
  it("normalizes and formats provider scoped identifiers", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(formatDisplayModelName("openrouter", "moonshotai/kimi-k2.5")).toBe("openrouter/kimi-k2.5");
    expect(formatScopedModelName("openai", "gpt-5.4")).toBe("openai/gpt-5.4");
  });

  it("does not infer model capabilities from a packaged catalog", () => {
    expect(getContextLength("openai/gpt-5.4")).toBe(0);
    expect(getMultimodalSupport("openai/gpt-5.4")).toBe(false);
    expect(getModelMaxOutputTokens("gpt-5.4")).toBeUndefined();
    expect(getExtendedCacheSupport("gpt-5.4")).toBe(false);
  });

  it("honors explicit per-model capability overrides", () => {
    expect(getContextLength("custom/model", 128_000)).toBe(128_000);
    expect(getMultimodalSupport("custom/model", true)).toBe(true);
    expect(getMultimodalSupport("custom/model", false)).toBe(false);
  });

  it("uses the configurable default thinking depth list for unknown models", () => {
    expect(getThinkingLevels("unknown/model")).toEqual([
      "off", "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("keeps OpenRouter web search opt-in", () => {
    expect(getWebSearchSupport("any/model", undefined, "openrouter")).toBe(false);
    expect(getWebSearchSupport("any/model", true, "openrouter")).toBe(true);
  });
});
