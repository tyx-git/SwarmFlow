/**
 * Child approval routing — REAL parent + child Sessions driven through the
 * scripted-provider harness (Q11 rewrite; previously an Object.create mock
 * suite that depended on the snapshot layer's as-any leniency removed in Q12).
 *
 * The child suspends on a staged approval gate exactly like production:
 * tool call → preflight ask → child turn returns → handle goes "blocked".
 * Root-level routing (getPendingAsk bubble, resolveApprovalAsk, deny,
 * interrupt) then exercises the real ChildSessionManager paths.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { ApprovalRequest } from "../src/ask.js";
import {
  ScriptedProvider,
  makeScriptedAgentObject,
  makeScriptedSession,
  stageApprovalGate,
  testToolDef,
  waitFor,
  type SessionHarness,
} from "./helpers/session-harness.js";

/** Stage a one-shot approval gate on a child session (same shape as stageApprovalGate). */
function stageApprovalOnChild(childSession: any, agentId: string, toolName: string): { ask: ApprovalRequest | null } {
  const holder: { ask: ApprovalRequest | null } = { ask: null };
  let fired = false;
  childSession._beforeToolExecute = async (ctx: { toolName: string }) => {
    if (ctx.toolName !== toolName || fired) return undefined;
    fired = true;
    const ask: ApprovalRequest = {
      id: "approval-child",
      kind: "approval",
      createdAt: new Date().toISOString(),
      source: { agentId, agentName: agentId },
      summary: `Allow ${toolName}?`,
      roundIndex: undefined,
      payload: {
        toolCallId: "",
        toolName,
        toolSummary: `${agentId} is calling ${toolName}`,
        permissionClass: "write",
        offers: [{ type: "tool_once", label: "Allow once" }],
      },
      options: ["Allow once", "Deny"],
    };
    holder.ask = ask;
    return { kind: "ask", ask };
  };
  return holder;
}

interface ChildSetup {
  h: SessionHarness;
  childProvider: ScriptedProvider;
  handle: any;
}

function makeParentWithChild(childRounds: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>): ChildSetup {
  const h = makeScriptedSession({
    rounds: [{ text: "noted" }, { text: "noted again" }],
  });
  const childProvider = new ScriptedProvider();
  childProvider.rounds = childRounds;
  const childAgent = makeScriptedAgentObject(childProvider, {
    name: "worker-1",
    tools: [testToolDef("write_file"), testToolDef("slow_tool")],
  });
  const handle = h.internals._instantiateChildSession("worker-1", "explorer", "persistent", childAgent);
  h.internals._childSessions.set("worker-1", handle);
  return { h, childProvider, handle };
}

/** Child suspends on an approval mid-turn and its handle goes "blocked". */
async function makeBlockedChild(): Promise<ChildSetup & { holder: { ask: ApprovalRequest | null } }> {
  const setup = makeParentWithChild([
    { toolCalls: [{ id: "call-w1", name: "write_file", arguments: { path: "out.txt", content: "data" } }] },
    { text: "done after approval" },
  ]);
  const holder = stageApprovalOnChild(setup.handle.session, "worker-1", "write_file");
  const sent = await setup.h.internals._execSend({ to: "worker-1", content: "please write the file" });
  if (!String(sent.content).includes("sent")) throw new Error(`send failed: ${sent.content}`);
  await waitFor(() => setup.handle.lifecycle === "blocked");
  return { ...setup, holder };
}

