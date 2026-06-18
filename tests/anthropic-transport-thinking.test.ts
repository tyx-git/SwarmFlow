import { describe, expect, it } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import { KimiAnthropicProvider } from "../src/providers/kimi-anthropic.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "kimi-test",
    provider: "kimi",
    model: "kimi-k2.5",
    apiKey: "test-key",
    baseUrl: "https://api.moonshot.ai/anthropic",
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 256_000,
    supportsMultimodal: false,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: false,
    transportProtocol: "anthropic",
    thinkingEncryption: "none",
    sealedSchema: null,
    extra: {},
    ...overrides,
  };
}

describe("Anthropic transport with non-encrypted thinking", () => {
  it("encodes plain replay text as an unsigned thinking block", () => {
    const provider = new KimiAnthropicProvider(modelConfig());
    const converted = (provider as any)._convertMessages([
      {
        role: "assistant",
        content: "visible answer",
        _thinking_artifact: {
          encryption: "none",
          plainReplayText: "plain summary",
        },
      },
    ]) as { converted: Array<Record<string, unknown>> };

    const assistant = converted.converted[0];
    expect(assistant["role"]).toBe("assistant");
    expect(assistant["content"]).toEqual([
      { type: "thinking", thinking: "plain summary" },
      { type: "text", text: "visible answer" },
    ]);
  });

  it("uses Anthropic native web search for Kimi", () => {
    const provider = new KimiAnthropicProvider(modelConfig({ supportsWebSearch: true }));
    const tools = (provider as any)._convertTools([
      { name: "web_search", description: "search", parameters: { type: "object", properties: {} } },
    ]) as Array<Record<string, unknown>>;

    expect(tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 20 },
    ]);
  });

  it("uses the shared kimi-code default base URL fallback", () => {
    const provider = new KimiAnthropicProvider(modelConfig({ provider: "kimi-code", baseUrl: undefined }));
    expect((provider as any)._defaultBaseUrl()).toBe("https://api.kimi.com/coding");
  });
});
