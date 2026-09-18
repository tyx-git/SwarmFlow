/**
 * Runtime-owned visibility (Phase 3) — error log entries, ask subscription,
 * turn lifecycle events.
 *
 * Contract: the runtime (Session) is responsible for making failures, pending
 * asks, and turn boundaries observable. No UI compensation is required —
 * out-of-process UIs (GUI over RPC) see exactly what the TUI sees.
 */

import { describe, expect, it } from "vitest";

import type { TurnLifecycleEvent } from "../src/session.js";
import {
  ScriptedProvider,
  makeScriptedAgentObject,
  makeScriptedSession,
  stageApprovalGate,
  testToolDef,
  waitFor,
  type SessionHarness,
} from "./helpers/session-harness.js";

function visibleErrors(h: SessionHarness): Array<{ display: string; errorType: unknown }> {
  return h.session.log
    .filter((e) => e.type === "error" && !e.discarded)
    .map((e) => ({
      display: String(e.display ?? ""),
      errorType: (e.meta as Record<string, unknown>)["errorType"],
    }));
}

describe("runtime-owned error entries", () => {
  it("writes the error log entry when the provider fails mid-turn", async () => {
    const h = makeScriptedSession({
      rounds: [{ onCall: () => { throw new Error("insufficient balance"); } }],
    });
    try {
      await expect(h.session.turn("hello")).rejects.toThrow("insufficient balance");
      const errors = visibleErrors(h);
      expect(errors.length).toBe(1);
      expect(errors[0]!.display).toContain("insufficient balance");
      expect(errors[0]!.errorType).toBe("turn");
      expect(h.session.lastTurnEndStatus).toBe("error");
    } finally {
      h.dispose();
    }
  });

  it("writes the entry exactly once even though multiple catch layers run", async () => {
    const h = makeScriptedSession({
      rounds: [{ onCall: () => { throw new Error("model 400: bad request"); } }],
    });
    try {
      await expect(h.session.turn("hello")).rejects.toThrow("model 400");
      expect(visibleErrors(h).length).toBe(1);
      // A later, unrelated turn that succeeds must not be suppressed by the
      // once-flag from the failed turn.
      h.provider.rounds.push({ onCall: () => { throw new Error("second failure"); } });
      await expect(h.session.turn("again")).rejects.toThrow("second failure");
      expect(visibleErrors(h).length).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it("does NOT write an error entry for user interrupts (AbortError)", async () => {
    const controller = new AbortController();
    const h = makeScriptedSession({
      rounds: [{
        onCall: () => {
          // Real interrupt shape: the signal aborts AND the provider throws.
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        },
      }],
    });
    try {
      // Interrupts do not reject the turn — they end it as "interrupted".
      await h.session.turn("hello", { signal: controller.signal });
      expect(visibleErrors(h).length).toBe(0);
      expect(h.session.lastTurnEndStatus).toBe("interrupted");
    } finally {
      h.dispose();
    }
  });

  it("auto-resume failures land in the log (previously fully swallowed)", async () => {
    const h = makeScriptedSession({
      rounds: [{ onCall: () => { throw new Error("auto-resume provider failure"); } }],
    });
    try {
      // A user message delivered while idle queues and schedules auto-resume.
      h.session.deliverMessage("user", "background ping");
      await waitFor(() => visibleErrors(h).length > 0);
      expect(visibleErrors(h)[0]!.display).toContain("auto-resume provider failure");
    } finally {
      h.dispose();
    }
  });

  it("pre-activation failures (storage/MCP) write the entry AND emit ended(error)", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "never reached" }] });
    try {
      h.internals._ensureSessionStorageReady = () => {
        throw new Error("storage unavailable");
      };
      const events: TurnLifecycleEvent[] = [];
      h.session.subscribeTurnLifecycle((e) => events.push(e));
      await expect(h.session.turn("hello")).rejects.toThrow("storage unavailable");
      expect(visibleErrors(h).length).toBe(1);
      expect(visibleErrors(h)[0]!.display).toContain("storage unavailable");
      // The activation loop never ran, so the runtime emits a lone ended(error).
      expect(events).toMatchObject([
        { phase: "ended", status: "error", error: "storage unavailable" },
      ]);
      expect(h.provider.callCount).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("pre-activation failures in auto-resume turns are equally visible", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "never reached" }] });
    try {
      h.internals._ensureSessionStorageReady = () => {
        throw new Error("storage gone mid-session");
      };
      h.session.deliverMessage("user", "background ping");
      await waitFor(() => visibleErrors(h).length > 0);
      expect(visibleErrors(h)[0]!.display).toContain("storage gone mid-session");
    } finally {
      h.dispose();
    }
  });

  it("manual summarize validation failures land in the log", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      await expect(
        h.session.runManualSummarize({ targetContextIds: [] }),
      ).rejects.toThrow("requires selecting target turns");
      expect(visibleErrors(h).length).toBe(1);
      expect(visibleErrors(h)[0]!.display).toContain("requires selecting target turns");
    } finally {
      h.dispose();
    }
  });
});

