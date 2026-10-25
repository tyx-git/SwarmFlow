/**
 * R-3 页缓存上限：已加载的更早历史最多 8 MiB，达到后停止并给出上限状态。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta, saveSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createCompactMarker,
  createSystemPrompt,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { applySessionRestore } from "../../src/session/resume.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-history-cache-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function seedBigHistory(): string {
  const dir = makeDir();
  const big = "x".repeat(1_000_000);
  const entries: LogEntry[] = [createSystemPrompt("sys-1", 0, "system")];
  for (let index = 1; index <= 9; index += 1) {
    entries.push(createAssistantText(`old-${index}`, 1, 0, big, big));
  }
  entries.push(createCompactMarker("cm-1", 2, 0, 100, 0));
  const meta = createLogSessionMeta({
    sessionId: "s-history-cache",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    projectPath: "/work/demo",
    modelConfigName: "gpt-test",
    summary: "",
    turnCount: 1,
    compactCount: 1,
    thinkingLevel: "off",
    idCounters: { sys: 1, asst: 9, cm: 1 },
    workCount: 0,
    tokens: { input: 100, output: 10, cacheRead: 80 },
  });
  writeLogJsonlSnapshot(dir, meta, entries);
  saveSessionMeta(dir, meta);
  return dir;
}

describe("历史页缓存上限", () => {
  it("加载到 8 MiB 后停止，并暴露 capped 状态", () => {
    const dir = seedBigHistory();
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.hasEarlierHistory()).toBe(true);

      let guard = 0;
      while (h.session.hasEarlierHistory() && guard < 20) {
        h.session.loadEarlierHistoryPage(200);
        guard += 1;
      }

      expect(h.session.isHistoryCacheCapped()).toBe(true);
      expect(h.session.hasEarlierHistory()).toBe(false);
      const loaded = h.session.getDisplayLog().length - h.session.log.length;
      expect(loaded).toBeGreaterThan(0);
      expect(loaded).toBeLessThan(9);
      expect(guard).toBeLessThan(20);
      expect(h.session.loadEarlierHistoryPage(200)).toMatchObject({ loaded: 0, hasMore: false });
    } finally {
      h.dispose();
    }
  });
});
