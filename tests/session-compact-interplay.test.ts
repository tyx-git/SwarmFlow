/**
 * Characterization tests for compact-period message semantics and bookkeeping
 * (review B4/B5, rulings Q4/Q6).
 *
 * Locked green by P1.6/P1.7 (Docs/session-refactor-plan-2026-06-11.md).
 */

import { describe, expect, it } from "bun:test";

import {
  makeScriptedSession,
  waitFor,
  type SessionHarness,
} from "./helpers/session-harness.js";

describe("manual compact", () => {
  it("appends marker + continuation and leaves the session idle (locked)", async () => {
    const h = makeScriptedSession({
      rounds: [{ text: "continuation summary text" }],
    });
    try {
      await h.session.runManualCompact();

      const log = h.session.log;
      const marker = log.find((e) => e.type === "compact_marker" && !e.discarded);
      const context = log.find((e) => e.type === "compact_context" && !e.discarded);
      expect(marker).toBeTruthy();
      expect(String(context?.content ?? "")).toContain("continuation summary text");
      expect(h.internals._compactInProgress).toBe(false);
      expect(h.session.currentTurnRunning).toBe(false);
    } finally {
      h.dispose();
    }
  });

  // P1.7 — Q4/B5: /compact 由 compact phase 自身消化，不得在簿记上留下「未回应的用户消息」。
  it("manual compact leaves no unprocessed-user-message bookkeeping behind", async () => {
    const h = makeScriptedSession({
      rounds: [{ text: "continuation summary text" }],
    });
    try {
      await h.session.runManualCompact();

      expect(h.internals._hasUnprocessedUserMessage()).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("manual compact interrupt closes work as interrupted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const h = makeScriptedSession({
      rounds: [{ text: "continuation summary text" }],
    });
    try {
      await expect(h.session.runManualCompact("", { signal: abortController.signal })).rejects.toMatchObject({
        name: "AbortError",
      });

      const workEnd = h.session.log.find((e) => e.type === "work_end" && !e.discarded);
      expect(workEnd?.meta.status).toBe("interrupted");
      expect(h.internals._currentWorkId).toBeNull();
      expect(h.session.log.some((e) =>
        e.type === "user_message"
        && String(e.content).includes("Context compaction was in progress and has been canceled"),
      )).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe("messages arriving during compact (Q6)", () => {
  function makeCompactWithToolRound(onProbe: (h: SessionHarness) => void): SessionHarness {
    const h: SessionHarness = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "probe-1", name: "probe_tool", arguments: {} }] },
        { text: "continuation" },
      ],
      toolExecutorOverrides: {
        probe_tool: () => {
          onProbe(h);
          return "ok";
        },
      },
    });
    h.session.permissionMode = "yolo";
    return h;
  }

  // P1.6 — Q6: compact 进行中用户输入被拒绝并提示，不入收件箱、不进日志。
  it("user input during compact is rejected", async () => {
    let deliverResult: { accepted: boolean; reason?: string } | undefined;
    const h = makeCompactWithToolRound((harness) => {
      deliverResult = harness.session.deliverMessage("user", "mid-compact user msg");
    });
    try {
      await h.session.runManualCompact();

      expect(deliverResult?.accepted).toBe(false);
      expect(
        h.session.log.some(
          (e) => e.type === "input_received" && String(e.display).includes("mid-compact user msg"),
        ),
      ).toBe(false);
    } finally {
      h.dispose();
    }
  });

  // P1.6 — Q6: 自动消息（子代理/shell）排队等 compact 结束后投递，不得被卷进 marker 之前。
  it("automatic messages arriving during compact land after the marker", async () => {
    const h = makeCompactWithToolRound((harness) => {
      harness.internals._deliverMessage({
        type: "system_notice",
        sender: "system",
        content: "agent finished mid-compact",
        timestamp: Date.now(),
      });
    });
    try {
      await h.session.runManualCompact();

      const log = () => h.session.log;
      const markerIdx = () => log().findIndex((e) => e.type === "compact_marker" && !e.discarded);
      const noticeIdx = () =>
        log().findIndex(
          (e) => e.type === "user_message" && String(e.content).includes("agent finished mid-compact"),
        );

      expect(markerIdx()).toBeGreaterThan(-1);
      await waitFor(() => noticeIdx() > markerIdx());
    } finally {
      h.dispose();
    }
  });
});

describe("interrupted summarize_context (B4)", () => {
  // P1.6 — B4: 中断时未落盘的 summary 暂存必须清空，不得在下一个 turn 错位补写。
  it("summary staged by an interrupted summarize_context never leaks into a later turn", async () => {
    const abortController = new AbortController();
    let harness!: SessionHarness;
    harness = makeScriptedSession({
      rounds: [{ text: "alpha findings worth summarizing" }],
      toolExecutorOverrides: {
        summarize_context: (args) => {
          const result = harness.internals._execSummarizeContextTool(args);
          abortController.abort();
          return result;
        },
        probe_tool: () => "ok",
      },
    });
    harness.session.permissionMode = "yolo";
    try {
      await harness.session.turn("explore");
      const assistant = harness.session.log.find((e) => e.type === "assistant_text" && !e.discarded);
      const contextId = String((assistant?.meta as Record<string, unknown>)?.contextId ?? "");
      expect(contextId).toBeTruthy();

      harness.provider.rounds.push({
        toolCalls: [{
          id: "sum-1",
          name: "summarize_context",
          arguments: { operations: [{ from: contextId, to: contextId, content: "alpha summary" }] },
        }],
      });
      await harness.session.turn("summarize that", { signal: abortController.signal });
      expect(harness.session.log.filter((e) => e.type === "summary" && !e.discarded)).toHaveLength(0);

      harness.provider.rounds.push(
        { toolCalls: [{ id: "probe-2", name: "probe_tool", arguments: {} }] },
        { text: "after" },
      );
      await harness.session.turn("unrelated next");

      expect(harness.session.log.filter((e) => e.type === "summary" && !e.discarded)).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });
});

describe("interrupted mid-turn compact", () => {
  it("records compact cancellation context and interrupted work", async () => {
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "probe-1", name: "probe_tool", arguments: {} }] },
      ],
      toolExecutorOverrides: {
        probe_tool: () => "ok",
      },
    });
    h.session.permissionMode = "yolo";
    h.internals._contextManager.thresholds.compact_mid_turn = 0.1;
    h.internals._doAutoCompact = async () => {
      throw new DOMException("Compact phase aborted.", "AbortError");
    };
    try {
      await h.session.turn("trigger compact");

      const workEnd = h.session.log.find((e) => e.type === "work_end" && !e.discarded);
      expect(workEnd?.meta.status).toBe("interrupted");
      expect(h.session.log.some((e) =>
        e.type === "user_message"
        && String(e.content).includes("Context compaction was in progress and has been canceled"),
      )).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
