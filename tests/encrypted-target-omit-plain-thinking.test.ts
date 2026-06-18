import { describe, expect, it } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

function anthropicConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "claude-test",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "test-key",
    baseUrl: "https://api.anthropic.com",
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 200_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: false,
    transportProtocol: "anthropic",
    thinkingEncryption: "anthropic",
    sealedSchema: "anthropic-messages",
    extra: {},
    ...overrides,
  };
}

function openaiConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "gpt-test",
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 400_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: false,
    transportProtocol: "responses",
    thinkingEncryption: "openai",
    sealedSchema: "openai-responses",
    extra: {},
    ...overrides,
  };
}

describe("plain thinking is omitted for encrypted targets", () => {
  it("does not fabricate Anthropic thinking blocks from plain replay text", () => {
    const provider = new AnthropicProvider(anthropicConfig());
    const converted = (provider as any)._convertMessages([
      {
        role: "assistant",
        content: "visible answer",
        _thinking_artifact: {
          encryption: "none",
          plainReplayText: "plain replay",
        },
      },
    ]) as { converted: Array<Record<string, unknown>> };

    const assistant = converted.converted[0];
    expect(assistant["content"]).toEqual([
      { type: "text", text: "visible answer" },
    ]);
  });

  it("does not fabricate Responses reasoning items from plain replay text", () => {
    const provider = new OpenAIResponsesProvider(openaiConfig());
    const input = (provider as any)._buildInput([
      {
        role: "assistant",
        content: "visible answer",
        _thinking_artifact: {
          encryption: "none",
          plainReplayText: "plain replay",
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible answer" }],
      },
    ]);
  });
});
