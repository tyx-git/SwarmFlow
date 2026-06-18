import { describe, expect, it, mock, spyOn } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "openai-responses-test",
    provider: "openai",
    model: "gpt-5.2",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
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

async function* streamOf(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const event of events) {
    yield event;
  }
}

async function captureCreateCall(
  overrides?: Partial<ModelConfig>,
  messages: Array<Record<string, unknown>> = [{ role: "user", content: "hi" }],
  options?: Record<string, unknown>,
): Promise<{
  body: Record<string, unknown>;
  requestOptions: Record<string, unknown> | undefined;
}> {
  const provider = new OpenAIResponsesProvider(modelConfig(overrides));
  const finalResponse = {
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
  const create = mock(async () => ({
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
    },
  }));

  create.mockImplementation(async (params: Record<string, unknown>) => {
    if (params["stream"]) {
      return streamOf([
        { type: "response.completed", response: finalResponse },
      ]);
    }
    return finalResponse;
  });

  (provider as any)._client = {
    responses: {
      create,
    },
  };

  await provider.sendMessage(messages as any, undefined, options as any);
  return {
    body: (create.mock.calls[0]?.[0] as Record<string, unknown>) ?? {},
    requestOptions: create.mock.calls[0]?.[1] as Record<string, unknown> | undefined,
  };
}

async function captureRequestKwargs(model: string): Promise<Record<string, unknown>> {
  const { body } = await captureCreateCall({ model });
  return body;
}

describe("OpenAIResponsesProvider temperature support", () => {
  it.each([
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
  ])("omits temperature for %s", async (model) => {
    const kwargs = await captureRequestKwargs(model);
    expect(kwargs["temperature"]).toBeUndefined();
  });

  it("keeps temperature for non-gpt5 models", async () => {
    const kwargs = await captureRequestKwargs("custom-non-gpt5-model");
    expect(kwargs["temperature"]).toBe(0.7);
  });
});

