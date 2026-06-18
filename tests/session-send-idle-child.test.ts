/**
 * Characterization tests for parent→child message delivery (review B2).
 *
 * The idle/archived delivery paths currently bypass the standard delivery
 * entry point and crash the child turn on the drain invariant. Flip the
 * todos in P1.5 (Docs/session-refactor-plan-2026-06-11.md).
 */

import { describe, expect, it } from "bun:test";

import {
  ScriptedProvider,
  makeScriptedAgentObject,
  makeScriptedSession,
  waitFor,
  type SessionHarness,
} from "./helpers/session-harness.js";

interface ChildSetup {
  h: SessionHarness;
  childProvider: ScriptedProvider;
  handle: any;
}

function makeParentWithChild(): ChildSetup {
  const h = makeScriptedSession({
    rounds: [{ text: "noted" }],
  });
  const childProvider = new ScriptedProvider();
  childProvider.rounds = [{ text: "child done" }];
  const childAgent = makeScriptedAgentObject(childProvider, { name: "w1" });
  const handle = h.internals._instantiateChildSession("w1", "tpl", "persistent", childAgent);
  h.internals._childSessions.set("w1", handle);
  return { h, childProvider, handle };
}

describe("send to child sessions", () => {
  it("send to a running child queues via the standard delivery path (locked)", async () => {
    const { h, childProvider, handle } = makeParentWithChild();
    try {
      handle.lifecycle = "running";

      const result = await h.internals._execSend({ to: "w1", content: "hello child" });

      expect(String(result.content)).toContain("Message sent");
      // The standard delivery path populates the bookkeeping fields the
      // drain invariant requires, and the child's own turn consumes the
      // message without crashing.
      await waitFor(() => childProvider.sawUserText("hello child"));
      await (handle.session as { waitForTurnComplete: () => Promise<void> }).waitForTurnComplete();
      await h.session.waitForTurnComplete();
    } finally {
      h.dispose();
    }
  });

  // P1.5 — B2: idle 投递绕过标准入口，子代理 turn 立即崩溃。
  it("send to an idle persistent child starts a turn that completes", async () => {
    const { h, childProvider, handle } = makeParentWithChild();
    try {
      handle.lifecycle = "idle";

      const result = await h.internals._execSend({ to: "w1", content: "hello idle child" });
      expect(String(result.content)).toContain("sent");

      if (handle.settlePromise) await handle.settlePromise;

      expect(handle.lastOutcome).toBe("completed");
      expect(childProvider.sawUserText("hello idle child")).toBe(true);

      const agentResult = h.session.log.find((e) => e.type === "agent_result");
      expect(String(agentResult?.content ?? "")).toContain("completed");
    } finally {
      h.dispose();
    }
  });

  // P1.5 — B2: 运行时 archived 的 persistent child 复活路径同样绕过标准入口。
  it("send to a runtime-archived persistent child revives it and completes", async () => {
    const { h, childProvider, handle } = makeParentWithChild();
    try {
      handle.lifecycle = "archived";

      const result = await h.internals._execSend({ to: "w1", content: "hello archived child" });
      expect(String(result.content)).toContain("revived");

      if (handle.settlePromise) await handle.settlePromise;

      expect(handle.lastOutcome).toBe("completed");
      expect(childProvider.sawUserText("hello archived child")).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
