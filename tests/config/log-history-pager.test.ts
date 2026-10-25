/**
 * R-3 TUI 历史分页器：页序、补丁/截断、字节上限与尾行容错。
 */

import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOG_JSONL_FILENAME, LOG_JSONL_VERSION, appendRecords, loadLogJsonl, loadModelContext } from "../../src/config/log-jsonl.js";
import { entryToSnake } from "../../src/config/log-codec.js";
import { openTuiHistoryPager } from "../../src/config/log-history.js";
import { createLogSessionMeta, saveSessionMeta } from "../../src/config/session-meta.js";
import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createAssistantText, createCompactContext, createCompactMarker, createSystemPrompt, createUserMessage } from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

const tempDirs: string[] = [];
const TS = "2026-10-23T00:00:00.000Z";

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-history-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function seed(dir: string, entries: LogEntry[]): void {
  const meta = createLogSessionMeta({
    sessionId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: TS,
    projectPath: "/work/demo",
    modelConfigName: "test-model",
    summary: "s",
    turnCount: 1,
    compactCount: 0,
    thinkingLevel: "off",
    idCounters: { user: 10, asst: 10, cm: 1, cc: 1 },
    workCount: 0,
    tokens: { input: 100, output: 10, cacheRead: 80 },
  });
  writeLogJsonlSnapshot(dir, meta, entries);
  saveSessionMeta(dir, meta);
}

function readPages(dir: string, maxEntries: number, maxBytes?: number): { pages: LogEntry[][]; scanned: number[] } {
  const pager = openTuiHistoryPager(dir, { maxEntries, maxBytes });
  const pages: LogEntry[][] = [];
  const scanned: number[] = [];
  try {
    for (let i = 0; i < 1000; i += 1) {
      const page = pager.nextPage();
      pages.push(page.entries);
      scanned.push(page.scannedBytes);
      if (!page.hasMore) break;
    }
  } finally {
    pager.close();
  }
  return { pages, scanned };
}

function flatten(pages: LogEntry[][]): LogEntry[] {
  return pages.slice().reverse().flat();
}

function makeEntries(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? createUserMessage(`user-${i + 1}`, 1, `m${i}`, `m${i}`, "ctx-1")
      : createAssistantText(`asst-${i + 1}`, 1, i, `m${i}`, `m${i}`),
  );
}

