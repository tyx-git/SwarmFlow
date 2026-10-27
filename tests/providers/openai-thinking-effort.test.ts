/**
 * OpenAI 两条通路的 reasoning effort 透传契约。
 *
 * 期望值来自"客户端不改写用户选择"这一约定（合法集合按模型而定：OpenAI 文档列出
 * none/minimal/low/medium/high/xhigh/max，其中 max 仅 GPT-6/GPT-5.6 的 Responses 支持）：
 * 选什么发什么，端点不认就让它报错，客户端不静默换档。
 */

import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../../src/config/types.js";
import { OpenAIChatProvider } from "../../src/providers/openai-chat.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "effort-verbatim-test",
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 400_000,
    supportsMultimodal: false,
    thinkingBudget: 0,
    supportsWebSearch: false,
    extra: {},
    ...overrides,
  };
}

async function chatKwargs(thinkingLevel: string | undefined): Promise<Record<string, unknown>> {
  const provider = new OpenAIChatProvider(modelConfig());
  const create = vi.fn(async () => ({ choices: [{ message: { content: "ok", tool_calls: [] } }] }));
  (provider as unknown as { _client: unknown })._client = { chat: { completions: { create } } };

  await provider.sendMessage([{ role: "user", content: "hi" }] as never, undefined, { thinkingLevel });
  return (create.mock.calls[0]?.[0] as Record<string, unknown>) ?? {};
}

async function responsesKwargs(thinkingLevel: string | undefined): Promise<Record<string, unknown>> {
  const provider = new OpenAIResponsesProvider(modelConfig());
  const create = vi.fn(async () => ({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  (provider as unknown as { _client: unknown })._client = { responses: { create } };

  await provider.sendMessage([{ role: "user", content: "hi" }] as never, undefined, { thinkingLevel });
  return (create.mock.calls[0]?.[0] as Record<string, unknown>) ?? {};
}

describe("Chat Completions reasoning_effort", () => {
  it.each([["minimal"], ["low"], ["medium"], ["high"], ["xhigh"], ["max"]])(
    "sends %s unchanged",
    async (level) => {
      expect(await chatKwargs(level)).toMatchObject({ reasoning_effort: level });
    },
  );

  it.each([["off"], ["none"], [undefined]])("omits the field for %s", async (level) => {
    expect((await chatKwargs(level))["reasoning_effort"]).toBeUndefined();
  });
});

describe("Responses reasoning.effort", () => {
  it.each([["low"], ["medium"], ["high"], ["xhigh"], ["max"]])("sends %s unchanged", async (level) => {
    expect(await responsesKwargs(level)).toMatchObject({ reasoning: { effort: level } });
  });

  it.each([["off"], ["none"]])("keeps %s as an explicit effort=none", async (level) => {
    expect(await responsesKwargs(level)).toMatchObject({ reasoning: { effort: "none", summary: "auto" } });
  });
});
