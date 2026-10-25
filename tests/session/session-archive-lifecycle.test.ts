/** Archive lifecycle for compact-window content and rewind restoration. */

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantText, createCompactMarker } from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { archiveWindow } from "../../src/config/archive.js";
import { SessionLog } from "../../src/session/log.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

function turnRange(log: readonly LogEntry[], turnIndex: number): { start: number; end: number } {
  let start = -1;
  let end = -1;
  for (let i = 0; i < log.length; i++) {
    if (log[i].turnIndex !== turnIndex) continue;
    if (start < 0) start = i;
    end = i;
  }
  return { start, end };
}

function captureContents(log: readonly LogEntry[], start: number, end: number): Map<string, unknown> {
  const captured = new Map<string, unknown>();
  for (let i = start; i <= end; i++) {
    const entry = log[i];
    if (entry.content !== null && !entry.archived) {
      captured.set(entry.id, JSON.parse(JSON.stringify(entry.content)));
    }
  }
  return captured;
}

describe("rewind across a compact marker", () => {
  it("restores archived window content for the revived entries", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "reply one" }, { text: "reply two" }] });
    try {
      await h.session.turn("one");
      await h.session.turn("two");

      const log = h.session.log as LogEntry[];
      const sessionDir = h.internals._store.sessionDir as string;
      const { start, end } = turnRange(log, 1);
      const originals = captureContents(log, start, end);
      expect(originals.size).toBeGreaterThan(0);

      const checkpointId = "cm-test-0";
      const archivedIds = archiveWindow(sessionDir, checkpointId, log, start, end);
      h.internals._logStore.archiveEntries(archivedIds);
      for (const id of originals.keys()) {
        const entry = log.find((item) => item.id === id)!;
        expect(entry.content).toBeNull();
        expect(entry.archived).toBe(true);
      }
      const marker = createCompactMarker(checkpointId, 2, 0, 100, 0);
      marker.meta["checkpointId"] = checkpointId;
      marker.meta["archiveFile"] = `window-${checkpointId}.jsonl.gz`;
      h.internals._appendEntry(marker, false);

      const result = h.session.rewindConversation(2);
      expect(result.error).toBeUndefined();
      expect(h.session.log.some((entry) => entry.type === "compact_marker")).toBe(false);
      for (const [id, content] of originals) {
        const entry = h.session.log.find((item) => item.id === id);
        expect(entry).toBeDefined();
        expect(entry!.archived).toBe(false);
        expect(entry!.content).toEqual(content as never);
      }
    } finally {
      h.dispose();
    }
  });

  it("fails rewind when the archive file is missing", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "reply one" }, { text: "reply two" }] });
    try {
      await h.session.turn("one");
      await h.session.turn("two");

      const log = h.session.log as LogEntry[];
      const { start, end } = turnRange(log, 1);
      const archivedIds: string[] = [];
      for (let i = start; i <= end; i++) {
        const entry = log[i];
        if (entry.content !== null) {
          entry.content = null;
          entry.archived = true;
          archivedIds.push(entry.id);
        }
      }
      expect(archivedIds.length).toBeGreaterThan(0);
      const marker = createCompactMarker("cm-test-7", 2, 7, 100, 0);
      marker.meta["checkpointId"] = marker.id;
      marker.meta["archiveFile"] = "window-cm-test-7.jsonl.gz";
      h.internals._appendEntry(marker, false);

      const result = h.session.rewindConversation(2);
      expect(result.error).toMatch(/archive .*missing/i);
      expect(h.session.log.some((entry) => entry.type === "compact_marker")).toBe(true);
      for (const id of archivedIds) {
        const entry = h.session.log.find((item) => item.id === id)!;
        expect(entry.archived).toBe(true);
        expect(entry.content).toBeNull();
      }
    } finally {
      h.dispose();
    }
  });

  it("fails rewind when the archive file is corrupt", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "reply one" }, { text: "reply two" }] });
    try {
      await h.session.turn("one");
      await h.session.turn("two");

      const log = h.session.log as LogEntry[];
      const { start, end } = turnRange(log, 1);
      for (let i = start; i <= end; i++) {
        const entry = log[i];
        if (entry.content !== null) {
          entry.content = null;
          entry.archived = true;
        }
      }
      const marker = createCompactMarker("cm-corrupt", 2, 0, 100, 0);
      marker.meta["archiveFile"] = "window-cm-corrupt.jsonl.gz";
      h.internals._appendEntry(marker, false);
      const archiveDir = join(h.internals._store.sessionDir as string, "archive");
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, "window-cm-corrupt.jsonl.gz"), Buffer.from("not gzip"));

      const result = h.session.rewindConversation(2);
      expect(result.error).toMatch(/corrupt or unreadable/i);
      expect(h.session.log.some((entry) => entry.type === "compact_marker")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("restores archive content without overwriting runtime revert flags", () => {
    const live = createAssistantText("a-1", 1, 0, "new", "new", "ctx-1");
    live.archived = true;
    live.content = null;
    live.meta = { contextId: "ctx-1", fileMutationReverted: true };
    const gateway = new SessionLog();
    gateway.replace([live]);

    gateway.restoreArchivedEntries([{
      id: "a-1",
      content: "old",
      display: "old display",
      meta: { contextId: "ctx-1", toolMetadata: { fileMutation: { path: "/p" } } },
    }]);

    expect(live.archived).toBe(false);
    expect(live.content).toBe("old");
    expect(live.display).toBe("old display");
    expect(live.meta.fileMutationReverted).toBe(true);
    expect(live.meta.toolMetadata).toBeDefined();
  });
});
