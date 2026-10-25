/**
 * Phase 4 质量契约：逐字 tail、每 turn 自动压缩上限、压后复检。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { buildVerbatimTail } from "../../src/session/compact-flow.js";
import {
  createAssistantText,
  createCompactContext,
  createToolResult,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { ProgressReporter } from "../../src/logging/progress.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

const LONG = `continuation briefing ${"x".repeat(240)}`;

describe("verbatim tail", () => {
  it("keeps the latest user and assistant text and caps long content", () => {
    const user = createUserMessage("u-1", 1, "request", "u".repeat(5_000), "ctx-1");
    const assistant = createAssistantText("a-1", 1, 0, "reply", "a".repeat(5_000), "ctx-1");
    const tail = buildVerbatimTail([user, assistant], "before_turn", "auto");

    expect(tail).toContain("[VERBATIM TAIL — reference only]");
    expect(tail).toContain("current request");
    expect(tail).toContain("[1000 chars omitted]");
    expect(tail.length).toBeLessThan(8_200);
  });

  it("includes the last tool result only for mid-turn and labels manual as already answered", () => {
    const user = createUserMessage("u-1", 1, "request", "request", "ctx-1");
    const assistant = createAssistantText("a-1", 1, 0, "reply", "reply", "ctx-1");
    const result = createToolResult(
      "tr-1",
      1,
      0,
      { toolCallId: "c-1", toolName: "probe", content: "t".repeat(3_000), toolSummary: "probe done" },
      { isError: false, contextId: "ctx-1" },
    );

    const mid = buildVerbatimTail([user, assistant, result], "mid_turn", "auto");
    expect(mid).toContain("Last tool result");
    expect(mid).toMatch(/\[\d+ chars omitted\]/);

    const manual = buildVerbatimTail([user, assistant], "before_turn", "manual");
    expect(manual).toContain("already answered");
  });

  it("skips compact-phase and display-only entries", () => {
    const user = createUserMessage("u-1", 1, "request", "request", "ctx-1");
    const compactPrompt = createUserMessage("u-prompt", 1, "", "compact prompt", "ctx-2");
    compactPrompt.meta["compactPhase"] = true;
    const echo = createUserMessage("u-echo", 1, "/compact", "/compact", "ctx-3");
    echo.meta["displayOnly"] = true;

    const tail = buildVerbatimTail([user, compactPrompt, echo], "before_turn", "auto");
    expect(tail).toContain("request");
    expect(tail).not.toContain("compact prompt");
    expect(tail).not.toContain("/compact");
  });
});

describe("auto compact quota and post-compact recheck", () => {
  it("rejects the fourth automatic compaction in a turn", async () => {
    const h = makeScriptedSession({ rounds: [{ text: LONG }] });
    try {
      h.internals._autoCompactCountThisTurn = 3;
      await expect(
        h.internals._doAutoCompact("before_turn", undefined, undefined, false, "auto"),
      ).rejects.toMatchObject({ code: "E_COMPACT_TURN_LIMIT" });
    } finally {
      h.dispose();
    }
  });

  it("rejects a compact result that leaves less than 40% workspace before commit", async () => {
    const h = makeScriptedSession({ rounds: [{ text: LONG }] });
    try {
      h.internals._estimateStaticContextTokens = () => 5_000;
      await expect(h.session.runManualCompact()).rejects.toMatchObject({
        code: "E_COMPACT_WORKSPACE_LOW",
        committed: false,
      });

      expect(h.session.log.some((entry) => entry.type === "compact_marker" && !entry.discarded)).toBe(false);
      const sessionDir = h.internals._store.sessionDir as string;
      expect(existsSync(join(sessionDir, "archive"))).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("keeps the checkpoint when post-compact recheck still exceeds the threshold", async () => {
    const h = makeScriptedSession({ rounds: [{ text: LONG }] });
    try {
      h.internals._contextManager.thresholds.compact_mid_turn = 0.0001;
      await expect(h.session.runManualCompact()).rejects.toMatchObject({
        code: "E_COMPACT_NO_REDUCTION",
        committed: true,
      });

      const markers = h.session.log.filter((entry) => entry.type === "compact_marker" && !entry.discarded);
      const contexts = h.session.log.filter((entry) => entry.type === "compact_context" && !entry.discarded);
      expect(markers).toHaveLength(1);
      expect(contexts).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it("emits one committed compact_end for a successful attempt", async () => {
    const h = makeScriptedSession({ rounds: [{ text: LONG }] });
    try {
      const progress = new ProgressReporter();
      h.session.setProgressReporter(progress);
      await h.session._doAutoCompact("before_turn", undefined, undefined, false, "manual");

      const starts = progress.messages.filter((event) => event.action === "compact_start");
      const ends = progress.messages.filter((event) => event.action === "compact_end");
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(ends[0]!.extra).toMatchObject({ status: "completed", committed: true });
    } finally {
      h.dispose();
    }
  });

  it("emits one uncommitted compact_end when compact start callback fails", async () => {
    const h = makeScriptedSession({ rounds: [{ text: LONG }] });
    try {
      const progress = new ProgressReporter();
      let startCalls = 0;
      progress.onCompactStart = () => {
        startCalls += 1;
        throw new Error("progress start failed");
      };
      h.session.setProgressReporter(progress);
      await expect(h.session.runManualCompact()).rejects.toThrow("progress start failed");

      const ends = progress.messages.filter((event) => event.action === "compact_end");
      expect(startCalls).toBe(1);
      expect(ends).toHaveLength(1);
      expect(ends[0]!.extra).toMatchObject({ status: "failed", committed: false });
    } finally {
      h.dispose();
    }
  });
});
