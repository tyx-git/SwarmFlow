import { describe, expect, it, mock } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import { QwenProvider } from "../src/providers/qwen.js";
import type { ToolDef } from "../src/providers/base.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "qwen-test",
    provider: "qwen",
    model: "qwen3.6-plus",
    apiKey: "test-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 1_000_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: true,
    transportProtocol: "chat",
    thinkingEncryption: "none",
    sealedSchema: null,
    extra: {},
    ...overrides,
  };
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

describe("QwenProvider thinking params", () => {
  it("enables thinking and preserve_thinking by default", () => {
    const provider = new QwenProvider(modelConfig());
    const kwargs: Record<string, unknown> = {};

    (provider as any)._applyThinkingParams(kwargs, {});

    expect(kwargs["enable_thinking"]).toBe(true);
    expect(kwargs["preserve_thinking"]).toBe(true);
    expect(kwargs["extra_body"]).toBeUndefined();
  });

  it("adds thinking_budget when configured", () => {
    const provider = new QwenProvider(modelConfig({ thinkingBudget: 80_000 }));
    const kwargs: Record<string, unknown> = {};

    (provider as any)._applyThinkingParams(kwargs, { thinkingLevel: "on" });

    expect(kwargs["enable_thinking"]).toBe(true);
    expect(kwargs["preserve_thinking"]).toBe(true);
    expect(kwargs["thinking_budget"]).toBe(80_000);
  });

  it("disables thinking cleanly for off/none", () => {
    const provider = new QwenProvider(modelConfig({ thinkingBudget: 80_000 }));
    const kwargs: Record<string, unknown> = {
      extra_body: {
        preserve_thinking: true,
        thinking_budget: 80_000,
        other_flag: true,
      },
    };

    (provider as any)._applyThinkingParams(kwargs, { thinkingLevel: "off" });

    expect(kwargs["enable_thinking"]).toBe(false);
    expect(kwargs["preserve_thinking"]).toBeUndefined();
    expect(kwargs["thinking_budget"]).toBeUndefined();
    expect(kwargs["extra_body"]).toEqual({
      other_flag: true,
    });
  });

  it("hoists DashScope fields out of extra_body for Node SDK requests", () => {
    const provider = new QwenProvider(modelConfig());
    const kwargs: Record<string, unknown> = {
      extra_body: {
        enable_thinking: true,
        preserve_thinking: true,
        thinking_budget: 12_345,
        other_flag: true,
      },
    };

    (provider as any)._applyThinkingParams(kwargs, { thinkingLevel: "on" });

    expect(kwargs["enable_thinking"]).toBe(true);
    expect(kwargs["preserve_thinking"]).toBe(true);
    expect(kwargs["thinking_budget"]).toBe(12_345);
    expect(kwargs["extra_body"]).toEqual({
      other_flag: true,
    });
  });
});

describe("QwenProvider request shaping", () => {
  it("translates native web search to enable_search", async () => {
    const provider = new QwenProvider(modelConfig());
    const create = mock(async (params: Record<string, unknown>) => ({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      _params: params,
    }));

    (provider as any)._client = {
      chat: {
        completions: {
          create,
        },
      },
    };

    await provider.sendMessage(
      [{ role: "user", content: "find recent docs" } as any],
      [WEB_SEARCH_TOOL],
      { thinkingLevel: "on" },
    );

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params["web_search_options"]).toBeUndefined();
    expect(params["tools"]).toBeUndefined();
    expect(params["enable_search"]).toBe(true);
    expect(params["enable_thinking"]).toBe(true);
    expect(params["preserve_thinking"]).toBe(true);
    expect(params["extra_body"]).toBeUndefined();
  });

  it("keeps ordinary function tools while adding Qwen thinking flags", async () => {
    const provider = new QwenProvider(modelConfig({ supportsWebSearch: false }));
    const create = mock(async (params: Record<string, unknown>) => ({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      _params: params,
    }));
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
      chat: {
        completions: {
          create,
        },
      },
    };

    await provider.sendMessage(
      [{ role: "user", content: "search repo" } as any],
      [grepTool],
      { thinkingLevel: "off" },
    );

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "grep",
          description: "Search files",
          parameters: grepTool.parameters,
        },
      },
    ]);
    expect(params["enable_thinking"]).toBe(false);
    expect(params["extra_body"]).toBeUndefined();
  });
});
