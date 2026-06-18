/**
 * Characterization tests for resume-path equivalence (review N8, ruling Q5).
 *
 * After an ask is resolved the turn is in "waiting to continue" state. All
 * resume entry points must behave identically: execute the pending approved
 * tool, and never drop a new user input that arrives in the gap.
 * Flip the todo in P1.3 (Docs/session-refactor-plan-2026-06-11.md).
 */

import { describe, expect, it } from "bun:test";

import {
  makeScriptedSession,
  stageApprovalGate,
  testToolDef,
} from "./helpers/session-harness.js";

describe("resume-path equivalence", () => {
  // P1.3 — Q5: 暂停空隙到达的新输入排队稍后送达；turn() 的恢复路径必须与 resumePendingTurn 等价（含执行已批准工具）。
  it("turn() after approval resumes the pending work and keeps the new input", async () => {
    const executed: string[] = [];
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "gated_tool", arguments: { step: 1 } }] },
        { text: "resumed" },
        { text: "answered follow-up" },
      ],
      tools: [testToolDef("gated_tool")],
      toolExecutorOverrides: {
        gated_tool: () => {
          executed.push("ran");
          return "TOOL OK";
        },
      },
    });
    try {
      const gate = stageApprovalGate(h, "gated_tool");

      await h.session.turn("kick off");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");

      h.session.resolveApprovalAsk(gate.ask!.id, 0); // approved; turn now waiting to continue
      expect(h.session.hasPendingTurnToResume()).toBe(true);

      // New input arrives through turn() instead of resumePendingTurn().
      await h.session.turn("follow-up question");

      expect(executed).toEqual(["ran"]); // approved tool still executed
      expect(h.provider.sawUserText("follow-up question")).toBe(true); // input not dropped
    } finally {
      h.dispose();
    }
  });
});
