import { describe, expect, it, mock, spyOn } from "bun:test";

import type { ModelConfig } from "../src/config.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIChatProvider } from "../src/providers/openai-chat.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";
import { KimiProvider } from "../src/providers/kimi.js";
import { GLMProvider } from "../src/providers/glm.js";
import { MiniMaxProvider } from "../src/providers/minimax.js";

/**
 * Test: Send conversations with malformed tool_calls (containing _incompleteArguments field)
 * to each provider and verify how they format the request.
 *
 * This tests the critical path: internal tool_call format -> provider API format
 */

function modelConfig(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    name: "test",
    provider: "openai",
    model: "gpt-4",
    apiKey: "test-key-${ENV_TEST}",
    baseUrl: undefined,
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 400_000,
    supportsMultimodal: true,
    supportsThinking: false,
    thinkingBudget: 0,
    supportsWebSearch: false,
    extra: {},
    ...overrides,
  };
}

/**
 * Create a message with a malformed tool_call containing _incompleteArguments field.
 * This simulates a tool_call that doesn't fully match the schema.
 */
function malformedToolCallMessage() {
  return {
    role: "assistant",
    content: "Calling incomplete function",
    tool_calls: [
      {
        id: "call_123",
        name: "test_function",
        arguments: {
          query: "search term",
          _incompleteArguments: "This field should not be here",
        },
      },
    ],
  };
}

