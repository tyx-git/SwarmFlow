/**
 * 临时红测：核实压缩后的 token 记账残留（核实后删除或转正为回归测试）。
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
} from "../src/context/log-entry.js";
import { Usage } from "../src/providers/base.js";
import { Session } from "../src/session.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

describe("compact token accounting (temporary red test)", () => {
  it("manual compact must leave per-response input tokens below the before-turn threshold", async () => {
    const h = makeScriptedSession({
      rounds: [
        { text: "continuation summary text", usage: new Usage(7000, 5) },
        { text: "post-compact answer", usage: new Usage(100, 5) },
      ],
    });
    try {
      h.internals._lastInputTokens = 7000;
      h.internals._lastTotalTokens = 7500;

      await h.session.runManualCompact();

      const budget = h.internals._contextBudgetInfo().budget as number;
      const threshold = budget * (h.internals._thresholds.compact_before_turn / 100);
      expect(h.session.lastInputTokens).toBeLessThanOrEqual(threshold);
    } finally {
      h.dispose();
    }
  });

  it("the first turn after a manual compact must not compact again", async () => {
    const h = makeScriptedSession({
      rounds: [
        { text: "continuation summary text", usage: new Usage(7000, 5) },
        { text: "second compact ran", usage: new Usage(100, 5) },
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

  it("restore must not revive a pre-compact token_update as current context", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "swarmflow-token-bug-base-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "swarmflow-token-bug-project-"));
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      store.createSession();
      const primaryAgent = {
        name: "Primary",
        systemPrompt: "Primary system prompt.",
        tools: [],
        modelConfig: {
          name: "test-model",
          provider: "openai",
          model: "gpt-5.2",
          apiKey: "sk-test",
          maxTokens: 256,
          contextLength: 8192,
          supportsMultimodal: false,
        },
        _provider: { budgetCalcMode: "full_context" },
        replaceModelConfig(next: unknown) {
          (this as { modelConfig?: unknown }).modelConfig = next;
        },
      } as never;
      const config = {
        pathOverrides: { projectRoot },
        mcpServerConfigs: [],
        getModel: () => ({
          name: "test-model",
          provider: "openai",
          model: "gpt-5.2",
          apiKey: "sk-test",
          maxTokens: 256,
          contextLength: 8192,
          supportsMultimodal: false,
        }),
      } as never;
      const session = new Session({ primaryAgent, config, store, projectRoot });

      const entries = [
        createSystemPrompt("sys-001", "prompt"),
        createTokenUpdate("tok-001", 1, 7000, 0, 0, 7500),
        createCompactMarker("marker-001", 1, 1, 7000, 0),
        createCompactContext("ctx-001", 1, "continuation briefing", "c-1", 1),
      ];
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

      expect(session.lastInputTokens).toBe(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
