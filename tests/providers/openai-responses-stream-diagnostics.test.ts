/**
 * Responses 流式终止判定与失败可见性。
 *
 * 期望值来自 Responses SSE 线格式约定（终止事件为 response.completed /
 * response.incomplete / response.failed，失败时 error 挂在 response.error 上），
 * 不来自实现：
 * - 迭代器一个事件都没产出（网关把 /responses 当网页返回）必须说清是 0 个事件，
 *   不能与"流到一半被截断"共用一句"断流"；
 * - response.failed 是确定性失败，不能伪装成可重掷的上游抖动。
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
      { type: "response.output_text.delta", delta: "半句" },
    ]);

    expect(resp.stopReason).toBe("incomplete_stream");
    expect(resp.streamEventCount).toBe(2);
    expect(resp.text).toBe("半句");
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
    // 关键契约：不是 TurnIncompleteError，所以 tool-loop 不会烧掉 3 次重掷预算。
    expect(isTurnIncompleteError(caught)).toBe(false);
  });
});
