/**
 * RPC protocol surface (Phase 3) — lifecycle forwarding, ask events,
 * projected log, protocol handshake.
 *
 * Drives registerSessionRpc with a real harness Session and an in-memory
 * RpcServer fake, asserting on the exact wire events a GUI client
 * receives.
 */

import { describe, expect, it } from "bun:test";

import { projectToTuiEntries } from "../src/log-projection.js";
import type { LogEntry } from "../src/log-entry.js";
import type { RpcHandler, RpcServer } from "../src/server/rpc-transport.js";
import {
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  buildMeta,
  registerSessionRpc,
} from "../src/server/session-rpc.js";
import type { Session } from "../src/session.js";
import {
  ScriptedProvider,
  makeScriptedAgentObject,
  makeScriptedSession,
  stageApprovalGate,
  testToolDef,
  waitFor,
  type SessionHarness,
} from "./helpers/session-harness.js";

interface FakeRpcServer extends RpcServer {
  events: Array<{ method: string; params: unknown }>;
  call(method: string, params?: unknown): Promise<unknown>;
  eventsOf(method: string): unknown[];
}

function makeFakeRpcServer(): FakeRpcServer {
  const handlers = new Map<string, RpcHandler>();
  const events: Array<{ method: string; params: unknown }> = [];
  return {
    events,
    on(method, handler) {
      handlers.set(method, handler);
    },
    emit(method, params) {
      events.push({ method, params });
    },
    close() { /* no-op */ },
    async call(method, params) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`no handler for ${method}`);
      return handler(params);
    },
    eventsOf(method) {
      return events.filter((e) => e.method === method).map((e) => e.params);
    },
  };
}

function bind(h: SessionHarness): { rpc: FakeRpcServer; dispose: () => void } {
  const rpc = makeFakeRpcServer();
  const bound = registerSessionRpc({
    session: h.session as unknown as Session,
    server: rpc,
    sessionDir: null,
    workDir: h.projectRoot,
    onShutdown: async () => { /* no-op */ },
  });
  return { rpc, dispose: bound.dispose };
}

describe("protocol handshake", () => {
  it("ready meta advertises protocolVersion and capabilities", () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const meta = buildMeta(h.session as unknown as Session, h.projectRoot, null);
      // Pin the literal wire values (not the exported constants — comparing a
      // constant to itself would let a typo sail through). Adding a NEW
      // capability is fine; renaming or dropping one is a breaking change.
      expect(meta.protocolVersion).toBe(1);
      expect([...meta.capabilities]).toEqual([
        "projectedLog",
        "askEvents",
        "turnLifecycle",
        "waitingStatus",
        "crashEvent",
      ]);
      expect(PROTOCOL_VERSION).toBe(1);
      expect(meta.capabilities).toEqual(PROTOCOL_CAPABILITIES);
    } finally {
      h.dispose();
    }
  });
});

describe("turn lifecycle over RPC", () => {
  it("submitTurn → started + ended(completed) from the runtime", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "hi" }] });
    const { rpc, dispose } = bind(h);
    try {
      await rpc.call("session.submitTurn", { input: "hello" });
      await waitFor(() => rpc.eventsOf("turn.ended").length > 0);
      expect(rpc.eventsOf("turn.started").length).toBe(1);
      expect(rpc.eventsOf("turn.ended")[0]).toMatchObject({ status: "completed" });
    } finally {
      dispose();
      h.dispose();
    }
  });

  it("provider failure → exactly one turn.ended(error) with the message", async () => {
    const h = makeScriptedSession({
      rounds: [{ onCall: () => { throw new Error("upstream 400"); } }],
    });
    const { rpc, dispose } = bind(h);
    try {
      await rpc.call("session.submitTurn", { input: "hello" });
      await waitFor(() => rpc.eventsOf("turn.ended").length > 0);
      // Let the fire-and-forget catch settle: the handler must NOT add a
      // duplicate turn.ended on top of the runtime's lifecycle event.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ended = rpc.eventsOf("turn.ended");
      expect(ended.length).toBe(1);
      expect(ended[0]).toMatchObject({ status: "error", error: "upstream 400" });
    } finally {
      dispose();
      h.dispose();
    }
  });

  it("turn parking on an ask → turn.ended(waiting) + ask.pending", async () => {
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "write_file", arguments: {} }] },
        { text: "done" },
      ],
      tools: [testToolDef("write_file")],
    });
    const { rpc, dispose } = bind(h);
    try {
      stageApprovalGate(h, "write_file");
      await rpc.call("session.submitTurn", { input: "write it" });
      await waitFor(() => rpc.eventsOf("turn.ended").length > 0);
      expect(rpc.eventsOf("turn.ended")[0]).toMatchObject({ status: "waiting" });
      expect(rpc.eventsOf("ask.pending")).toMatchObject([{ id: "approval-test-1" }]);
    } finally {
      dispose();
      h.dispose();
    }
  });

  it("a queued turn's pre-activation failure still reaches the wire (no dedup window loss)", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "first ok" }] });
    const { rpc, dispose } = bind(h);
    try {
      // Turn A succeeds; turn B (queued same tick) dies before its activation
      // loop. The old global-counter dedup suppressed B's turn.ended because
      // A's ended had already advanced the counter.
      let calls = 0;
      const realEnsure = h.internals._ensureSessionStorageReady.bind(h.session);
      h.internals._ensureSessionStorageReady = () => {
        calls += 1;
        if (calls >= 2) throw new Error("disk vanished");
        realEnsure();
      };
      await rpc.call("session.submitTurn", { input: "one" });
      await rpc.call("session.submitTurn", { input: "two" });
      await waitFor(() => rpc.eventsOf("turn.ended").length >= 2);
      const ended = rpc.eventsOf("turn.ended") as Array<{ status: string; error?: string }>;
      expect(ended[0]).toMatchObject({ status: "completed" });
      expect(ended[1]).toMatchObject({ status: "error", error: "disk vanished" });
    } finally {
      dispose();
      h.dispose();
    }
  });

  it("auto-resume turns emit lifecycle events without any RPC caller", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "processed" }] });
    const { rpc, dispose } = bind(h);
    try {
      h.session.deliverMessage("user", "background ping");
      await waitFor(() => rpc.eventsOf("turn.ended").length > 0);
      expect(rpc.eventsOf("turn.started").length).toBe(1);
      expect(rpc.eventsOf("turn.ended")[0]).toMatchObject({ status: "completed" });
    } finally {
      dispose();
      h.dispose();
    }
  });
});