describe("OpenAIResponsesProvider openai-codex request shaping", () => {
  it("forwards prompt cache key through codex headers and include", async () => {
    const { body, requestOptions } = await captureCreateCall(
      {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        extra: { store: false, include: ["foo"] },
      },
      [{ role: "user", content: "hi" }],
      { promptCacheKey: "session-123" },
    );

    expect(body["prompt_cache_key"]).toBe("session-123");
    expect(body["include"]).toEqual(["foo", "reasoning.encrypted_content"]);
    expect(body["store"]).toBe(false);
    const headers = requestOptions?.["headers"] as Record<string, string>;
    // Honest identity that mirrors the official Codex CLI wire contract shape.
    expect(headers["originator"]).toBe("swarmflow");
    expect(headers["User-Agent"]).toMatch(/^swarmflow\/[^ ]+ \(.+; .+\)$/);
    // The CLI sends session_id but no conversation_id and no version header.
    expect(headers["session_id"]).toBe("session-123");
    expect(headers["conversation_id"]).toBeUndefined();
    expect(headers["version"]).toBeUndefined();
    // test-key is not a JWT, so no account id can be derived
    expect(headers["ChatGPT-Account-Id"]).toBeUndefined();
  });

  it("strips fields the Codex backend never sends even when leaked via extra", async () => {
    const { body } = await captureCreateCall(
      {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        extra: {
          temperature: 0.5,
          top_p: 0.9,
          max_output_tokens: 4096,
          metadata: { foo: "bar" },
          prompt_cache_retention: "24h",
        },
      },
      [{ role: "user", content: "hi" }],
      { promptCacheKey: "session-123" },
    );

    expect(body["temperature"]).toBeUndefined();
    expect(body["top_p"]).toBeUndefined();
    expect(body["max_output_tokens"]).toBeUndefined();
    expect(body["metadata"]).toBeUndefined();
    expect(body["prompt_cache_retention"]).toBeUndefined();
    // Legitimate codex fields are preserved.
    expect(body["prompt_cache_key"]).toBe("session-123");
    expect(body["store"]).toBe(false);
  });

  it("derives ChatGPT-Account-Id from the codex OAuth JWT when apiKey is a token", async () => {
    const claims = {
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-xyz-123" },
      exp: 9999999999,
    };
    const fakeJwt = "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
    const { requestOptions } = await captureCreateCall(
      { provider: "openai-codex", model: "gpt-5.4-mini", apiKey: fakeJwt },
      [{ role: "user", content: "hi" }],
    );
    const headers = requestOptions?.["headers"] as Record<string, string>;
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-xyz-123");
    expect(headers["originator"]).toBe("swarmflow");
  });

  it("openai is stateless (include + store:false) but gets no codex affinity headers", async () => {
    const { body, requestOptions } = await captureCreateCall(
      {
        provider: "openai",
        model: "gpt-5.2",
      },
      [{ role: "user", content: "hi" }],
      { promptCacheKey: "session-123" },
    );

    expect(body["prompt_cache_key"]).toBe("session-123");
    // openai is now a client-managed stateless backend: request encrypted reasoning
    // and force store=false so we replay the chain of thought ourselves.
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["store"]).toBe(false);
    // Codex affinity headers (session_id) remain codex-only.
    expect(requestOptions?.["headers"]).toBeUndefined();
  });

  it("copilot provider also gets reasoning.encrypted_content include and sanitized round-trip", async () => {
    const reasoningState = [
      {
        type: "reasoning",
        id: "rs_abc",
        summary: [{ type: "summary_text", text: "thinking" }],
        encrypted_content: "copilot-enc",
      },
    ];

    const { body, requestOptions } = await captureCreateCall(
      {
        provider: "copilot",
        model: "gpt-5.4",
        extra: { store: false },
      },
      [
        { role: "assistant", content: "", _reasoning_state: reasoningState },
        { role: "user", content: "hi" },
      ],
      { promptCacheKey: "copilot-session-1" },
    );

    // Must get the stateless-backend `include` field
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    // Must sanitize reasoning items (strip id, keep type/summary/encrypted_content)
    const input = body["input"] as Array<Record<string, unknown>>;
    const reasoningItem = input.find((item) => item["type"] === "reasoning");
    expect(reasoningItem).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "copilot-enc",
    });
    // Must NOT get Codex-specific affinity headers (those are chatgpt.com backend only)
    expect(requestOptions?.["headers"]).toBeUndefined();
    // Must NOT extract system to top-level instructions (Copilot accepts developer role)
    expect(body["instructions"]).toBeUndefined();
    // Must NOT set prompt_cache_retention (stateless backend)
    expect(body["prompt_cache_retention"]).toBeUndefined();
  });

  it("sanitizes codex round-trip items before re-injecting them into input", async () => {
    const reasoningState = [
      {
        type: "reasoning",
        id: "rs_123",
        summary: [{ type: "summary_text", text: "thinking" }],
        encrypted_content: "enc-1",
      },
      {
        type: "function_call",
        id: "fc_123",
        call_id: "call_123",
        name: "grep",
        arguments: "{\"pattern\":\"abc\"}",
        status: "completed",
      },
    ];

    const { body } = await captureCreateCall(
      {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        extra: { store: false },
      },
      [
        { role: "assistant", content: "", _reasoning_state: reasoningState },
        { role: "user", content: "hi" },
      ],
      { promptCacheKey: "session-123" },
    );

    const input = body["input"] as Array<Record<string, unknown>>;
    const reasoningItem = input.find((item) => item["type"] === "reasoning");
    const functionCallItem = input.find((item) => item["type"] === "function_call");

    expect(reasoningItem).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "enc-1",
    });
    expect(functionCallItem).toEqual({
      type: "function_call",
      call_id: "call_123",
      name: "grep",
      arguments: "{\"pattern\":\"abc\"}",
    });
  });
});

