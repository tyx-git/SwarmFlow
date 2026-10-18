import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createLogSessionMeta,
  loadLog,
  saveLog,
} from "../src/config/persistence.js";
import { LogIdAllocator } from "../src/context/log-entry.js";
import { childPromptCacheKey } from "../src/session/child-session-manager.js";
import { forkSessionDirectory } from "../src/server/session-rpc.js";
import { OpenAIChatProvider } from "../src/providers/openai-chat.js";
import type { ModelConfig } from "../src/config/config.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function chatConfig(): ModelConfig {
  return {
    name: "chat-test",
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    temperature: 0.7,
    maxTokens: 128,
    contextLength: 8192,
    supportsMultimodal: false,
    supportsWebSearch: false,
    thinkingBudget: 0,
    extra: {},
  };
}

describe("prompt cache affinity key", () => {
  it("persists the key in log.json and reads it back", () => {
    const dir = makeTempDir("swarmflow-affinity-log-");
    try {
      saveLog(
        dir,
        createLogSessionMeta({
          sessionId: "session-1",
          promptCacheAffinityKey: "affinity-1",
        }),
        [],
      );

      const raw = JSON.parse(readFileSync(join(dir, "log.json"), "utf-8"));
      expect(raw.prompt_cache_affinity_key).toBe("affinity-1");
      expect(loadLog(dir).meta.promptCacheAffinityKey).toBe("affinity-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the live session key into its persistence payload", () => {
    const harness = makeScriptedSession();
    try {
      const key = harness.internals._promptCacheKey as string;
      expect(key).toBeTruthy();
      expect(harness.session.getLogForPersistence().meta.promptCacheAffinityKey).toBe(key);
    } finally {
      harness.dispose();
    }
  });

  it("restores the persisted key on resume", () => {
    const harness = makeScriptedSession();
    try {
      const payload = harness.session.getLogForPersistence();
      payload.meta.promptCacheAffinityKey = "persisted-key";
      const allocator = new LogIdAllocator();
      allocator.restoreFrom(payload.entries);

      harness.session.restoreFromLog(payload.meta, [...payload.entries], allocator);

      expect(harness.internals._promptCacheKey).toBe("persisted-key");
      expect(harness.session.getLogForPersistence().meta.promptCacheAffinityKey).toBe("persisted-key");
    } finally {
      harness.dispose();
    }
  });

  it("isolates fork keys by default and inherits only when requested", () => {
    const parent = makeTempDir("swarmflow-affinity-fork-");
    const dir = join(parent, "source");
    try {
      mkdirSync(dir, { recursive: true });
      saveLog(
        dir,
        createLogSessionMeta({
          sessionId: "source",
          promptCacheAffinityKey: "parent-key",
        }),
        [],
      );

      // 默认路由隔离：适合长期并行开发。
      const isolated = forkSessionDirectory(dir);
      const isolatedLog = JSON.parse(readFileSync(join(isolated.sessionDir, "log.json"), "utf-8"));
      expect(isolatedLog.prompt_cache_affinity_key).toBeTruthy();
      expect(isolatedLog.prompt_cache_affinity_key).not.toBe("parent-key");

      // 显式继承：适合轻量级探索/短期实验。
      const inherited = forkSessionDirectory(dir, { inheritPromptCacheKey: true });
      const inheritedLog = JSON.parse(readFileSync(join(inherited.sessionDir, "log.json"), "utf-8"));
      expect(inheritedLog.prompt_cache_affinity_key).toBe("parent-key");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("derives child keys from the root key and child id", () => {
    expect(childPromptCacheKey("root-key", "scout-1")).toBe("root-key__scout-1");
  });

  it("stores the fork inheritance setting on the session", () => {
    const inherited = makeScriptedSession({ forkInheritPromptCacheKey: true });
    const isolated = makeScriptedSession();
    try {
      expect(inherited.session.forkInheritPromptCacheKey).toBe(true);
      expect(isolated.session.forkInheritPromptCacheKey).toBe(false);
    } finally {
      inherited.dispose();
      isolated.dispose();
    }
  });

  it("sends prompt_cache_key on the OpenAI Chat path", async () => {
    const provider = new OpenAIChatProvider(chatConfig());
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "ok", tool_calls: [] } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));
    (provider as unknown as { _client: unknown })._client = {
      chat: { completions: { create } },
    };

    const response = await provider.sendMessage(
      [{ role: "user", content: "hello" }],
      undefined,
      { promptCacheKey: "affinity-chat" },
    );

    expect(response.text).toBe("ok");
    const kwargs = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(kwargs["prompt_cache_key"]).toBe("affinity-chat");
  });
});
