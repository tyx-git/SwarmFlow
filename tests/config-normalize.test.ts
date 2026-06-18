import { describe, expect, it } from "bun:test";

import {
  formatDisplayModelName,
  formatScopedModelName,
  normalizeModelId,
  getContextLength,
  getMultimodalSupport,
  getThinkingSupport,
  getWebSearchSupport,
  getThinkingLevels,
  getModelMaxOutputTokens,
  getExtendedCacheSupport,
} from "../src/config.js";

describe("normalizeModelId", () => {
  it("strips vendor prefix from OpenRouter-style model IDs", () => {
    expect(normalizeModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4.5");
    expect(normalizeModelId("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(normalizeModelId("openai/gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelId("qwen/qwen3.6-plus")).toBe("qwen3.6-plus");
    expect(normalizeModelId("moonshotai/kimi-k2.5")).toBe("kimi-k2.5");
    expect(normalizeModelId("minimax/minimax-m2.5")).toBe("minimax-m2.5");
  });

  it("returns the model ID unchanged when there is no slash", () => {
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("gpt-5.2")).toBe("gpt-5.2");
  });

  it("handles multiple slashes by stripping at the last one", () => {
    expect(normalizeModelId("perplexity/llama-3.1-sonar-small-128k-online"))
      .toBe("llama-3.1-sonar-small-128k-online");
  });
});

describe("OpenRouter display formatting", () => {
  it("normalizes OpenRouter model names for short UI labels", () => {
    expect(formatDisplayModelName("openrouter", "moonshotai/kimi-k2.5")).toBe("openrouter/kimi-k2.5");
    expect(formatDisplayModelName("openrouter", "qwen/qwen3.7-max")).toBe("openrouter/qwen3.7-max");
    expect(formatDisplayModelName("anthropic", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("formats provider-scoped labels without leaking OpenRouter vendor prefixes", () => {
    expect(formatScopedModelName("openrouter", "moonshotai/kimi-k2.5")).toBe("openrouter/kimi-k2.5");
    expect(formatScopedModelName("openrouter", "qwen/qwen3.6-plus")).toBe("openrouter/qwen3.6-plus");
    expect(formatScopedModelName("openai", "gpt-5.2")).toBe("openai/gpt-5.2");
  });
});

describe("getContextLength with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs via normalization", () => {
    expect(getContextLength("anthropic/claude-haiku-4.5")).toBe(200_000);
    expect(getContextLength("anthropic/claude-sonnet-4.6")).toBe(200_000);
    expect(getContextLength("openai/gpt-5.2")).toBe(400_000);
    expect(getContextLength("openai/gpt-5.4")).toBe(1_050_000);
    expect(getContextLength("openai/gpt-5.4-mini")).toBe(400_000);
    expect(getContextLength("openai/gpt-5.4-nano")).toBe(400_000);
    expect(getContextLength("openai/gpt-5.2-codex")).toBe(400_000);
    expect(getContextLength("openai/gpt-5.3-codex")).toBe(400_000);
    expect(getContextLength("qwen/qwen3.6-plus")).toBe(1_000_000);
    expect(getContextLength("qwen/qwen3.7-max")).toBe(1_000_000);
    expect(getContextLength("moonshotai/kimi-k2.5")).toBe(256_000);
    expect(getContextLength("minimax/minimax-m2.5")).toBe(204_800);
  });

  it("still works with exact model IDs (no prefix)", () => {
    expect(getContextLength("claude-sonnet-4-6")).toBe(200_000);
    expect(getContextLength("gpt-5.2")).toBe(400_000);
    expect(getContextLength("gpt-5.4")).toBe(1_050_000);
    expect(getContextLength("gpt-5.4-mini")).toBe(400_000);
    expect(getContextLength("gpt-5.4-nano")).toBe(400_000);
    expect(getContextLength("qwen3.7-max")).toBe(1_000_000);
  });

  it("returns 0 for unknown models", () => {
    expect(getContextLength("unknown/unknown-model")).toBe(0);
  });

  it("respects explicit context length over lookup", () => {
    expect(getContextLength("anthropic/claude-sonnet-4.6", 100_000)).toBe(100_000);
  });
});

describe("getMultimodalSupport with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs", () => {
    expect(getMultimodalSupport("anthropic/claude-haiku-4.5")).toBe(true);
    expect(getMultimodalSupport("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(getMultimodalSupport("openai/gpt-5.2")).toBe(true);
    expect(getMultimodalSupport("openai/gpt-5.4")).toBe(true);
    expect(getMultimodalSupport("openai/gpt-5.4-mini")).toBe(true);
    expect(getMultimodalSupport("openai/gpt-5.4-nano")).toBe(true);
    expect(getMultimodalSupport("openai/gpt-5.2-codex")).toBe(true);
    expect(getMultimodalSupport("openai/gpt-5.3-codex")).toBe(true);
    expect(getMultimodalSupport("qwen/qwen3.6-plus")).toBe(true);
    expect(getMultimodalSupport("moonshotai/kimi-k2.5")).toBe(true);
  });

  it("returns false for non-multimodal models", () => {
    expect(getMultimodalSupport("qwen/qwen3.7-max")).toBe(false);
    expect(getMultimodalSupport("moonshotai/kimi-k2-instruct")).toBe(false);
  });

  it("respects explicit override", () => {
    expect(getMultimodalSupport("moonshotai/kimi-k2-instruct", true)).toBe(true);
    expect(getMultimodalSupport("anthropic/claude-sonnet-4.6", false)).toBe(false);
  });
});

describe("getThinkingSupport with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs", () => {
    expect(getThinkingSupport("anthropic/claude-haiku-4.5")).toBe(true);
    expect(getThinkingSupport("anthropic/claude-opus-4.6")).toBe(true);
    expect(getThinkingSupport("openai/gpt-5.2")).toBe(true);
    expect(getThinkingSupport("openai/gpt-5.4")).toBe(true);
    expect(getThinkingSupport("openai/gpt-5.4-mini")).toBe(true);
    expect(getThinkingSupport("openai/gpt-5.4-nano")).toBe(true);
    expect(getThinkingSupport("openai/gpt-5.2-codex")).toBe(true);
    expect(getThinkingSupport("openai/gpt-5.3-codex")).toBe(true);
    expect(getThinkingSupport("qwen/qwen3.6-plus")).toBe(true);
    expect(getThinkingSupport("qwen/qwen3.7-max")).toBe(true);
    expect(getThinkingSupport("minimax/minimax-m2.5")).toBe(true);
    expect(getThinkingSupport("moonshotai/kimi-k2.5")).toBe(true);
    expect(getThinkingSupport("z-ai/glm-5")).toBe(true);
  });

  it("returns false for non-thinking models", () => {
    expect(getThinkingSupport("moonshotai/kimi-k2-instruct")).toBe(false);
  });
});

describe("getWebSearchSupport with OpenRouter", () => {
  it("defaults to false for OpenRouter provider (paid add-on)", () => {
    expect(getWebSearchSupport("anthropic/claude-sonnet-4.6", undefined, "openrouter")).toBe(false);
  });

  it("respects explicit override for OpenRouter", () => {
    expect(getWebSearchSupport("anthropic/claude-sonnet-4.6", true, "openrouter")).toBe(true);
    expect(getWebSearchSupport("anthropic/claude-sonnet-4.6", false, "openrouter")).toBe(false);
  });

});

describe("getThinkingLevels with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs", () => {
    expect(getThinkingLevels("anthropic/claude-haiku-4.5")).toEqual(
      ["off", "low", "medium", "high"],
    );
    expect(getThinkingLevels("anthropic/claude-opus-4.6")).toEqual(
      ["off", "low", "medium", "high", "max"],
    );
    expect(getThinkingLevels("openai/gpt-5.2-codex")).toEqual(
      ["low", "medium", "high", "xhigh"],
    );
    expect(getThinkingLevels("openai/gpt-5.2")).toEqual(
      ["none", "low", "medium", "high", "xhigh"],
    );
    expect(getThinkingLevels("openai/gpt-5.3-codex")).toEqual(
      ["low", "medium", "high", "xhigh"],
    );
    expect(getThinkingLevels("openai/gpt-5.4")).toEqual(
      ["none", "low", "medium", "high", "xhigh"],
    );
    expect(getThinkingLevels("openai/gpt-5.4-mini")).toEqual(
      ["none", "low", "medium", "high", "xhigh"],
    );
    expect(getThinkingLevels("openai/gpt-5.4-nano")).toEqual(
      ["none", "low", "medium", "high", "xhigh"],
    );
    expect(getThinkingLevels("qwen/qwen3.6-plus")).toEqual(
      ["off", "on"],
    );
    expect(getThinkingLevels("qwen/qwen3.7-max")).toEqual(
      ["off", "on"],
    );
    expect(getThinkingLevels("minimax/minimax-m2.5")).toEqual(
      ["on"],
    );
    expect(getThinkingLevels("moonshotai/kimi-k2.5")).toEqual(
      ["off", "on"],
    );
  });

  it("returns empty array for unknown models", () => {
    expect(getThinkingLevels("unknown/unknown-model")).toEqual([]);
  });

  it("still works with exact model IDs", () => {
    expect(getThinkingLevels("claude-opus-4-6")).toEqual(
      ["off", "low", "medium", "high", "max"],
    );
  });
});

