/**
 * Responses æµå¼ç»æ­¢å¤å®ä¸å¤±è´¥å¯è§æ§ã
 *
 * ææå¼æ¥èª Responses SSE çº¿æ ¼å¼çº¦å®ï¼ç»æ­¢äºä»¶ä¸º response.completed /
 * response.incomplete / response.failedï¼å¤±è´¥æ¶ error æå¨ response.error ä¸ï¼ï¼
 * ä¸æ¥èªå®ç°ï¼
 * - è¿­ä»£å¨ä¸ä¸ªäºä»¶é½æ²¡äº§åºï¼ç½å³æ /responses å½ç½é¡µè¿åï¼å¿é¡»è¯´æ¸æ¯ 0 ä¸ªäºä»¶ï¼
 *   ä¸è½ä¸"æµå°ä¸åè¢«æªæ­"å±ç¨ä¸å¥"æ­æµ"ï¼
 * - response.failed æ¯ç¡®å®æ§å¤±è´¥ï¼ä¸è½ä¼ªè£æå¯éæ·çä¸æ¸¸æå¨ã
 */

import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../../src/config/types.js";
import { isTurnIncompleteError } from "../../src/network/retry.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";

function modelConfig(): ModelConfig {
  return {
    name: "responses-stream-test",
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
  };
}

async function* streamOf(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const event of events) yield event;
}

async function runStream(events: Array<Record<string, unknown>>): Promise<Awaited<ReturnType<OpenAIResponsesProvider["sendMessage"]>>> {
  const provider = new OpenAIResponsesProvider(modelConfig());
  (provider as unknown as { _client: unknown })._client = {
    responses: { create: vi.fn(async () => streamOf(events)) },
  };
  return provider.sendMessage([{ role: "user", content: "hi" }] as never, undefined, {
    onTextChunk: () => {},
  });
}

describe("Responses stream termination diagnostics", () => {
  it("counts zero events when the endpoint produced no SSE payload at all", async () => {
    const resp = await runStream([]);

    expect(resp.stopReason).toBe("incomplete_stream");
    expect(resp.streamEventCount).toBe(0);
  });

  it("counts the events it did see when the stream stops before a terminal event", async () => {
    const resp = await runStream([
      { type: "response.created", response: {} },
      { type: "response.output_text.delta", delta: "åå¥" },
    ]);

    expect(resp.stopReason).toBe("incomplete_stream");
    expect(resp.streamEventCount).toBe(2);
    expect(resp.text).toBe("åå¥");
  });

  it("surfaces the upstream error carried by response.failed", async () => {
    let caught: unknown;
    try {
      await runStream([
        {
          type: "response.failed",
          response: { status: "failed", error: { code: "data_inspection_failed", message: "input refused" } },
        },
      ]);
    } catch (e) {
      caught = e;
    }

    expect(String((caught as Error).message)).toContain("data_inspection_failed");
    expect(String((caught as Error).message)).toContain("input refused");
    // å³é®å¥çº¦ï¼ä¸æ¯ TurnIncompleteErrorï¼æä»¥ tool-loop ä¸ä¼ç§æ 3 æ¬¡éæ·é¢ç®ã
    expect(isTurnIncompleteError(caught)).toBe(false);
  });
});
