import { describe, expect, it } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import { MiniMaxProvider } from "../src/providers/minimax.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "minimax-test",
    provider: "minimax",
    model: "MiniMax-M2.5",
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 204800,
    supportsMultimodal: false,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: false,
    extra: {},
    ...overrides,
  };
}

describe("MiniMax reasoning mapping", () => {
  it("maps converted assistant messages to original ones by content and skips unmatched inserted entries", () => {
    const original: Array<Record<string, unknown>> = [
      { role: "assistant", content: "A1", reasoning_content: "R1" },
      { role: "assistant", content: "A2", reasoning_content: "R2" },
    ];
    const converted: Array<Record<string, unknown>> = [
      { role: "assistant", content: "[inserted by converter]" },
      { role: "assistant", content: "A1" },
      { role: "assistant", content: "A2" },
    ];

    const mapping = (MiniMaxProvider as any)._buildAssistantIndexMap(
      original,
      converted,
    ) as Map<number, number>;

    expect(mapping.has(0)).toBe(false);
    expect(mapping.get(1)).toBe(0);
    expect(mapping.get(2)).toBe(1);
  });

  it("re-embeds reasoning into the corresponding assistant message", () => {
    const provider = new MiniMaxProvider(modelConfig());
    const converted = (provider as any)._convertMessages([
      { role: "assistant", content: "Answer one", reasoning_content: "Reasoning one" },
      { role: "assistant", content: "Answer two", reasoning_content: "Reasoning two" },
    ]) as Array<Record<string, unknown>>;

    expect(String(converted[0]["content"])).toContain("<think>\nReasoning one\n</think>\nAnswer one");
    expect(String(converted[1]["content"])).toContain("<think>\nReasoning two\n</think>\nAnswer two");
  });
});
