/**
 * Released one-shot children — a settled one-shot child drops its Session
 * (the in-memory log goes with it); the Agents panel serves the frozen
 * snapshot and the child tab reads the log back from disk. Persistent
 * children keep their Session for revival.
 */

import { describe, expect, it } from "bun:test";

import type { LogEntry } from "../src/log-entry.js";
import { loadLog, validateAndRepairLog } from "../src/persistence.js";
import {
  ScriptedProvider,
  makeScriptedAgentObject,
  makeScriptedSession,
  waitFor,
  type SessionHarness,
} from "./helpers/session-harness.js";

function makeChild(h: SessionHarness, mode: "oneshot" | "persistent", replyText: string) {
  const childProvider = new ScriptedProvider();
  childProvider.rounds = [{ text: replyText }];
  const childAgent = makeScriptedAgentObject(childProvider, { name: "worker-1" });
  const handle = h.internals._instantiateChildSession("worker-1", "explorer", mode, childAgent);
  h.internals._childSessions.set("worker-1", handle);
  return { handle, childProvider };
}

describe("one-shot child release", () => {
  it("settling releases the Session, freezes the snapshot, and serves the log from disk", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const { handle } = makeChild(h, "oneshot", "child reply alpha");
      const manager = h.internals._childSessionManagerInstance;
      manager._startChildTurn(handle, "do the thing", {});
      await waitFor(() => handle.lifecycle === "archived");

      // Released: Session gone, snapshot frozen.
      expect(handle.session).toBeNull();
      expect(handle.frozenSnapshot).toBeTruthy();
      expect(handle.lastOutcome).toBe("completed");

      // Agents panel still lists it with the settled state.
      const snapshot = h.session.getChildSessionSnapshots().find((s: { id: string }) => s.id === "worker-1");
      expect(snapshot).toMatchObject({
        id: "worker-1",
        lifecycle: "archived",
        outcome: "completed",
        running: false,
        mode: "oneshot",
      });

      // Child tab: log served from disk, with the conversation intact.
      const log = h.session.getChildSessionLog("worker-1");
      expect(log).not.toBeNull();
      expect(log!.some((e) => e.type === "assistant_text" && String(e.display).includes("child reply alpha"))).toBe(true);
      // Stable array identity across polls (single-slot cache) so the TUI
      // projection memo holds.
      expect(h.session.getChildSessionLog("worker-1")).toBe(log!);
      // getAgentLog goes through the same disk-capable path.
      expect(h.session.getAgentLog("worker-1")).toBe(log!);

      // Root-level ask scan and permission propagation tolerate the null.
      expect(h.session.getPendingAsk()).toBeNull();
      h.session.permissionMode = "yolo";
    } finally {
      h.dispose();
    }
  });

  it("root persistence keeps working after a one-shot is released", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const { handle } = makeChild(h, "oneshot", "child says bye");
      const manager = h.internals._childSessionManagerInstance;
      manager._startChildTurn(handle, "go", {});
      await waitFor(() => handle.lifecycle === "archived");
      expect(handle.session).toBeNull();

      // The released handle stays in the live table for the rest of the root
      // session — every subsequent root save walks it.
      const persisted = h.session.getLogForPersistence();
      expect(JSON.stringify(persisted.meta)).toContain("worker-1");
    } finally {
      h.dispose();
    }
  });

  it("the released-log cache is keyed by sessionDir and dropped on table reset", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const { handle } = makeChild(h, "oneshot", "cache subject");
      const manager = h.internals._childSessionManagerInstance;
      manager._startChildTurn(handle, "go", {});
      await waitFor(() => handle.lifecycle === "archived");

      const log = h.session.getChildSessionLog("worker-1");
      expect(log!.length).toBeGreaterThan(0);

      // Same id, different session dir (the /new / /resume shape) must not
      // serve the cached entries.
      const phantom = { ...handle, sessionDir: handle.sessionDir + "-elsewhere" };
      expect(manager._loadReleasedChildLog(phantom)).toEqual([]);

      // Fresh-session reset drops the slot entirely.
      manager.clearTables();
      expect(manager._releasedLogCache).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it("a failed settle-time save keeps the Session resident (no stale disk copy served)", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const { handle } = makeChild(h, "oneshot", "unsaved words");
      h.internals._saveChildSession = () => false;
      const manager = h.internals._childSessionManagerInstance;
      manager._startChildTurn(handle, "go", {});
      await waitFor(() => handle.lifecycle === "archived");

      expect(handle.session).not.toBeNull();
      expect(handle.frozenSnapshot ?? null).toBeNull();
      // The in-memory log still serves the tab.
      const log = h.session.getChildSessionLog("worker-1");
      expect(log!.some((e) => e.type === "assistant_text" && String(e.display).includes("unsaved words"))).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("persistent children keep their Session after settling", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const { handle } = makeChild(h, "persistent", "persistent reply");
      const manager = h.internals._childSessionManagerInstance;
      manager._startChildTurn(handle, "do the thing", {});
      await waitFor(() => handle.lifecycle === "idle");

      expect(handle.session).not.toBeNull();
      expect(handle.frozenSnapshot ?? null).toBeNull();
      expect(h.session.getChildSessionLog("worker-1")).toBe(handle.session.log);
    } finally {
      h.dispose();
    }
  });

  it("restore brings settled one-shot children back released", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      // Produce a settled child with a persisted log...
      const { handle } = makeChild(h, "oneshot", "restored child words");
      const manager = h.internals._childSessionManagerInstance;
      manager._startChildTurn(handle, "go", {});
      await waitFor(() => handle.lifecycle === "archived");
      const sessionDir = handle.sessionDir as string;

      // ...then restore it from disk the way commitPreparedChildren does.
      h.internals._childSessions.delete("worker-1");
      const loaded = loadLog(sessionDir);
      const repaired = validateAndRepairLog(loaded.entries);
      const warnings = manager.commitPreparedChildren([{
        record: {
          id: "worker-1",
          numericId: handle.numericId,
          template: "explorer",
          mode: "oneshot",
          lifecycle: "archived",
          outcome: "completed",
          order: handle.order,
        },
        agent: makeScriptedAgentObject(new ScriptedProvider(), { name: "worker-1" }),
        sessionDir,
        artifactsDir: handle.artifactsDir,
        loaded: { ...loaded, entries: repaired.entries as LogEntry[] },
      }]);
      expect(warnings).toEqual([]);

      const restored = h.internals._childSessions.get("worker-1");
      expect(restored).toBeTruthy();
      expect(restored.session).toBeNull();
      expect(restored.frozenSnapshot).toBeTruthy();
      const log = h.session.getChildSessionLog("worker-1");
      expect(log!.some((e) => e.type === "assistant_text" && String(e.display).includes("restored child words"))).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