describe("OpenAIResponsesProvider streamed tool-call lifecycle", () => {
  it("emits tool-call close on output_item.done before final response parsing", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));
    const events: string[] = [];
    const closedCalls: Array<{ id: string; arguments: Record<string, unknown> }> = [];

    const finalResponse = {
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "write_file",
          arguments: "{\"path\":\"a.txt\",\"content\":\"hello\"}",
        },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
      },
    };

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            {
              type: "response.output_item.added",
              item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "write_file",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              delta: "{\"path\":\"a.txt\",\"content\":\"hello\"}",
            },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "write_file",
                arguments: "{\"path\":\"a.txt\",\"content\":\"hello\"}",
              },
            },
            { type: "response.completed", response: finalResponse },
          ]),
        ),
      },
    };

    const resp = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      {
        onToolCallPartial: (id, name, rawArguments) => {
          events.push(`partial:${id}:${name}:${rawArguments}`);
        },
        onToolCallClosed: (call) => {
          events.push(`close:${call.id}`);
          closedCalls.push({ id: call.id, arguments: call.arguments });
        },
      },
    );

    expect(events).toContain("partial:call_1:write_file:{\"path\":\"a.txt\",\"content\":\"hello\"}");
    expect(events).toContain("close:call_1");
    expect(events.indexOf("close:call_1")).toBeGreaterThan(events.indexOf("partial:call_1:write_file:{\"path\":\"a.txt\",\"content\":\"hello\"}"));
    expect(closedCalls).toEqual([
      {
        id: "call_1",
        arguments: {
          path: "a.txt",
          content: "hello",
        },
      },
    ]);
    expect(resp.toolCalls).toEqual([]);
  });

  it("emits closed streamed tool calls even when the final response omits them", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));
    const closedCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    const finalResponse = {
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: "{\"path\":\"a.txt\"}",
        },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 0 },
      },
    };

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            {
              type: "response.output_item.added",
              item: { type: "function_call", call_id: "call_1", name: "read_file" },
            },
            {
              type: "response.function_call_arguments.delta",
              call_id: "call_1",
              delta: "{\"path\":\"a.txt\"}",
            },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "call_1",
                name: "read_file",
                arguments: "{\"path\":\"a.txt\"}",
              },
            },
            {
              type: "response.output_item.added",
              item: { type: "function_call", call_id: "call_2", name: "bash" },
            },
            {
              type: "response.function_call_arguments.delta",
              call_id: "call_2",
              delta: "{\"command\":\"pwd\"}",
            },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "call_2",
                name: "bash",
                arguments: "{\"command\":\"pwd\"}",
              },
            },
            { type: "response.completed", response: finalResponse },
          ]),
        ),
      },
    };

    const resp = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      {
        onToolCallPartial: () => {},
        onToolCallClosed: (call) => {
          closedCalls.push({ id: call.id, name: call.name, arguments: call.arguments });
        },
      },
    );

    expect(closedCalls).toEqual([
      {
        id: "call_1",
        name: "read_file",
        arguments: { path: "a.txt" },
      },
      {
        id: "call_2",
        name: "bash",
        arguments: { command: "pwd" },
      },
    ]);
    expect(resp.toolCalls).toEqual([]);
  });

  it("does not close earlier function calls when multiple output items are announced before argument deltas", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));
    const events: string[] = [];
    const closedCalls: Array<{ id: string; arguments: Record<string, unknown>; parseError: string | null }> = [];

    const finalResponse = {
      output: [],
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 0 },
      },
    };

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "write_file",
              },
            },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: {
                type: "function_call",
                id: "fc_2",
                call_id: "call_2",
                name: "write_file",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              output_index: 0,
              delta: "{\"path\":\"a.txt\",\"content\":\"alpha\"}",
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "fc_1",
              output_index: 0,
              arguments: "{\"path\":\"a.txt\",\"content\":\"alpha\"}",
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_2",
              output_index: 1,
              delta: "{\"path\":\"b.txt\",\"content\":\"beta\"}",
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "fc_2",
              output_index: 1,
              arguments: "{\"path\":\"b.txt\",\"content\":\"beta\"}",
            },
            { type: "response.completed", response: finalResponse },
          ]),
        ),
      },
    };

    await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      {
        onToolCallPartial: (id, name, rawArguments) => {
          events.push(`partial:${id}:${name}:${rawArguments}`);
        },
        onToolCallClosed: (call) => {
          events.push(`close:${call.id}`);
          closedCalls.push({
            id: call.id,
            arguments: call.arguments,
            parseError: call.parseError,
          });
        },
      },
    );

    const call1PartialIndex = events.indexOf("partial:call_1:write_file:{\"path\":\"a.txt\",\"content\":\"alpha\"}");
    const call1CloseIndex = events.indexOf("close:call_1");
    expect(call1PartialIndex).toBeGreaterThanOrEqual(0);
    expect(call1CloseIndex).toBeGreaterThan(call1PartialIndex);
    expect(events.filter((event) => event === "close:call_1")).toHaveLength(1);
    expect(events.filter((event) => event === "close:call_2")).toHaveLength(1);
    expect(closedCalls).toEqual([
      {
        id: "call_1",
        arguments: { path: "a.txt", content: "alpha" },
        parseError: null,
      },
      {
        id: "call_2",
        arguments: { path: "b.txt", content: "beta" },
        parseError: null,
      },
    ]);
  });

  it("falls back to streamed text when the final response omits message content", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5.2" }));

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            { type: "response.output_text.delta", delta: "review" },
            { type: "response.output_text.delta", delta: " complete" },
            {
              type: "response.completed",
              response: {
                output: [],
                usage: {
                  input_tokens: 2,
                  output_tokens: 2,
                  input_tokens_details: { cached_tokens: 0 },
                },
              },
            },
          ]),
        ),
      },
    };

    const resp = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {} },
    );

    expect(resp.text).toBe("review complete");
  });
});