describe("getModelMaxOutputTokens", () => {
  it("returns known values for exact model IDs", () => {
    expect(getModelMaxOutputTokens("claude-opus-4-6")).toBe(128_000);
    expect(getModelMaxOutputTokens("claude-haiku-4-5")).toBe(64_000);
    expect(getModelMaxOutputTokens("gpt-5.2")).toBe(128_000);
    expect(getModelMaxOutputTokens("gpt-5.4-mini")).toBe(128_000);
    expect(getModelMaxOutputTokens("gpt-5.4-nano")).toBe(128_000);
    expect(getModelMaxOutputTokens("qwen3.6-plus")).toBe(65_536);
    expect(getModelMaxOutputTokens("qwen3.7-max")).toBe(65_536);
    expect(getModelMaxOutputTokens("MiniMax-M2.5")).toBe(196_608);
    expect(getModelMaxOutputTokens("kimi-k2.5")).toBe(65_536);
    expect(getModelMaxOutputTokens("glm-5")).toBe(128_000);
  });

  it("recognizes OpenRouter model IDs via normalization", () => {
    expect(getModelMaxOutputTokens("anthropic/claude-opus-4.6")).toBe(128_000);
    expect(getModelMaxOutputTokens("anthropic/claude-haiku-4.5")).toBe(64_000);
    expect(getModelMaxOutputTokens("openai/gpt-5.2")).toBe(128_000);
    expect(getModelMaxOutputTokens("openai/gpt-5.4-mini")).toBe(128_000);
    expect(getModelMaxOutputTokens("openai/gpt-5.4-nano")).toBe(128_000);
    expect(getModelMaxOutputTokens("qwen/qwen3.6-plus")).toBe(65_536);
    expect(getModelMaxOutputTokens("qwen/qwen3.7-max")).toBe(65_536);
    expect(getModelMaxOutputTokens("minimax/minimax-m2.5")).toBe(196_608);
    expect(getModelMaxOutputTokens("moonshotai/kimi-k2.5")).toBe(65_536);
  });

  it("returns undefined for unknown models", () => {
    expect(getModelMaxOutputTokens("unknown/unknown-model")).toBeUndefined();
  });
});

describe("getExtendedCacheSupport", () => {
  it("recognizes new GPT-5.4 variants directly and through normalization", () => {
    expect(getExtendedCacheSupport("gpt-5.4")).toBe(true);
    expect(getExtendedCacheSupport("gpt-5.4-mini")).toBe(true);
    expect(getExtendedCacheSupport("gpt-5.4-nano")).toBe(true);
    expect(getExtendedCacheSupport("openai/gpt-5.4-mini")).toBe(true);
    expect(getExtendedCacheSupport("openai/gpt-5.4-nano")).toBe(true);
  });

  it("returns false for models outside the whitelist", () => {
    expect(getExtendedCacheSupport("unknown/unknown-model")).toBe(false);
  });
});
