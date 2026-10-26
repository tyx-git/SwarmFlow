/**
 * R-2 有界模型上下文：反向扫到最新 live compact_marker，返回 marker 及之后的窗口。
 * 期望值来自有界模型上下文窗口的读取约定，不来自实现。
 */

import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_JSONL_FILENAME,
  LOG_JSONL_VERSION,
  appendRecords,
  loadLogJsonl,
  loadModelContext,
  readLastSeq,
  writeLogJsonlSnapshot,
} from "../../src/config/log-jsonl.js";
import { entryToSnake } from "../../src/config/log-codec.js";
import { saveSessionMeta, createLogSessionMeta, type LogSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createSystemPrompt,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

const tempDirs: string[] = [];
const TS = "2026-10-23T00:00:00.000Z";

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-model-context-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<LogSessionMeta> = {}): LogSessionMeta {
  return createLogSessionMeta({
    sessionId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: TS,
    projectPath: "/work/demo",
    modelConfigName: "test-model",
    summary: "summary",
    turnCount: 3,
    compactCount: 1,
    thinkingLevel: "off",
    idCounters: { sys: 1, user: 2, asst: 2, cm: 2, cc: 2, tok: 5, askq: 9 },
    workCount: 4,
    tokens: { input: 100, output: 10, cacheRead: 80 },
    ...overrides,
  });
}

function seed(dir: string, entries: LogEntry[], meta = makeMeta()): void {
  writeLogJsonlSnapshot(dir, meta, entries);
  saveSessionMeta(dir, meta);
}

function markerIndex(entries: readonly LogEntry[]): number {
  let index = -1;
  entries.forEach((entry, i) => {
    if (entry.type === "compact_marker" && !entry.discarded) index = i;
  });
  return index;
}

const PRE = [
  createSystemPrompt("sys-001", 0, "system"),
  createUserMessage("user-001", 1, "old", "old", "ctx-a"),
  createAssistantText("asst-001", 1, 0, "old answer", "old answer"),
];
const MARKER = createCompactMarker("cm-001", 2, 0, 5000, 500);
const WINDOW = [
  createCompactContext("cc-001", 2, "briefing", "ctx-b", 0),
  createUserMessage("user-002", 2, "new", "new", "ctx-b"),
  createAssistantText("asst-002", 2, 0, "new answer", "new answer"),
];

