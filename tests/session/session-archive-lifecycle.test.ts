/** Archive lifecycle for compact-window content and rewind restoration. */

import { describe, expect, it } from "vitest";
import { createCompactMarker } from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { archiveWindow } from "../../src/config/archive.js";
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

      archiveWindow(sessionDir, 0, log, start, end);
      for (const id of originals.keys()) {
        const entry = log.find((item) => item.id === id)!;
        expect(entry.content).toBeNull();
        expect(entry.archived).toBe(true);
      }
      h.internals._appendEntry(createCompactMarker("cm-test-0", 2, 0, 100, 0), false);

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

  it("degrades silently when the archive file is missing", async () => {
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
      h.internals._appendEntry(createCompactMarker("cm-test-7", 2, 7, 100, 0), false);

      const result = h.session.rewindConversation(2);
      expect(result.error).toBeUndefined();
      for (const id of archivedIds) {
        const entry = h.session.log.find((item) => item.id === id)!;
        expect(entry.archived).toBe(true);
        expect(entry.content).toBeNull();
      }
    } finally {
      h.dispose();
    }
  });
});
