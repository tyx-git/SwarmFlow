/**
 * 压缩后的 token 记账回归测试（bug：压缩后沿用压缩前的输入大小，导致连续压缩）。
 *
 * 覆盖：
 * - 手动压缩后清零 per-response token 快照（累计用量仍保留）。
 * - 手动压缩后的第一个回合不再触发第二次压缩。
 * - restore 不跨过 compact_marker 回读压缩前的 token_update。
 * - restore 仍能恢复压缩点之后的 token_update。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore, createLogSessionMeta } from "../src/config/persistence.js";
import {
  LogIdAllocator,
  createCompactContext,
  createCompactMarker,
  createSystemPrompt,
  createTokenUpdate,
  type LogEntry,
} from "../src/context/log-entry.js";
import { Usage } from "../src/providers/base.js";
import { Session } from "../src/session.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

function restoreSession(entries: LogEntry[]): { session: Session; dispose: () => void } {
  const baseDir = mkdtempSync(join(tmpdir(), "swarmflow-compact-token-base-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "swarmflow-compact-token-project-"));
  const store = new SessionStore({ baseDir, projectPath: projectRoot });
  store.createSession();

  const modelConfig = {
    name: "test-model",
    provider: "openai",
    model: "gpt-5.2",
    apiKey: "sk-test",
    maxTokens: 256,
    contextLength: 8192,
    supportsMultimodal: false,
  };
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "Primary system prompt.",
    tools: [],
    modelConfig,
    _provider: { budgetCalcMode: "full_context" },
    replaceModelConfig(next: unknown) {
      (this as { modelConfig?: unknown }).modelConfig = next;
    },
  };
  const config = {
    pathOverrides: { projectRoot },
    mcpServerConfigs: [],
    getModel: () => ({ ...modelConfig }),
  };
  const session = new Session({ primaryAgent, config, store, projectRoot } as never);

  const allocator = new LogIdAllocator();
  allocator.restoreFrom(entries);
  session.restoreFromLog?.(
    createLogSessionMeta({
      sessionId: "s1",
      projectPath: projectRoot,
      modelConfigName: "test-model",
      turnCount: 1,
      compactCount: 1,
    }),
    entries,
    allocator,
  );

  return {
    session,
    dispose: () => {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

describe("compact token accounting", () => {
  it("resets per-response input tokens after manual compact while keeping cumulative usage", async () => {
    const h = makeScriptedSession({
      rounds: [{ text: "continuation summary text", usage: new Usage(7000, 5) }],
    });
    try {
      h.internals._lastInputTokens = 7000;
      h.internals._lastTotalTokens = 7500;

      await h.session.runManualCompact();

      expect(h.session.lastInputTokens).toBe(0);
      expect(h.session.lastTotalTokens).toBe(0);
      expect(h.internals._computeUsageStats().cumulativeInput).toBeGreaterThanOrEqual(7000);
    } finally {
      h.dispose();
    }
  });

  it("does not compact again on the first turn after manual compact", async () => {
    const h = makeScriptedSession({
      rounds: [
        { text: "continuation summary text", usage: new Usage(7000, 5) },
        { text: "unexpected second compact", usage: new Usage(100, 5) },
        { text: "final answer", usage: new Usage(100, 5) },
      ],
    });
    try {
      h.internals._lastInputTokens = 7000;
      h.internals._lastTotalTokens = 7500;

      let compacts = 0;
      const original = h.internals._doAutoCompact.bind(h.session);
      h.internals._doAutoCompact = async (...args: unknown[]) => {
        compacts += 1;
        return original(...(args as []));
      };

      await h.session.runManualCompact();
      expect(compacts).toBe(1);

      await h.session.turn("follow-up request");
      expect(compacts).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("does not revive a pre-compact token_update on restore", () => {
    const restored = restoreSession([
      createSystemPrompt("sys-001", "prompt"),
      createTokenUpdate("tok-001", 1, 7000, 0, 0, 7500),
      createCompactMarker("marker-001", 1, 1, 7000, 0),
      createCompactContext("ctx-001", 1, "continuation briefing", "c-1", 1),
    ]);
    try {
      expect(restored.session.lastInputTokens).toBe(0);
      expect(restored.session.lastTotalTokens).toBe(0);
    } finally {
      restored.dispose();
    }
  });

  it("still restores a token_update recorded after the last compact marker", () => {
    const restored = restoreSession([
      createSystemPrompt("sys-001", "prompt"),
      createTokenUpdate("tok-001", 1, 7000, 0, 0, 7500),
      createCompactMarker("marker-001", 1, 1, 7000, 0),
      createCompactContext("ctx-001", 1, "continuation briefing", "c-1", 1),
      createTokenUpdate("tok-002", 2, 900, 100, 0, 1000),
    ]);
    try {
      expect(restored.session.lastInputTokens).toBe(900);
      expect(restored.session.lastTotalTokens).toBe(1000);
      expect((restored.session as unknown as { lastCacheReadTokens: number }).lastCacheReadTokens).toBe(100);
    } finally {
      restored.dispose();
    }
  });
});
