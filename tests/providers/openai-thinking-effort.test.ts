/**
 * OpenAI ä¸¤æ¡éè·¯ç reasoning effort éä¼ å¥çº¦ã
 *
 * ææå¼æ¥èª"å®¢æ·ç«¯ä¸æ¹åç¨æ·éæ©"è¿ä¸çº¦å®ï¼åæ³éåææ¨¡åèå®ï¼OpenAI ææ¡£ååº
 * none/minimal/low/medium/high/xhigh/maxï¼å¶ä¸­ max ä» GPT-6/GPT-5.6 ç Responses æ¯æï¼ï¼
 * éä»ä¹åä»ä¹ï¼ç«¯ç¹ä¸è®¤å°±è®©å®æ¥éï¼å®¢æ·ç«¯ä¸éé»æ¢æ¡£ã
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