describe("loadModelContext", () => {
  it("只返回最新 live marker 及之后，与全量重放的窗口深度相等", () => {
    const dir = makeDir();
    seed(dir, [...PRE, MARKER, ...WINDOW]);
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "patch",
      seq: readLastSeq(dir) + 1,
      ts: TS,
      ids: ["asst-002"],
      flags: { discarded: true },
    }]);

    const full = loadLogJsonl(dir).entries;
    const expected = full.slice(markerIndex(full));
    const ctx = loadModelContext(dir);

    expect(ctx.bounded).toBe(true);
    expect(ctx.entries).toEqual(expected);
    expect(ctx.entries[0].id).toBe("cm-001");
    expect(ctx.warnings).toEqual([]);
    const raw = readFileSync(join(dir, LOG_JSONL_FILENAME), "utf-8");
    expect(ctx.windowStartOffset).toBeGreaterThan(0);
    expect(raw.slice(ctx.windowStartOffset, ctx.windowStartOffset + 300)).toContain("cm-001");
  });

  it("压缩时补写的已归档 upsert（marker 之后落盘）不进入窗口", () => {
    const dir = makeDir();
    seed(dir, [...PRE, MARKER, ...WINDOW]);
    // 真实压缩顺序：marker 先落盘，随后 archiveEntries 把标记前条目的归档态 upsert 到文件尾。
    const archived = { ...PRE[2], content: null, archived: true, display: "", meta: { contextId: "ctx-a" } };
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: readLastSeq(dir) + 1,
      ts: TS,
      entries: [entryToSnake(archived as LogEntry)],
    }]);

    const full = loadLogJsonl(dir).entries;
    const ctx = loadModelContext(dir);
    expect(ctx.bounded).toBe(true);
    expect(ctx.entries).toEqual(full.slice(markerIndex(full)));
    expect(ctx.entries.some((entry) => entry.id === "asst-001")).toBe(false);
  });

  it("最新 marker 已 discarded：退回上一个 live marker", () => {
    const dir = makeDir();
    const discardedMarker = createCompactMarker("cm-002", 3, 1, 900, 100);
    discardedMarker.discarded = true;
    seed(dir, [
      ...PRE,
      MARKER,
      createCompactContext("cc-001", 2, "briefing", "ctx-b", 0),
      createUserMessage("user-002", 2, "new", "new", "ctx-b"),
      discardedMarker,
      createCompactContext("cc-002", 3, "briefing 2", "ctx-c", 1),
    ]);

    const full = loadLogJsonl(dir).entries;
    const ctx = loadModelContext(dir);
    expect(ctx.bounded).toBe(true);
    expect(ctx.entries).toEqual(full.slice(markerIndex(full)));
    expect(ctx.entries[0].id).toBe("cm-001");
  });

  it("truncate 把最新 marker 及其后条目截掉：以更早的 live marker 为界", () => {
    const dir = makeDir();
    const secondMarker = createCompactMarker("cm-002", 3, 1, 900, 100);
    seed(dir, [
      ...PRE,
      MARKER,
      createCompactContext("cc-001", 2, "briefing", "ctx-b", 0),
      createUserMessage("user-002", 2, "new", "new", "ctx-b"),
      secondMarker,
      createCompactContext("cc-002", 3, "briefing 2", "ctx-c", 1),
      createAssistantText("asst-003", 3, 0, "later", "later"),
    ]);
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "truncate",
      seq: readLastSeq(dir) + 1,
      ts: TS,
      fromEntryId: "user-002",
    }]);

    const full = loadLogJsonl(dir).entries;
    const ctx = loadModelContext(dir);
    expect(ctx.bounded).toBe(true);
    expect(ctx.entries).toEqual(full.slice(markerIndex(full)));
    expect(ctx.entries.map((entry) => entry.id)).toEqual(["cm-001", "cc-001"]);
  });

  it("truncate 连 marker 一起截掉：无 marker 时回退全量", () => {
    const dir = makeDir();
    seed(dir, [...PRE, MARKER, ...WINDOW]);
    appendRecords(dir, [{
      v: LOG_JSONL_VERSION,
      op: "truncate",
      seq: readLastSeq(dir) + 1,
      ts: TS,
      fromEntryId: "sys-001",
    }]);

    const full = loadLogJsonl(dir).entries;
    const ctx = loadModelContext(dir);
    expect(full).toEqual([]);
    expect(ctx.bounded).toBe(false);
    expect(ctx.entries).toEqual([]);
  });

  it("没有 marker 的会话：回退全量，行为与整读一致", () => {
    const dir = makeDir();
    seed(dir, [...PRE, ...WINDOW], makeMeta({ compactCount: 0 }));

    const full = loadLogJsonl(dir).entries;
    const ctx = loadModelContext(dir);
    expect(ctx.bounded).toBe(false);
    expect(ctx.entries).toEqual(full);
  });

  it("计数器从 meta.json 恢复：窗口内缺失的前缀不会重新从 001 开始", () => {
    const dir = makeDir();
    seed(dir, [...PRE, MARKER, ...WINDOW]);

    const ctx = loadModelContext(dir);
    expect(ctx.meta.workCount).toBe(4);
    expect(ctx.idAllocator.next("ask_request")).toBe("askq-010");
    expect(ctx.idAllocator.next("tool_call")).toBe("tc-001");
  });

  it("meta.json 缺计数器：退回全量读取（bounded=false）", () => {
    const dir = makeDir();
    const meta = makeMeta();
    delete meta.idCounters;
    delete meta.workCount;
    seed(dir, [...PRE, MARKER, ...WINDOW], meta);

    const ctx = loadModelContext(dir);
    expect(ctx.bounded).toBe(false);
    expect(ctx.entries).toEqual(loadLogJsonl(dir).entries);
  });

  it("读取字节有界：窗口很小时只扫尾部块", () => {
    const dir = makeDir();
    const big: LogEntry[] = [];
    for (let i = 0; i < 3000; i += 1) {
      big.push(createAssistantText(`asst-${1000 + i}`, 1, i, "x".repeat(400), "x".repeat(400)));
    }
    seed(dir, [...big, MARKER, ...WINDOW]);

    const ctx = loadModelContext(dir);
    const fileBytes = statSync(join(dir, LOG_JSONL_FILENAME)).size;
    expect(ctx.bounded).toBe(true);
    expect(ctx.scannedBytes).toBeLessThan(fileBytes / 2);
    expect(ctx.scannedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(ctx.entries[0].id).toBe("cm-001");
  });

  it("尾部半条记录：忽略并标记 repairedTail", () => {
    const dir = makeDir();
    seed(dir, [...PRE, MARKER, ...WINDOW]);
    appendFileSync(join(dir, LOG_JSONL_FILENAME), `{"v":${LOG_JSONL_VERSION},"op":"upsert","seq":99`);

    const ctx = loadModelContext(dir);
    expect(ctx.bounded).toBe(true);
    expect(ctx.repairedTail).toBe(true);
    expect(ctx.entries.map((entry) => entry.id)).toEqual(["cm-001", "cc-001", "user-002", "asst-002"]);
  });
});
