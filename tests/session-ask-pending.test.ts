/**
 * Characterization tests for the ask-pending window (review B1/B3, rulings Q1/Q2/Q5/Q9).
 *
 * The ask-window regressions found in the 2026-06-11 review are locked green
 * here; each test names the Phase 1 step that fixed it
 * (P1.1-P1.4 in Docs/session-refactor-plan-2026-06-11.md).
 */

import { describe, expect, it } from "bun:test";

import {
  makeScriptedSession,
  stageApprovalGate,
  testToolDef,
  type SessionHarness,
} from "./helpers/session-harness.js";

function makeGatedHarness(executed: string[], rounds: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>): SessionHarness {
  return makeScriptedSession({
    rounds,
    tools: [testToolDef("gated_tool")],
    toolExecutorOverrides: {
      gated_tool: () => {
        executed.push("ran");
        return "TOOL OK";
      },
    },
  });
}

const SUSPEND_THEN_FINISH = [
  { toolCalls: [{ id: "call-1", name: "gated_tool", arguments: { step: 1 } }] },
  { text: "finished after approval" },
];

describe("ask-pending window", () => {
  it("approve → tool executes → turn completes (locked)", async () => {
    const executed: string[] = [];
    const h = makeGatedHarness(executed, SUSPEND_THEN_FINISH);
    try {
      const gate = stageApprovalGate(h, "gated_tool");

      const first = await h.session.turn("kick off");
      expect(first).toBe("");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");
      expect(executed).toEqual([]);

      h.session.resolveApprovalAsk(gate.ask!.id, 0); // Allow once
      const out = await h.session.resumePendingTurn();

      expect(executed).toEqual(["ran"]);
      expect(out).toBe("finished after approval");
      expect(h.session.getPendingAsk()).toBeNull();
      expect(h.session.log.some((e) => e.type === "work_end" && (e.meta as Record<string, unknown>).status === "completed")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("deny → error tool_result reaches the model and the turn continues (locked)", async () => {
    const executed: string[] = [];
    const h = makeGatedHarness(executed, [
      { toolCalls: [{ id: "call-1", name: "gated_tool", arguments: { step: 1 } }] },
      { text: "acknowledged denial" },
    ]);
    try {
      const gate = stageApprovalGate(h, "gated_tool");

      await h.session.turn("kick off");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");

      h.session.resolveApprovalAsk(gate.ask!.id, 1); // Deny (last option)
      const out = await h.session.resumePendingTurn();

      expect(executed).toEqual([]);
      expect(out).toBe("acknowledged denial");
      expect(h.provider.sawToolResultText("denied by user")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  // P1.1/P1.2 — Q1: ask 挂起 = waiting，挂起期间 turn 计数不得推进；Q5: 空隙消息排队稍后送达。
  it("approved tool still executes when a user message arrives during the pending ask", async () => {
    const executed: string[] = [];
    const h = makeGatedHarness(executed, SUSPEND_THEN_FINISH);
    try {
      const gate = stageApprovalGate(h, "gated_tool");

      await h.session.turn("kick off");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");

      expect(h.session.deliverMessage("user", "mid-ask note").accepted).toBe(true);

      h.session.resolveApprovalAsk(gate.ask!.id, 0);
      const out = await h.session.resumePendingTurn();

      expect(executed).toEqual(["ran"]);
      expect(out).toBe("finished after approval");
      expect(h.provider.sawUserText("mid-ask note")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  // P1.3 — Q5: ask 挂起时 turn() 不得丢输入、不得破坏会话；输入排队等恢复后送达。
  it("turn() during a pending ask queues the input instead of corrupting the session", async () => {
    const executed: string[] = [];
    const h = makeGatedHarness(executed, SUSPEND_THEN_FINISH);
    try {
      const gate = stageApprovalGate(h, "gated_tool");

      await h.session.turn("kick off");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");

      await h.session.turn("typed during ask");
      expect(h.session.getPendingAsk()?.kind).toBe("approval"); // ask survives

      h.session.resolveApprovalAsk(gate.ask!.id, 0);
      await h.session.resumePendingTurn();

      expect(executed).toEqual(["ran"]);
      expect(h.provider.sawUserText("typed during ask")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  // P1.4 — Q9: 任何停止入口在 ask 挂起时 = 拒绝并停止，干净收尾，会话保持可用。
  it("requestTurnInterrupt during a pending ask resolves it as deny-and-stop", async () => {
    const executed: string[] = [];
    const h = makeGatedHarness(executed, [
      { toolCalls: [{ id: "call-1", name: "gated_tool", arguments: { step: 1 } }] },
      { text: "still alive" },
    ]);
    try {
      await h.session.turn("kick off");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");

      h.session.requestTurnInterrupt();

      expect(h.session.getPendingAsk()).toBeNull();
      const log = h.session.log;
      expect(log.some((e) => e.type === "ask_resolution" && !e.discarded)).toBe(true);
      expect(log.some((e) => e.type === "tool_result" && (e.meta as Record<string, unknown>).toolCallId === "call-1")).toBe(true);
      expect(log.some((e) => e.type === "work_end" && (e.meta as Record<string, unknown>).status === "interrupted")).toBe(true);

      // Session must remain usable afterwards.
      const out = await h.session.turn("next please");
      expect(out).toBe("still alive");
      expect(executed).toEqual([]);
    } finally {
      h.dispose();
    }
  });
});
