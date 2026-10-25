/**
 * P0-1 红测：压缩提交期间监听器抛错，不得留下
 * “live marker=0 且旧窗口 archived+content=null”的永久空洞。
 *
 * 修复目标：监听器异常不得从提交路径冒泡；提交后最多是 TUI 未刷新，
 * 不能把已归档的旧窗口连同 marker/context 一起丢弃。
 */

import { readRecords } from "../../src/config/log-jsonl.js";
import { describe, expect, it } from "vitest";

import { makeScriptedSession } from "../helpers/session-harness.js";

const LONG_CONTINUATION = "continuation briefing for the next turn. ".repeat(8);

describe("compact commit atomicity", () => {
  it("a throwing log listener cannot create a permanent context hole", async () => {
    const h = makeScriptedSession({
      rounds: [{ text: "reply one" }, { text: LONG_CONTINUATION }],
    });
    try {
      await h.session.turn("one");

      const unsubscribe = h.session.subscribeLog(() => {
        const log = h.session.log;
        const hasLiveMarker = log.some((entry) => entry.type === "compact_marker" && !entry.discarded);
        const hasArchivedNull = log.some((entry) => entry.archived && entry.content === null);
        if (hasLiveMarker && hasArchivedNull) {
          throw new Error("listener boom after archive flip");
        }
      });

      let failure: unknown;
      try {
        await h.session.runManualCompact();
      } catch (error) {
        failure = error;
      } finally {
        unsubscribe();
      }

      const liveMarkers = h.session.log.filter(
        (entry) => entry.type === "compact_marker" && !entry.discarded,
      );
      const archivedNull = h.session.log.filter((entry) => entry.archived && entry.content === null);
      const liveContexts = h.session.log.filter(
        (entry) => entry.type === "compact_context" && !entry.discarded,
      );

      if (failure) {
        // 允许完整回滚：旧窗口必须仍然完整可投影，不能 archived+null。
        expect(archivedNull).toHaveLength(0);
        expect(liveContexts).toHaveLength(0);
      } else {
        // 允许提交：marker 与 context 必须成对存活。
        expect(liveMarkers).toHaveLength(1);
        expect(liveContexts).toHaveLength(1);
      }
      expect(liveMarkers.length === 0 && archivedNull.length > 0).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("persists marker + context as one compact_checkpoint record", async () => {
    const h = makeScriptedSession({
      rounds: [{ text: "reply one" }, { text: LONG_CONTINUATION }],
    });
    try {
      await h.session.turn("one");
      await h.session.runManualCompact();
      expect(h.session.persistToDisk()).toBe(true);

      const sessionDir = h.internals._store.sessionDir as string;
      const records = readRecords(sessionDir).records;
      expect(records.some((record) => record.op === "compact_checkpoint")).toBe(true);

      const separatePairs = records.filter((record) => {
        if (record.op !== "upsert") return false;
        return record.entries.some((entry) => entry.type === "compact_marker" || entry.type === "compact_context");
      });
      expect(separatePairs).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });
});
