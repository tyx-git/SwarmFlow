import { describe, expect, it, mock } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import type { ToolDef } from "../src/providers/base.js";
import { createProvider } from "../src/providers/registry.js";
import { QwenResponsesProvider } from "../src/providers/qwen-responses.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "qwen-responses-test",
    provider: "qwen-intl",
    model: "qwen3.6-plus",
    apiKey: "test-key",
    baseUrl: "https://dashscope-intl.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1",
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 1_000_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: true,
    transportProtocol: "responses",
    thinkingEncryption: "none",
    sealedSchema: null,
    extra: {},
    ...overrides,
  };
}

async function* streamOf(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const event of events) {
    yield event;
  }
}

const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  description: "Search the web",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
};

describe("QwenResponsesProvider request shaping", () => {
  it("is the registry target for direct Qwen providers", () => {
    expect(createProvider(modelConfig())).toBeInstanceOf(QwenResponsesProvider);
  });

  it("maps SwarmFlow web_search to Qwen Responses built-in web_search", async () => {
    const provider = new QwenResponsesProvider(modelConfig());
    const create = mock(async (params: Record<string, unknown>) => ({
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      _params: params,
    }));

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    await provider.sendMessage(
      [{ role: "user", content: "find recent docs" } as any],
      [WEB_SEARCH_TOOL],
      { thinkingLevel: "off", promptCacheKey: "cache-key" },
    );

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params["tools"]).toEqual([{ type: "web_search" }]);
    expect(params["enable_thinking"]).toBe(false);
    expect(params["reasoning"]).toBeUndefined();
    expect(params["max_output_tokens"]).toBeUndefined();
    expect(params["prompt_cache_key"]).toBeUndefined();
  });

  it("keeps ordinary function tools flat and enables thinking at top level", async () => {
    const provider = new QwenResponsesProvider(modelConfig());
    const finalResponse = {
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
    };
    const create = mock(async (params: Record<string, unknown>) => {
      if (params["stream"]) {
        return streamOf([{ type: "response.completed", response: finalResponse }]);
      }
      return finalResponse;
    });
    const grepTool: ToolDef = {
      name: "grep",
      description: "Search files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
        },
        required: ["pattern"],
      },
    };

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    await provider.sendMessage(
      [{ role: "user", content: "search repo" } as any],
      [grepTool],
      {},
    );

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params["stream"]).toBe(true);
    expect(params["enable_thinking"]).toBe(true);
    expect(params["tools"]).toEqual([
      {
        type: "function",
        name: "grep",
        description: "Search files",
        parameters: grepTool.parameters,
      },
    ]);
  });

  it("replays prior plain thinking as a Qwen Responses reasoning item", async () => {
    const provider = new QwenResponsesProvider(modelConfig());
    const finalResponse = {
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
    };
    const create = mock(async (params: Record<string, unknown>) => {
      if (params["stream"]) {
        return streamOf([{ type: "response.completed", response: finalResponse }]);
      }
      return finalResponse;
    });

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    await provider.sendMessage(
      [
        {
          role: "assistant",
          content: "visible answer",
          _thinking_artifact: {
            encryption: "none",
            plainReplayText: "prior qwen thinking",
          },
        },
        { role: "user", content: "follow up" },
      ] as any,
      undefined,
      {},
    );

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params["input"]).toEqual([
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "prior qwen thinking" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible answer" }],
      },
      { role: "user", content: "follow up" },
    ]);
  });

  it("returns parsed tool calls for forced-stream callers without lifecycle callbacks", async () => {
    const provider = new QwenResponsesProvider(modelConfig());
    const finalResponse = {
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "grep",
          arguments: "{\"pattern\":\"qwen\"}",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
    };
    const create = mock(async () =>
      streamOf([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_1",
            name: "grep",
            arguments: "{\"pattern\":\"qwen\"}",
          },
        },
        { type: "response.completed", response: finalResponse },
      ]),
    );
    const grepTool: ToolDef = {
      name: "grep",
      description: "Search files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
        },
        required: ["pattern"],
      },
    };

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    const response = await provider.sendMessage(
      [{ role: "user", content: "search repo" } as any],
      [grepTool],
      {},
    );

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.id).toBe("call_1");
    expect(response.toolCalls[0]!.name).toBe("grep");
    expect(response.toolCalls[0]!.arguments).toEqual({ pattern: "qwen" });
  });

  it("extracts Qwen web_search_call sources as citations", async () => {
    const provider = new QwenResponsesProvider(modelConfig({ supportsThinking: false }));
    const create = mock(async () => ({
      output: [
        {
          type: "web_search_call",
          action: {
            query: "qwen docs",
            sources: [
              { type: "url", url: "https://docs.qwencloud.com/" },
            ],
          },
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "found it" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
    }));

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    const response = await provider.sendMessage(
      [{ role: "user", content: "find qwen docs" } as any],
      [WEB_SEARCH_TOOL],
    );

    expect(response.text).toBe("found it");
    expect(response.citations).toEqual([
      {
        url: "https://docs.qwencloud.com/",
        title: "",
        citedText: "qwen docs",
      },
    ]);
  });

  it("keeps streamed Qwen web_search_call sources when the final response omits them", async () => {
    const provider = new QwenResponsesProvider(modelConfig());
    const create = mock(async () =>
      streamOf([
        {
          type: "response.output_item.done",
          item: {
            type: "web_search_call",
            action: {
              query: "qwen stream docs",
              sources: [
                { type: "url", url: "https://docs.qwencloud.com/api-reference/chat/openai-responses" },
              ],
            },
          },
        },
        { type: "response.output_text.delta", delta: "found" },
        {
          type: "response.completed",
          response: {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "found" }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
          },
        },
      ]),
    );

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    const response = await provider.sendMessage(
      [{ role: "user", content: "find qwen stream docs" } as any],
      [WEB_SEARCH_TOOL],
    );

    expect(response.text).toBe("found");
    expect(response.citations).toEqual([
      {
        url: "https://docs.qwencloud.com/api-reference/chat/openai-responses",
        title: "",
        citedText: "qwen stream docs",
      },
    ]);
  });
});