describe("turn lock", () => {
  it("serializes two same-tick turn() callers (no concurrent activation loops)", async () => {
    let active = 0;
    let maxActive = 0;
    const h = makeScriptedSession({
      rounds: [
        {
          onCall: () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
          },
          text: "first",
        },
        {
          onCall: () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
          },
          text: "second",
        },
      ],
    });
    // Decrement when each turn fully ends.
    h.session.subscribeTurnLifecycle((e) => {
      if (e.phase === "ended") active -= 1;
    });
    try {
      // Same tick, no await between the two calls — the old check-then-claim
      // lock let both enter and run concurrent activation loops.
      const p1 = h.session.turn("one");
      const p2 = h.session.turn("two");
      await Promise.all([p1, p2]);
      expect(maxActive).toBe(1);
      expect(h.provider.callCount).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it("failed manual compact + queued turn: exactly one error entry, one ended(error)", async () => {
    // Regression: the failure catch layers used to sit OUTSIDE the turn lock
    // while the once-flags reset per lock acquisition — a queued claimant
    // resumed before the outer catch ran, so the compact failure was written
    // twice (or, for pre-try validation errors, swallowed entirely).
    const h = makeScriptedSession({
      rounds: [
        { onCall: () => { throw new Error("compact provider failure"); } },
        { text: "queued turn ok" },
      ],
    });
    try {
      const endedErrors: TurnLifecycleEvent[] = [];
      h.session.subscribeTurnLifecycle((e) => {
        if (e.phase === "ended" && e.status === "error") endedErrors.push(e);
      });
      const p1 = h.session.runManualCompact().catch(() => {});
      const p2 = h.session.turn("queued input");
      await Promise.all([p1, p2]);
      const compactErrors = visibleErrors(h).filter((e) => e.display.includes("compact provider failure"));
      expect(compactErrors.length).toBe(1);
      expect(endedErrors.length).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("a failed turn does not suppress the next turn's error entry (per-execution once-flag)", async () => {
    const h = makeScriptedSession({
      rounds: [
        { onCall: () => { throw new Error("first failure"); } },
        { onCall: () => { throw new Error("second failure"); } },
      ],
    });
    try {
      const p1 = h.session.turn("one").catch(() => {});
      const p2 = h.session.turn("two").catch(() => {});
      await Promise.all([p1, p2]);
      const errors = visibleErrors(h).map((e) => e.display);
      expect(errors.some((d) => d.includes("first failure"))).toBe(true);
      expect(errors.some((d) => d.includes("second failure"))).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe("ask subscription", () => {
  it("notifies on suspend and on resolve for the session's own ask", async () => {
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "write_file", arguments: { path: "a.txt" } }] },
        { text: "done" },
      ],
      tools: [testToolDef("write_file")],
    });
    try {
      const holder = stageApprovalGate(h, "write_file");
      const seen: Array<string | null> = [];
      h.session.subscribeAsk(() => seen.push(h.session.getPendingAsk()?.id ?? null));

      await h.session.turn("write the file");
      expect(holder.ask).not.toBeNull();
      expect(seen).toEqual(["approval-test-1"]);

      h.session.resolveApprovalAsk("approval-test-1", 0);
      expect(seen).toEqual(["approval-test-1", null]);
    } finally {
      h.dispose();
    }
  });

  it("unsubscribe stops notifications", async () => {
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "write_file", arguments: {} }] },
        { text: "done" },
      ],
      tools: [testToolDef("write_file")],
    });
    try {
      stageApprovalGate(h, "write_file");
      let fired = 0;
      const unsubscribe = h.session.subscribeAsk(() => { fired += 1; });
      unsubscribe();
      await h.session.turn("write the file");
      expect(fired).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("bubbles child-session asks to root subscribers", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "noted" }] });
    try {
      const childProvider = new ScriptedProvider();
      childProvider.rounds = [
        { toolCalls: [{ id: "call-c1", name: "write_file", arguments: {} }] },
        { text: "done" },
      ];
      const childAgent = makeScriptedAgentObject(childProvider, {
        name: "worker-1",
        tools: [testToolDef("write_file")],
      });
      const handle = h.internals._instantiateChildSession("worker-1", "explorer", "persistent", childAgent);
      h.internals._childSessions.set("worker-1", handle);

      // Stage the approval gate on the CHILD session.
      let fired = false;
      handle.session._beforeToolExecute = async (ctx: { toolName: string }) => {
        if (ctx.toolName !== "write_file" || fired) return undefined;
        fired = true;
        return {
          kind: "ask",
          ask: {
            id: "approval-child",
            kind: "approval",
            createdAt: new Date().toISOString(),
            source: { agentId: "worker-1", agentName: "worker-1" },
            summary: "Allow write_file?",
            roundIndex: undefined,
            payload: {
              toolCallId: "",
              toolName: "write_file",
              toolSummary: "worker-1 is calling write_file",
              permissionClass: "write",
              offers: [{ type: "tool_once", label: "Allow once" }],
            },
            options: ["Allow once", "Deny"],
          },
        };
      };

      const seen: Array<string | null> = [];
      h.session.subscribeAsk(() => seen.push(h.session.getPendingAsk()?.id ?? null));

      const sent = await h.internals._execSend({ to: "worker-1", content: "write it" });
      expect(String(sent.content)).toContain("sent");
      await waitFor(() => seen.includes("approval-child"));
      expect(h.session.getPendingAsk()?.id).toBe("approval-child");
    } finally {
      h.dispose();
    }
  });
});