describe("TUI 历史分页器", () => {
  it("页序连续、无重复，拼起来等于全量重放", () => {
    const dir = makeDir();
    const entries = makeEntries(23);
    seed(dir, entries);

    const { pages } = readPages(dir, 5);
    expect(pages.map((page) => page.length)).toEqual([5, 5, 5, 5, 3]);
    expect(flatten(pages).map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    expect(flatten(pages)).toEqual(loadLogJsonl(dir).entries);
  });

  it("补丁（discarded/archived/dropPresentation）在翻页时生效", () => {
    const dir = makeDir();
    seed(dir, makeEntries(5));
    appendRecords(dir, [
      { v: LOG_JSONL_VERSION, op: "patch", seq: 7, ts: TS, ids: ["asst-2"], flags: { discarded: true, archived: true } },
      { v: LOG_JSONL_VERSION, op: "patch", seq: 8, ts: TS, ids: ["user-3"], flags: { archived: true }, dropPresentation: true },
    ]);

    const { pages } = readPages(dir, 10);
    const entries = flatten(pages);
    expect(entries).toEqual(loadLogJsonl(dir).entries);
    expect(entries.find((entry) => entry.id === "asst-2")?.discarded).toBe(true);
    const stripped = entries.find((entry) => entry.id === "user-3")!;
    expect(stripped.display).toBe("");
    expect(stripped.meta["contextId"]).toBe("ctx-1");
  });

  it("同一 id 的较新 upsert 覆盖旧值，不重复输出", () => {
    const dir = makeDir();
    seed(dir, makeEntries(3));
    const updated = { ...makeEntries(1)[0]!, id: "user-1", display: "updated", content: "updated" };
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: 5,
      ts: TS,
      entries: [entryToSnake(updated as LogEntry)],
      replaces: true,
    }]);

    const { pages } = readPages(dir, 10);
    const entries = flatten(pages);
    expect(entries.map((entry) => entry.id)).toEqual(["user-1", "asst-2", "user-3"]);
    expect(entries[0].display).toBe("updated");
  });

  it("truncate 跨页：被截断的条目不出现", () => {
    const dir = makeDir();
    seed(dir, makeEntries(10));
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "truncate",
      seq: 12,
      ts: TS,
      fromEntryId: "user-7",
    }]);

    const full = loadLogJsonl(dir).entries;
    const { pages } = readPages(dir, 2);
    expect(flatten(pages)).toEqual(full);
    expect(flatten(pages).some((entry) => entry.id === "user-7")).toBe(false);
  });

  it("字节上限：大条目按 maxBytes 切页", () => {
    const dir = makeDir();
    const big = Array.from({ length: 6 }, (_, i) =>
      createAssistantText(`asst-${i + 1}`, 1, i, "x".repeat(100_000), "x".repeat(100_000)),
    );
    seed(dir, big);

    const { pages } = readPages(dir, 100, 250_000);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(3);
    expect(flatten(pages)).toEqual(loadLogJsonl(dir).entries);
  });

  it("第一页只读尾部块，不全读", () => {
    const dir = makeDir();
    const big = Array.from({ length: 2000 }, (_, i) =>
      createAssistantText(`asst-${i + 1}`, 1, i, "x".repeat(400), "x".repeat(400)),
    );
    seed(dir, big);
    const size = statSync(join(dir, LOG_JSONL_FILENAME)).size;

    const { pages, scanned } = readPages(dir, 200);
    expect(pages[0]).toHaveLength(200);
    expect(scanned[0]).toBeLessThan(size / 2);
    expect(scanned[0]).toBeLessThanOrEqual(256 * 1024);
  });

  it("从窗口起点翻页：只返回历史，不含 marker 与活动窗口", () => {
    const dir = makeDir();
    const history = makeEntries(5);
    seed(dir, [...history, createCompactMarker("cm-001", 2, 0, 100, 10), createCompactContext("cc-001", 2, "b", "ctx-b", 0)]);
    const ctx = loadModelContext(dir);
    expect(ctx.bounded).toBe(true);

    const { pages } = (() => {
      const pager = openTuiHistoryPager(dir, { maxEntries: 2, startOffset: ctx.windowStartOffset });
      const result: LogEntry[][] = [];
      try {
        for (let i = 0; i < 100; i += 1) {
          const page = pager.nextPage();
          result.push(page.entries);
          if (!page.hasMore) break;
        }
      } finally {
        pager.close();
      }
      return { pages: result };
    })();

    expect(flatten(pages).map((entry) => entry.id)).toEqual(history.map((entry) => entry.id));
  });

  it("replaces 跨页：内容更新但位置仍在创建处", () => {
    const dir = makeDir();
    seed(dir, makeEntries(6));
    const updated = { ...makeEntries(1)[0]!, display: "updated", content: "updated" };
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: 8,
      ts: TS,
      entries: [entryToSnake(updated as LogEntry)],
      replaces: true,
    }]);

    const { pages } = readPages(dir, 2);
    expect(pages.map((page) => page.map((entry) => entry.id))).toEqual([
      ["user-5", "asst-6"],
      ["user-3", "asst-4"],
      ["user-1", "asst-2"],
    ]);
    const all = flatten(pages);
    expect(all).toEqual(loadLogJsonl(dir).entries);
    expect(all[0].display).toBe("updated");
  });

  it("字节上限按更新后的内容计：大 replaces 会在它之后切页", () => {
    const dir = makeDir();
    seed(dir, makeEntries(10));
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: 12,
      ts: TS,
      entries: [entryToSnake(createAssistantText("asst-6", 1, 0, "x".repeat(120_000), "x".repeat(120_000)))],
      replaces: true,
    }]);

    const { pages } = readPages(dir, 100, 100_000);
    // 反向扫描：asst-10..asst-7 先累积，更新后的 asst-6（120 KB）越界即收页；
    // 修复前按创建行（很小）计数，会把更早的 asst-5..asst-1 也塞进同一页。
    expect(pages).toHaveLength(2);
    expect(pages[0].map((entry) => entry.id)).toEqual(["asst-6", "user-7", "asst-8", "user-9", "asst-10"]);
    expect(flatten(pages)).toEqual(loadLogJsonl(dir).entries);
  });

  it("尾部半条记录：忽略并标记 repairedTail", () => {
    const dir = makeDir();
    seed(dir, makeEntries(4));
    appendFileSync(join(dir, LOG_JSONL_FILENAME), `{"v":${LOG_JSONL_VERSION},"op":"upsert","seq":99`);

    const pager = openTuiHistoryPager(dir, { maxEntries: 10 });
    try {
      const page = pager.nextPage();
      expect(page.entries.map((entry) => entry.id)).toEqual(["user-1", "asst-2", "user-3", "asst-4"]);
      expect(pager.repairedTailSoFar).toBe(true);
    } finally {
      pager.close();
    }
  });
});