describe("ask events over RPC", () => {
  it("child-session asks reach the wire (the old log-poll never saw these)", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "noted" }] });
    const { rpc, dispose } = bind(h);
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

      await h.internals._execSend({ to: "worker-1", content: "write it" });
      await waitFor(() => rpc.eventsOf("ask.pending").length > 0);
      expect(rpc.eventsOf("ask.pending")[0]).toMatchObject({ id: "approval-child" });
    } finally {
      dispose();
      h.dispose();
    }
  });

  it("resolving an ask emits ask.resolved", async () => {
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "write_file", arguments: {} }] },
        { text: "done" },
      ],
      tools: [testToolDef("write_file")],
    });
    const { rpc, dispose } = bind(h);
    try {
      stageApprovalGate(h, "write_file");
      await rpc.call("session.submitTurn", { input: "write it" });
      await waitFor(() => rpc.eventsOf("ask.pending").length > 0);
      h.session.resolveApprovalAsk("approval-test-1", 0);
      await waitFor(() => rpc.eventsOf("ask.resolved").length > 0);
    } finally {
      dispose();
      h.dispose();
    }
  });
});

describe("projected log over RPC", () => {
  it("getProjectedLog returns the canonical TUI projection, JSON-serializable", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "hello there" }] });
    const { rpc, dispose } = bind(h);
    try {
      await h.session.turn("hi");
      const result = await rpc.call("session.getProjectedLog") as {
        revision: number;
        activeLogEntryId: string | null;
        entries: Array<{ kind: string; text: string }>;
      };
      expect(result.revision).toBe(h.session.getLogRevision());
      const expected = projectToTuiEntries([...h.session.log] as LogEntry[]);
      expect(result.entries).toEqual(expected as never);
      expect(result.entries.some((e) => e.kind === "user")).toBe(true);
      expect(result.entries.some((e) => e.kind === "assistant" && e.text.includes("hello there"))).toBe(true);
      // The wire payload must survive JSON round-trip losslessly.
      expect(JSON.parse(JSON.stringify(result))).toEqual(result as never);
    } finally {
      dispose();
      h.dispose();
    }
  });

  it("getProjectedChildLog projects a child session's log", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "noted" }] });
    const { rpc, dispose } = bind(h);
    try {
      const childProvider = new ScriptedProvider();
      childProvider.rounds = [{ text: "child says hi" }];
      const childAgent = makeScriptedAgentObject(childProvider, { name: "worker-1" });
      const handle = h.internals._instantiateChildSession("worker-1", "explorer", "persistent", childAgent);
      h.internals._childSessions.set("worker-1", handle);
      await h.internals._execSend({ to: "worker-1", content: "say hi" });
      await waitFor(() => handle.lastOutcome === "completed");

      const entries = await rpc.call("session.getProjectedChildLog", { childId: "worker-1" }) as Array<{ kind: string; text: string }>;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.some((e) => e.kind === "assistant" && e.text.includes("child says hi"))).toBe(true);

      const missing = await rpc.call("session.getProjectedChildLog", { childId: "nope" });
      expect(missing).toBeNull();
    } finally {
      dispose();
      h.dispose();
    }
  });
});