describe("OpenAIResponsesProvider streamed reasoning capture", () => {
  it("captures encrypted reasoning from output_item.done when completed.output is empty (codex)", async () => {
    const provider = new OpenAIResponsesProvider(
      modelConfig({ provider: "openai-codex", model: "gpt-5.4" }),
    );

    (provider as any)._client = {
      responses: {
        create: mock(async () =>
          streamOf([
            {
              type: "response.output_item.added",
              item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC_PARTIAL" },
            },
            {
              type: "response.reasoning_summary_text.delta",
              item_id: "rs_1",
              summary_index: 0,
              delta: "Let me think.",
            },
            {
              type: "response.output_item.done",
              item: {
                type: "reasoning",
                id: "rs_1",
                summary: [{ type: "summary_text", text: "Let me think." }],
                encrypted_content: "ENC_FINAL",
              },
            },
            {
              type: "response.output_item.added",
              item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_dir" },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              delta: "{\"path\":\".\"}",
            },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "list_dir",
                arguments: "{\"path\":\".\"}",
              },
            },
            // Codex backend returns an EMPTY completed.output — reasoning is only
            // observable via the output_item.done events above.
            {
              type: "response.completed",
              response: {
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
              },
            },
          ]),
        ),
      },
    };

    const closed: string[] = [];
    const resp = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onToolCallClosed: (c) => closed.push(c.id) },
    );

    // Summary text captured from reasoning_summary_text.delta
    expect(resp.reasoningContent).toContain("Let me think.");

    // Encrypted reasoning captured into the sealed payload, using the FINAL
    // encrypted_content from output_item.done (not the partial from .added).
    const artifact = resp.thinkingArtifact as {
      encryption: string;
      sealedPayload: Array<Record<string, unknown>>;
    } | null;
    expect(artifact?.encryption).toBe("openai");
    expect(artifact?.sealedPayload).toEqual([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Let me think." }], encrypted_content: "ENC_FINAL" },
    ]);
    // Reasoning-only: the function_call is replayed via tool_calls, not bundled here.
    expect(artifact?.sealedPayload.some((i) => i["type"] === "function_call")).toBe(false);

    // Tool call still surfaced through the streaming callback.
    expect(closed).toEqual(["call_1"]);
    expect(resp.toolCalls).toEqual([]);
  });
});
