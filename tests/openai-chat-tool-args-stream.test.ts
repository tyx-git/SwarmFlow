import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../src/config/config.js";
import type { ToolCall } from "../src/providers/base.js";
import { OpenAIChatProvider } from "../src/providers/openai-chat.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "openai-chat-test",
    provider: "openai",
    model: "gpt-5.2",
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 400_000,
    supportsMultimodal: false,
    supportsThinking: false,
    thinkingBudget: 0,
    supportsWebSearch: false,
    extra: {},
    ...overrides,
  };
}

function streamFrom(chunks: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function buildToolCallChunks(argChunks: string[]): Array<Record<string, unknown>> {
  return argChunks.map((arg, i) => {
    const tc = i === 0
      ? {
          index: 0,
          id: "call_1",
          function: {
            name: "write_file",
            arguments: arg,
          },
        }
      : {
          index: 0,
          function: {
            arguments: arg,
          },
        };
    return {
      choices: [
        {
          delta: {
            tool_calls: [tc],
          },
        },
      ],
    };
  });
}

async function runStreamToolCall(
  argChunks: string[],
  mode?: "legacy" | "auto",
): Promise<ToolCall | null> {
  const prev = process.env["SWARMFLOW_TOOL_ARGS_MODE"];
  if (mode) {
    process.env["SWARMFLOW_TOOL_ARGS_MODE"] = mode;
  } else {
    delete process.env["SWARMFLOW_TOOL_ARGS_MODE"];
  }

  try {
    const provider = new OpenAIChatProvider(modelConfig());
    const create = vi.fn(async (kwargs: Record<string, unknown>) => {
      if (kwargs["stream"] === true) {
        return streamFrom(buildToolCallChunks(argChunks));
      }
      return {
        choices: [{ message: { content: "", tool_calls: [] } }],
      };
    });

    (provider as unknown as { _client: unknown })._client = {
      chat: { completions: { create } },
    };

    let closedCall: ToolCall | null = null;
    const response = await provider.sendMessage(
      [{ role: "user", content: "hello" }],
      undefined,
      {
        onTextChunk: () => {},
        onToolCallClosed: (call) => {
          closedCall = call;
        },
      },
    );

    expect(response.toolCalls).toEqual([]);
    return closedCall;
  } finally {
    if (prev === undefined) {
      delete process.env["SWARMFLOW_TOOL_ARGS_MODE"];
    } else {
      process.env["SWARMFLOW_TOOL_ARGS_MODE"] = prev;
    }
  }
}

describe("OpenAIChatProvider streamed tool arguments", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses incremental tool argument chunks", async () => {
    const call = await runStreamToolCall([
      "{\"path\":\"report.md\",",
      "\"content\":\"hello\"}",
    ]);

    expect(call?.arguments).toEqual({
      path: "report.md",
      content: "hello",
    });
  });

  it("parses cumulative tool argument chunks in auto mode", async () => {
    const call = await runStreamToolCall([
      "{\"path\":\"report.md\"",
      "{\"path\":\"report.md\",\"content\":\"hello\"}",
    ]);

    expect(call?.arguments).toEqual({
      path: "report.md",
      content: "hello",
    });
  });

  it("parses mixed incremental + cumulative chunks in auto mode", async () => {
    const call = await runStreamToolCall([
      "{\"path\":\"report.md\",",
      "\"content\":\"he\"",
      "{\"path\":\"report.md\",\"content\":\"hello\"}",
    ]);

    expect(call?.arguments).toEqual({
      path: "report.md",
      content: "hello",
    });
  });

  it("returns _parseError for invalid JSON instead of silent empty object", async () => {
    const call = await runStreamToolCall([
      "{\"path\":\"report.md\"",
    ]);

    expect(call?.parseError).toContain("Failed to parse");
    expect(call?.arguments).toEqual({});
  });

  it("returns _parseError in legacy mode when cumulative chunks are unparsable", async () => {
    const call = await runStreamToolCall(
      [
        "{\"path\":\"report.md\"",
        "{\"path\":\"report.md\",\"content\":\"hello\"}",
      ],
      "legacy",
    );

    expect(call?.parseError).toContain("Failed to parse");
    expect(call?.arguments).toEqual({});
  });

  it("supports explicit auto mode for cumulative chunks", async () => {
    const call = await runStreamToolCall(
      [
        "{\"path\":\"report.md\"",
        "{\"path\":\"report.md\",\"content\":\"hello\"}",
      ],
      "auto",
    );

    expect(call?.arguments).toEqual({
      path: "report.md",
      content: "hello",
    });
  });

  it("closes a streamed tool call when the next tool call entry begins", async () => {
    const provider = new OpenAIChatProvider(modelConfig());
    const events: string[] = [];

    const create = vi.fn(async (kwargs: Record<string, unknown>) => {
      if (kwargs["stream"] === true) {
        return streamFrom([
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_1",
                  function: {
                    name: "write_file",
                    arguments: "{\"path\":\"a.txt\",\"content\":\"one\"}",
                  },
                }],
              },
            }],
          },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 1,
                  id: "call_2",
                  function: {
                    name: "write_file",
                    arguments: "{\"path\":\"b.txt\",\"content\":\"two\"}",
                  },
                }],
              },
            }],
          },
        ]);
      }
      return {
        choices: [{ message: { content: "", tool_calls: [] } }],
      };
    });

    (provider as unknown as { _client: unknown })._client = {
      chat: { completions: { create } },
    };

    await provider.sendMessage(
      [{ role: "user", content: "hello" }],
      undefined,
      {
        onToolCallPartial: (id, name) => events.push(`partial:${id}:${name}`),
        onToolCallClosed: (call) => events.push(`close:${call.id}`),
      },
    );

    expect(events).toContain("close:call_1");
    expect(events.indexOf("close:call_1")).toBeLessThan(events.indexOf("partial:call_2:write_file"));
  });

  it("closes a streamed tool call before switching back to text output", async () => {
    const provider = new OpenAIChatProvider(modelConfig());
    const events: string[] = [];

    const create = vi.fn(async (kwargs: Record<string, unknown>) => {
      if (kwargs["stream"] === true) {
        return streamFrom([
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_1",
                  function: {
                    name: "write_file",
                    arguments: "{\"path\":\"a.txt\",\"content\":\"one\"}",
                  },
                }],
              },
            }],
          },
          {
            choices: [{
              delta: {
                content: "Done.",
              },
            }],
          },
        ]);
      }
      return {
        choices: [{ message: { content: "", tool_calls: [] } }],
      };
    });

    (provider as unknown as { _client: unknown })._client = {
      chat: { completions: { create } },
    };

    await provider.sendMessage(
      [{ role: "user", content: "hello" }],
      undefined,
      {
        onToolCallPartial: (id, name) => events.push(`partial:${id}:${name}`),
        onToolCallClosed: (call) => events.push(`close:${call.id}`),
        onTextChunk: (chunk) => events.push(`text:${chunk}`),
      },
    );

    expect(events).toContain("close:call_1");
    expect(events.indexOf("close:call_1")).toBeLessThan(events.indexOf("text:Done."));
  });
});
