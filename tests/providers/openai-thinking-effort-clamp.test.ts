/**
 * OpenAI ä¸¤æ¡éè·¯ç reasoning effort æ¶æã
 *
 * ææå¼æ¥èª OpenAI reasoning ææ¡£çåå¼éåï¼Responsesï¼none/minimal/low/medium/
 * high/xhighï¼Chat Completions åªå° minimal/low/medium/highï¼ï¼ä¸æ¥èªå®ç°ï¼
 * æ¡£ä½è¡¨éç `xhigh`/`max`ï¼src/config/thinking.tsï¼æ¯åé¨æ ç­¾ï¼
 * è¶åºå¯¹åºä¼ è¾ä¸éæ¶å¿é¡»æ¶æå°è¯¥ä¼ è¾çæé«åæ³å¼ï¼èä¸æ¯åæ ·ååºã
 */

import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../../src/config/types.js";
import { OpenAIChatProvider } from "../../src/providers/openai-chat.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "effort-clamp-test",
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
  it.each([
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "high"],
  ])("sends %1 as %2", async (level, expected) => {
    expect(await chatKwargs(level)).toMatchObject({ reasoning_effort: expected });
  });

  it.each([["off"], ["none"], [undefined]])("omits the field for %s", async (level) => {
    expect((await chatKwargs(level))["reasoning_effort"]).toBeUndefined();
  });
});

describe("Responses reasoning.effort", () => {
  it.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "xhigh"],
  ])("sends %1 as %2", async (level, expected) => {
    expect(await responsesKwargs(level)).toMatchObject({ reasoning: { effort: expected } });
  });

  it.each([["off"], ["none"]])("keeps %s as an explicit effort=none", async (level) => {
    expect(await responsesKwargs(level)).toMatchObject({ reasoning: { effort: "none", summary: "auto" } });
  });
});