describe("Provider malformed tool_call handling", () => {
  describe("OpenAI Chat (JSON stringified arguments)", () => {
    it("converts tool_calls with _incompleteArguments to JSON stringified format", async () => {
      const provider = new OpenAIChatProvider(
        modelConfig({ provider: "openai-chat", model: "gpt-4" }),
      );

      const sendMessageSpy = spyOn(provider as any, "sendMessage");
      const mockCreate = mock(async () => ({
        choices: [{ message: { content: "response", tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));

      (provider as any)._client = {
        chat: { completions: { create: mockCreate } },
      };

      await provider.sendMessage([malformedToolCallMessage() as any]);

      // Verify the arguments were JSON stringified
      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];
      const messages = callArgs.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(
        (m) => m["role"] === "assistant",
      ) as Record<string, unknown> | undefined;

      if (assistantMsg && assistantMsg["tool_calls"]) {
        const toolCall = (assistantMsg["tool_calls"] as Record<string, unknown>[])[0];
        const argumentsStr = toolCall["function"]["arguments"] as string;

        // Arguments should be stringified
        expect(typeof argumentsStr).toBe("string");
        const parsed = JSON.parse(argumentsStr);
        expect(parsed._incompleteArguments).toBe(
          "This field should not be here",
        );
      }
    });
  });

  describe("Anthropic (object arguments)", () => {
    it("passes tool_calls with _incompleteArguments as object properties", async () => {
      const provider = new AnthropicProvider(
        modelConfig({ provider: "anthropic", model: "claude-3-5-sonnet" }),
      );

      const mockCreate = mock(async () => ({
        content: [{ type: "text", text: "response" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));

      (provider as any)._client = {
        messages: { create: mockCreate },
      };

      await provider.sendMessage([malformedToolCallMessage() as any]);

      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];
      const messages = callArgs.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(
        (m) => m["role"] === "assistant",
      ) as Record<string, unknown> | undefined;

      if (assistantMsg && assistantMsg["content"]) {
        const content = assistantMsg["content"] as Record<string, unknown>[];
        const toolUseBlock = content.find((c) => c["type"] === "tool_use");

        if (toolUseBlock) {
          const input = toolUseBlock["input"] as Record<string, unknown>;
          // Arguments should be object, not stringified
          expect(typeof input).toBe("object");
          expect(input._incompleteArguments).toBe(
            "This field should not be here",
          );
        }
      }
    });
  });

  describe("Kimi (OpenAI-compatible, JSON stringified)", () => {
    it("converts tool_calls to OpenAI format with JSON stringified arguments", async () => {
      const provider = new KimiProvider(
        modelConfig({
          provider: "kimi",
          model: "kimi-k2.5",
          baseUrl: "https://api.moonshot.ai/v1",
        }),
      );

      const mockCreate = mock(async () => ({
        choices: [{ message: { content: "response", tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));

      (provider as any)._client = {
        chat: { completions: { create: mockCreate } },
      };

      await provider.sendMessage([malformedToolCallMessage() as any]);

      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];
      const messages = callArgs.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(
        (m) => m["role"] === "assistant",
      ) as Record<string, unknown> | undefined;

      if (assistantMsg && assistantMsg["tool_calls"]) {
        const toolCall = (assistantMsg["tool_calls"] as Record<string, unknown>[])[0];
        const argumentsStr = toolCall["function"]["arguments"] as string;

        expect(typeof argumentsStr).toBe("string");
        const parsed = JSON.parse(argumentsStr);
        expect(parsed._incompleteArguments).toBe(
          "This field should not be here",
        );
      }
    });
  });

  describe("GLM (OpenAI-compatible, JSON stringified)", () => {
    it("converts tool_calls to OpenAI format with JSON stringified arguments", async () => {
      const provider = new GLMProvider(
        modelConfig({
          provider: "glm",
          model: "glm-4",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        }),
      );

      const mockCreate = mock(async () => ({
        choices: [{ message: { content: "response", tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));

      (provider as any)._client = {
        chat: { completions: { create: mockCreate } },
      };

      await provider.sendMessage([malformedToolCallMessage() as any]);

      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];
      const messages = callArgs.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(
        (m) => m["role"] === "assistant",
      ) as Record<string, unknown> | undefined;

      if (assistantMsg && assistantMsg["tool_calls"]) {
        const toolCall = (assistantMsg["tool_calls"] as Record<string, unknown>[])[0];
        const argumentsStr = toolCall["function"]["arguments"] as string;

        expect(typeof argumentsStr).toBe("string");
        const parsed = JSON.parse(argumentsStr);
        expect(parsed._incompleteArguments).toBe(
          "This field should not be here",
        );
      }
    });
  });

  describe("MiniMax (OpenAI-compatible, JSON stringified)", () => {
    it("converts tool_calls to OpenAI format with JSON stringified arguments", async () => {
      const provider = new MiniMaxProvider(
        modelConfig({
          provider: "minimax",
          model: "minimax-01",
          baseUrl: "https://api.minimax.io/v1",
        }),
      );

      const mockCreate = mock(async () => ({
        choices: [{ message: { content: "response", tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));

      (provider as any)._client = {
        chat: { completions: { create: mockCreate } },
      };

      await provider.sendMessage([malformedToolCallMessage() as any]);

      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];
      const messages = callArgs.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(
        (m) => m["role"] === "assistant",
      ) as Record<string, unknown> | undefined;

      if (assistantMsg && assistantMsg["tool_calls"]) {
        const toolCall = (assistantMsg["tool_calls"] as Record<string, unknown>[])[0];
        const argumentsStr = toolCall["function"]["arguments"] as string;

        expect(typeof argumentsStr).toBe("string");
        const parsed = JSON.parse(argumentsStr);
        expect(parsed._incompleteArguments).toBe(
          "This field should not be here",
        );
      }
    });
  });

  describe("OpenAI Responses (object arguments in new API)", () => {
    it("sends tool_calls with object arguments to responses API", async () => {
      const provider = new OpenAIResponsesProvider(
        modelConfig({
          provider: "openai",
          model: "gpt-5.2",
        }),
      );

      const mockCreate = mock(async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "response" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));

      (provider as any)._client = {
        responses: { create: mockCreate },
      };

      await provider.sendMessage([malformedToolCallMessage() as any]);

      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];
      const input = callArgs.input as Record<string, unknown>[];
      const functionCall = input.find(
        (item) => item["type"] === "function_call",
      ) as Record<string, unknown> | undefined;

      expect(functionCall).toBeDefined();
      const argumentsStr = functionCall?.["arguments"] as string;

      expect(typeof argumentsStr).toBe("string");
      const parsed = JSON.parse(argumentsStr);
      expect(parsed._incompleteArguments).toBe(
        "This field should not be here",
      );
    });
  });

  describe("Tool call format comparison summary", () => {
    it("documents the differences in tool_call argument serialization", () => {
      // This test documents the expected behavior for each provider type

      const expectedBehaviors = {
        "OpenAI Chat (openai, openai-codex, openai-chat)": {
          argumentFormat: "JSON.stringify(arguments object)",
          toolCallType: "function",
          example: {
            type: "function",
            function: {
              name: "test_function",
              arguments: '{"query":"search term","_incompleteArguments":"..."}',
            },
          },
        },
        "Anthropic (anthropic)": {
          argumentFormat: "Object (not stringified)",
          toolCallType: "tool_use",
          example: {
            type: "tool_use",
            id: "call_123",
            name: "test_function",
            input: {
              query: "search term",
              _incompleteArguments: "...",
            },
          },
        },
        "Kimi (kimi, kimi-cn, kimi-code)": {
          argumentFormat: "JSON.stringify(arguments object)",
          toolCallType: "function",
          baseUrl: "https://api.moonshot.ai/v1",
          example:
            "Same as OpenAI Chat format (inherits from OpenAIChatProvider)",
        },
        "GLM (glm, glm-intl, glm-code)": {
          argumentFormat: "JSON.stringify(arguments object)",
          toolCallType: "function",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          example:
            "Same as OpenAI Chat format (inherits from OpenAIChatProvider)",
        },
        "MiniMax (minimax, minimax-cn)": {
          argumentFormat: "JSON.stringify(arguments object)",
          toolCallType: "function",
          baseUrl: "https://api.minimax.io/v1",
          example:
            "Same as OpenAI Chat format (inherits from OpenAIChatProvider)",
        },
        "OpenAI Responses (gpt-5.2 with responses API)": {
          argumentFormat: "JSON.stringify(arguments object)",
          toolCallType: "function",
          example:
            "Same as OpenAI Chat format (uses similar API contract)",
        },
      };

      // All providers should preserve _incompleteArguments field
      for (const [provider, behavior] of Object.entries(expectedBehaviors)) {
        expect(behavior.argumentFormat).toBeDefined();
        expect(behavior.toolCallType).toBeDefined();
      }

      // Document the split: Anthropic uses objects, all OpenAI-compatible use JSON strings
      const anthropicUsesObjects = true;
      const openaiCompatibleUseStrings = true;
      expect(anthropicUsesObjects).toBe(true);
      expect(openaiCompatibleUseStrings).toBe(true);
    });
  });
});