describe("turn lifecycle events", () => {
  function record(h: SessionHarness): TurnLifecycleEvent[] {
    const events: TurnLifecycleEvent[] = [];
    h.session.subscribeTurnLifecycle((event) => events.push(event));
    return events;
  }

  it("emits started/ended(completed) for a plain turn", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "hi" }] });
    try {
      const events = record(h);
      await h.session.turn("hello");
      expect(events.map((e) => e.phase)).toEqual(["started", "ended"]);
      expect(events[1]).toMatchObject({ phase: "ended", status: "completed" });
    } finally {
      h.dispose();
    }
  });

  it("emits ended(waiting) when the turn parks on a pending ask", async () => {
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "write_file", arguments: {} }] },
        { text: "done" },
      ],
      tools: [testToolDef("write_file")],
    });
    try {
      stageApprovalGate(h, "write_file");
      const events = record(h);
      await h.session.turn("write the file");
      const ended = events.filter((e) => e.phase === "ended");
      expect(ended.length).toBe(1);
      expect(ended[0]).toMatchObject({ status: "waiting" });
    } finally {
      h.dispose();
    }
  });

  it("emits ended(error) with the error message on provider failure", async () => {
    const h = makeScriptedSession({
      rounds: [{ onCall: () => { throw new Error("context length exceeded"); } }],
    });
    try {
      const events = record(h);
      await expect(h.session.turn("hello")).rejects.toThrow();
      const ended = events.find((e) => e.phase === "ended");
      expect(ended).toMatchObject({ status: "error", error: "context length exceeded" });
    } finally {
      h.dispose();
    }
  });

  it("emits lifecycle events for auto-resume turns (no external caller)", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "processed" }] });
    try {
      const events = record(h);
      h.session.deliverMessage("user", "background ping");
      await waitFor(() => events.some((e) => e.phase === "ended"));
      expect(events.map((e) => e.phase)).toEqual(["started", "ended"]);
      expect(events[1]).toMatchObject({ status: "completed" });
    } finally {
      h.dispose();
    }
  });
});
