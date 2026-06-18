import { describe, expect, it, mock, spyOn } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import { OpenAIChatProvider } from "../src/providers/openai-chat.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

function modelConfig(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    name: "test",
    provider: "openai",
    model: "gpt-5.2",
    apiKey: "test-key",
    baseUrl: undefined,
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 400_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: true,
    extra: {},
    ...overrides,
  };
}

async function* streamOf(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) {
    yield e;
  }
}

describe("provider response contract (streaming vs non-streaming)", () => {
  it("OpenAI Chat preserves citations/reasoning fields in streaming mode", async () => {
    const provider = new OpenAIChatProvider(modelConfig({ model: "gpt-4.1" }));

    const nonStreamingResponse = {
      choices: [{
        message: {
          content: "Hello from stream",
          reasoning_content: "Reasoning chat",
          annotations: [{ type: "url_citation", url: "https://example.com", title: "Example" }],
        },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    };

    const streamingChunks = [
      {
        choices: [{
          delta: {
            reasoning_content: "Reasoning chat",
          },
        }],
      },
      {
        choices: [{
          delta: {
            content: "Hello from stream",
            annotations: [{ type: "url_citation", url: "https://example.com", title: "Example" }],
          },
        }],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
    ];

    const create = mock(async (params: Record<string, unknown>) => {
      if (params["stream"]) return streamOf(streamingChunks);
      return nonStreamingResponse;
    });

    (provider as any)._client = {
      chat: {
        completions: {
          create,
        },
      },
    };

    const nonStream = await provider.sendMessage([{ role: "user", content: "hi" } as any]);
    const stream = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {}, onReasoningChunk: () => {} },
    );

    expect(stream.text).toBe(nonStream.text);
    expect(stream.reasoningContent).toBe(nonStream.reasoningContent);
    expect(stream.reasoningState).toBe(nonStream.reasoningState);
    expect(stream.citations).toEqual(nonStream.citations);
  });

  it("OpenAI Responses preserves reasoning/citations when response.completed is available", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));

    const finalResponse = {
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Reasoning responses" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "grep",
          arguments: "{\"pattern\":\"abc\"}",
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Answer responses",
            annotations: [{ type: "url_citation", url: "https://example.net", title: "ExampleNet" }],
          }],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 1 },
      },
    };

    const streamEvents = [
      { type: "response.reasoning_summary_text.delta", delta: "Reasoning responses" },
      { type: "response.output_text.delta", delta: "Answer responses" },
      { type: "response.completed", response: finalResponse },
    ];

    const create = mock(async (params: Record<string, unknown>) => {
      if (params["stream"]) return streamOf(streamEvents);
      return finalResponse;
    });

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    const nonStream = await provider.sendMessage([{ role: "user", content: "hi" } as any]);
    const stream = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {}, onReasoningChunk: () => {} },
    );

    expect(stream.text).toBe(nonStream.text);
    expect(stream.reasoningContent).toBe(nonStream.reasoningContent);
    expect(stream.reasoningState).toEqual(nonStream.reasoningState);
    expect(stream.citations).toEqual(nonStream.citations);
  });

  it("OpenAI Responses preserves usage when response.incomplete is available", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));

    const finalResponse = {
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Reasoning incomplete" }],
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Answer incomplete",
          }],
        },
      ],
      incomplete_details: { reason: "max_output_tokens" },
      usage: {
        input_tokens: 21,
        output_tokens: 13,
        input_tokens_details: { cached_tokens: 7 },
      },
    };

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            { type: "response.reasoning_summary_text.delta", delta: "Reasoning incomplete" },
            { type: "response.output_text.delta", delta: "Answer incomplete" },
            { type: "response.incomplete", response: finalResponse },
          ]),
        ),
      },
    };

    const stream = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {}, onReasoningChunk: () => {} },
    );

    expect(stream.text).toBe("Answer incomplete");
    expect(stream.reasoningContent).toBe("Reasoning incomplete");
    expect(stream.usage.inputTokens).toBe(21);
    expect(stream.usage.outputTokens).toBe(13);
    expect(stream.usage.cacheReadTokens).toBe(7);
  });

  it("OpenAI Responses preserves usage when response.done is available", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));

    const finalResponse = {
      output: [
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Answer done",
          }],
        },
      ],
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 3 },
      },
    };

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            { type: "response.output_text.delta", delta: "Answer done" },
            { type: "response.done", response: finalResponse },
          ]),
        ),
      },
    };

    const stream = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {} },
    );

    expect(stream.text).toBe("Answer done");
    expect(stream.usage.inputTokens).toBe(9);
    expect(stream.usage.outputTokens).toBe(4);
    expect(stream.usage.cacheReadTokens).toBe(3);
  });

  it("OpenAI Responses stream fallback still returns reasoningState when final response is absent", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            { type: "response.reasoning_summary_text.delta", delta: "Fallback reasoning" },
            { type: "response.output_text.delta", delta: "Fallback answer" },
          ]),
        ),
      },
    };

    const resp = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {}, onReasoningChunk: () => {} },
    );

    expect(resp.reasoningContent).toBe("Fallback reasoning");
    expect(resp.reasoningState).toBe("Fallback reasoning");
    expect(resp.text).toBe("Fallback answer");
  });
});