describe("child approval routing", () => {
  it("bubbles child pending approval through root getPendingAsk", async () => {
    const { h, handle, holder } = await makeBlockedChild();
    try {
      expect(holder.ask).not.toBeNull();
      expect(h.session.getPendingAsk()).toMatchObject({
        id: "approval-child",
        kind: "approval",
        source: { agentId: "worker-1" },
      });
      expect(handle.phase).toBe("waiting");
    } finally {
      h.dispose();
    }
  });

  it("routes approval resolution to the child and resumes the child turn", async () => {
    const { h, handle, holder, childProvider } = await makeBlockedChild();
    try {
      h.session.resolveApprovalAsk(holder.ask!.id, 0); // Allow once → child auto-resumes

      await waitFor(() => handle.lastOutcome === "completed");
      expect(handle.lifecycle).toBe("idle"); // persistent child back to idle
      // The approved tool really executed: its result is in the child log.
      expect(handle.session.log.some((e: any) =>
        e.type === "tool_result" && (e.meta as Record<string, unknown>).toolCallId === "call-w1",
      )).toBe(true);
      // Completion surfaced to the parent as an agent_result entry.
      await waitFor(() => h.session.log.some((e) => e.type === "agent_result"));
    } finally {
      h.dispose();
    }
  });

  it("does not produce an agent_result when a child turn stops for approval", async () => {
    const { h, handle } = await makeBlockedChild();
    try {
      expect(handle.lifecycle).toBe("blocked");
      expect(handle.status).toBe("idle");
      expect(handle.phase).toBe("waiting");
      expect(handle.lastOutcome).toBe("none");
      expect(h.session.log.some((e) => e.type === "agent_result")).toBe(false);
      // The blocked child was persisted (real save, not a mock call count).
      expect(existsSync(join(handle.sessionDir, "log.json"))).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("does not notify the parent inbox when a child blocks on approval", async () => {
    // Per-approval system_notice notifications were intentionally removed
    // (commit 7efb5d1f): a blocked child surfaces via check_status
    // (lifecycle: blocked), not via noisy inbox messages to the parent.
    const { h, handle } = await makeBlockedChild();
    try {
      expect(h.internals._inbox).toHaveLength(0);
      expect(handle.lifecycle).toBe("blocked");
      expect(h.internals._hasActiveAgents()).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("can interrupt a blocked child without treating it as a working child", async () => {
    const { h, handle } = await makeBlockedChild();
    try {
      handle.mode = "oneshot"; // lock the oneshot → archived branch

      const decision = h.session.interruptChildSession("worker-1");

      expect(decision).toEqual({ accepted: true });
      expect(handle.lifecycle).toBe("archived");
      expect(handle.lastOutcome).toBe("interrupted");
      expect(h.internals._hasActiveAgents()).toBe(false);
      // The interrupted one-shot is released like any settled one-shot; the
      // normalization must therefore be visible on the persisted log.
      expect(handle.session).toBeNull();
      const childLog = h.session.getChildSessionLog("worker-1")!;
      expect(childLog.some((e: any) =>
        String(e.content ?? "").includes("interrupted while waiting for user approval"),
      )).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("denies and finalizes a child-owned pending ask as interrupted", async () => {
    const { h, handle } = await makeBlockedChild();
    try {
      handle.mode = "oneshot";

      const decision = h.session.denyAndInterruptPendingAsk();

      expect(decision).toEqual({ accepted: true, turnFinished: false });
      expect(handle.lifecycle).toBe("archived");
      expect(handle.lastOutcome).toBe("interrupted");
      // The settled one-shot is released — its Session is gone and the log
      // is served from disk. No pending ask survives anywhere.
      expect(handle.session).toBeNull();
      expect(h.session.getPendingAsk()).toBeNull();
      // Child got a definite deny outcome, not a vanished ask: the persisted
      // log carries the resolution.
      const childLog = h.session.getChildSessionLog("worker-1")!;
      expect(childLog).not.toBeNull();
      expect(childLog.some((e: any) => e.type === "ask_resolution" && !e.discarded)).toBe(true);
      expect(h.session.log.some((e) => e.type === "agent_result")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("rejects sends to blocked children until approval is resolved", async () => {
    const { h, childProvider } = await makeBlockedChild();
    try {
      const result = await h.internals._execSend({ to: "worker-1", content: "new info" });

      expect(String(result.content)).toMatch(/^ERROR:/);
      expect(String(result.content)).toContain("waiting for user approval");
      expect(childProvider.sawUserText("new info")).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("propagates permission mode changes to existing child sessions", () => {
    const { h, handle } = makeParentWithChild([{ text: "idle child" }]);
    try {
      h.session.permissionMode = "read_only";

      expect(h.session.permissionMode).toBe("read_only");
      expect(handle.session.permissionMode).toBe("read_only");
    } finally {
      h.dispose();
    }
  });

  it("creates child sessions with the parent permission mode", () => {
    const h = makeScriptedSession({ rounds: [{ text: "noted" }] });
    try {
      h.session.permissionMode = "read_only";
      const childProvider = new ScriptedProvider();
      const childAgent = makeScriptedAgentObject(childProvider, { name: "worker-2" });

      const handle = h.internals._instantiateChildSession("worker-2", "explorer", "persistent", childAgent);

      expect(handle.session.permissionMode).toBe("read_only");
    } finally {
      h.dispose();
    }
  });

  it("includes pending ask state and display label in child snapshots", async () => {
    const { h, holder } = await makeBlockedChild();
    try {
      const snapshot = h.session.getChildSessionSnapshots().find((s) => s.id === "worker-1");

      expect(snapshot).toBeTruthy();
      expect(snapshot?.pendingAskId).toBe(holder.ask!.id);
      expect(snapshot?.pendingAskKind).toBe("approval");
      expect(snapshot?.phase).toBe("waiting");
      expect(snapshot?.modelDisplayLabel).not.toMatch(/^runtime-/);
    } finally {
      h.dispose();
    }
  });

  it("delivers completed child output through inbox while keeping agent_result display-only", async () => {
    const { h, handle } = makeParentWithChild([{ text: "child says done" }]);
    try {
      const sent = await h.internals._execSend({ to: "worker-1", content: "report status" });
      expect(String(sent.content)).toContain("sent");

      await waitFor(() => handle.lastOutcome === "completed");
      const agentResult = h.session.log.find((e) => e.type === "agent_result");
      expect(agentResult).toBeTruthy();
      expect(agentResult?.apiRole).toBeNull();
      // Natural completion wakes the idle parent; the result text reaches the
      // parent model through the inbox drain, not through the display entry.
      await waitFor(() => h.provider.sawUserText("child says done"));
      await h.session.waitForTurnComplete();
    } finally {
      h.dispose();
    }
  });

  it("delivers mass-interrupted child completions as ride-along (parent does not wake)", async () => {
    const { h, handle } = makeParentWithChild([
      { toolCalls: [{ id: "slow-1", name: "slow_tool", arguments: {} }] },
      { text: "never reached" },
    ]);
    try {
      (handle.session as any)._toolExecutors["slow_tool"] = async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return "slow done";
      };
      const sent = await h.internals._execSend({ to: "worker-1", content: "start slow work" });
      expect(String(sent.content)).toContain("sent");
      expect(handle.lifecycle).toBe("running");

      h.session.interruptAllChildAgents();

      await waitFor(() => handle.lastOutcome === "interrupted");
      const agentResult = h.session.log.find((e) => e.type === "agent_result");
      expect(agentResult).toBeTruthy();
      expect(String(agentResult?.content ?? "")).toContain("interrupted by the user");
      // Q8: user-initiated kills are ride-along — queued in the inbox, and the
      // idle parent must NOT wake to react on its own.
      expect(h.internals._inbox).toHaveLength(1);
      expect(h.internals._inbox[0]).toMatchObject({ type: "peer_message", sender: "worker-1" });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(h.provider.callCount).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("passes the live turn signal into approval-resumed tool execution", async () => {
    let capturedSignal: AbortSignal | undefined;
    let sessionSignalAtExec: AbortSignal | null = null;
    let hRef: SessionHarness | null = null;
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "gated_tool", arguments: {} }] },
        { text: "after approval" },
      ],
      tools: [testToolDef("gated_tool")],
      toolExecutorOverrides: {
        gated_tool: (_args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => {
          capturedSignal = ctx?.signal;
          sessionSignalAtExec = hRef!.internals._currentTurnSignal;
          return "ok";
        },
      },
    });
    hRef = h;
    try {
      const gate = stageApprovalGate(h, "gated_tool");

      await h.session.turn("kick off");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");

      h.session.resolveApprovalAsk(gate.ask!.id, 0);
      await h.session.resumePendingTurn();

      // The executor saw a live signal, and it was THE session's current turn
      // signal at execution time (abort reaches approval-resumed tools).
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal).toBe(sessionSignalAtExec as unknown as AbortSignal);
    } finally {
      h.dispose();
    }
  });
});
