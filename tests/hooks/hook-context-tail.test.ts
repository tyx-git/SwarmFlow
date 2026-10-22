import { describe, expect, it } from "vitest";

import { createAssistantText, createSystemPrompt, createUserMessage } from "../../src/context/entry/factories.js";
import { projectToApiMessages } from "../../src/context/projection/api.js";
import type { HookManifest } from "../../src/hooks/types.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import type { ModelConfig } from "../../src/config/types.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

function anthropicConfig(): ModelConfig {
  return {
    name: "claude-test",
    provider: "anthropic",
    model: "claude-opus-4-7",
    apiKey: "test-key",
    baseUrl: "https://api.anthropic.com",
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 1_000_000,
    supportsMultimodal: true,
    thinkingBudget: 0,
    supportsWebSearch: false,
    transportProtocol: "anthropic",
    thinkingEncryption: "anthropic",
    sealedSchema: "anthropic-messages",
    extra: {},
  };
}

function sessionStartHook(): HookManifest {
  return {
    name: "session-start",
    event: "SessionStart",
    type: "command",
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({ additionalContext: 'SESSION-CTX' }))",
    ],
  };
}

describe("ephemeral context tail", () => {
  it("appends the tail after role normalization and marks it", () => {
    const entries = [
      createSystemPrompt("s1", "SYSTEM"),
      createUserMessage("u1", 0, "hello", "hello", "c1"),
      createAssistantText("a1", 0, 0, "ok", "ok", "c2"),
      createUserMessage("u2", 1, "again", "again", "c3"),
    ];

    const messages = projectToApiMessages(entries, {
      systemPrompt: "SYSTEM",
      requiresAlternatingRoles: true,
      ephemeralTail: "[TURN HOOK CONTEXT]\nTAIL-CTX",
    });

    const last = messages[messages.length - 1];
    expect(last["role"]).toBe("user");
    expect(last["_ephemeral_tail"]).toBe(true);
    expect(last["content"]).toContain("TAIL-CTX");
    // 前一条持久化 user 消息没有被尾巴合并。
    expect(messages[messages.length - 2]["content"]).toBe("again");
  });

  it("never places the Anthropic cache breakpoint on the ephemeral tail", () => {
    const provider = new AnthropicProvider(anthropicConfig());
    const kwargs: Record<string, unknown> = {
      system: "SYSTEM",
      messages: [
        { role: "user", content: "HISTORY" },
        { role: "user", content: "TAIL", _ephemeral_tail: true },
      ],
    };

    (provider as unknown as { _applyCacheBreakpoint: (k: Record<string, unknown>) => void })
      ._applyCacheBreakpoint(kwargs);

    const messages = kwargs["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]["content"]).toEqual([
      { type: "text", text: "HISTORY", cache_control: { type: "ephemeral" } },
    ]);
    expect(messages[1]["content"]).toBe("TAIL");
  });

  it("defers SessionStart hooks to the first turn and puts their context in the tail", async () => {
    const harness = makeScriptedSession({
      rounds: [{ text: "ok" }],
      hooks: [sessionStartHook()],
    });
    try {
      // 构造阶段不执行 SessionStart，也不阻塞进程启动。
      expect(harness.provider.callCount).toBe(0);
      expect(harness.session.hookRuntime.getAdditionalContext()).toBeNull();

      await harness.session.turn("hello");

      const firstCall = harness.provider.calls[0] ?? [];
      const tail = firstCall[firstCall.length - 1];
      expect(tail["_ephemeral_tail"]).toBe(true);
      expect(tail["content"]).toContain("[SESSION HOOK CONTEXT]");
      expect(tail["content"]).toContain("SESSION-CTX");

      // session 作用域在会话内保留，直到 /new 或恢复重置。
      expect(harness.session.hookRuntime.getAdditionalContext()).toContain("SESSION-CTX");
      harness.internals._resetHookContextForNewSession();
      expect(harness.session.hookRuntime.getAdditionalContext()).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("clears next-round hook context after the provider response", async () => {
    const harness = makeScriptedSession({ rounds: [{ text: "ok" }] });
    try {
      (harness.session.hookRuntime as unknown as { _nextRoundContext: string[] })
        ._nextRoundContext.push("NEXT-CTX");

      await harness.session.turn("hello");

      const firstCall = harness.provider.calls[0] ?? [];
      const tail = firstCall[firstCall.length - 1];
      expect(tail["content"]).toContain("[NEXT ROUND HOOK CONTEXT]");
      expect(tail["content"]).toContain("NEXT-CTX");

      // 已随本次请求发送，不能在后续轮次重复累积。
      expect(harness.session.hookRuntime.getAdditionalContext()).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("does not duplicate PostToolUse observation context into the model tail", () => {
    const harness = makeScriptedSession();
    try {
      const runtime = harness.session.hookRuntime as unknown as {
        _accumulateContext: (event: string, context: string) => void;
        getAdditionalContext: () => string | null;
      };
      runtime._accumulateContext("PostToolUse", "OBSERVED");
      expect(runtime.getAdditionalContext()).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});
