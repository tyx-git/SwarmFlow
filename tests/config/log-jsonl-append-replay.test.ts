/**
 * W-1 追加、重放、崩溃尾行与写放大契约。
 * 期望值来自 LOG_WRITE_DESIGN.md §W4/§W5/§W6，不来自实现。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_JSONL_FILENAME,
  LOG_JSONL_VERSION,
  appendRecords,
  loadLogJsonl,
  nextSeq,
  readLastSeq,
  readRecords,
  replayRecords,
  serializeRecord,
  type JsonlRecord,
  type SessionRecord,
  type UpsertRecord,
} from "../../src/config/log-jsonl.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-jsonl-append-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function sessionRecord(seq = 1): SessionRecord {
  return {
    v: LOG_JSONL_VERSION,
    op: "session",
    seq,
    ts: "2026-10-23T00:00:00.000Z",
    session: {
      session_id: "s-1",
      created_at: "2026-10-23T00:00:00Z",
      updated_at: "2026-10-23T00:00:00Z",
      project_path: "/work/demo",
      model_config_name: "test-model",
      summary: "",
      title: "Demo",
      turn_count: 0,
      compact_count: 0,
      thinking_level: "medium",
    },
  };
}

function rawEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "assistant_text",
    timestamp: 1,
    turn_index: 0,
    tui_visible: true,
    display_kind: null,
    display: `display-${id}`,
    api_role: "assistant",
    content: `content-${id}`,
    archived: false,
    meta: {},
    ...overrides,
  };
}

function upsert(seq: number, entries: Record<string, unknown>[]): UpsertRecord {
  return { v: LOG_JSONL_VERSION, op: "upsert", seq, ts: "2026-10-23T00:00:01.000Z", entries };
}

function seed(dir: string): void {
  appendRecords(dir, [sessionRecord(1), upsert(2, [rawEntry("asst-1")])]);
}

describe("追加语义", () => {
  it("新文件必须先写 session 记录", () => {
    // 正例先行：合法的首条 session 必须能写进去。
    const validDir = makeDir();
    expect(appendRecords(validDir, [sessionRecord(1)]).appendedRecords).toBe(1);

    const dir = makeDir();
    expect(() => appendRecords(dir, [upsert(1, [rawEntry("asst-1")])])).toThrow();
  });

  it("第二次追加不重写已有字节", () => {
    const dir = makeDir();
    seed(dir);
    const file = join(dir, LOG_JSONL_FILENAME);
    const before = readFileSync(file);

    const result = appendRecords(dir, [upsert(3, [rawEntry("asst-2")])]);
    const after = readFileSync(file);

    expect(result.appendedRecords).toBe(1);
    expect(result.appendedBytes).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
  });

  it("已有文件时再追加 session 记录：拒绝", () => {
    const dir = makeDir();
    seed(dir);
    const file = join(dir, LOG_JSONL_FILENAME);
    const before = readFileSync(file);

    expect(() => appendRecords(dir, [sessionRecord(3)])).toThrow();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("文件中间出现 session 记录：读取告警并忽略该记录", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, LOG_JSONL_FILENAME),
      [
        serializeRecord(sessionRecord(1)),
        serializeRecord(upsert(2, [rawEntry("asst-1")])),
        serializeRecord({ ...sessionRecord(3), session: { ...sessionRecord(3).session, title: "Injected" } }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const read = readRecords(dir);
    expect(read.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(read.warnings.some((warning) => /session/i.test(warning))).toBe(true);
  });

  it("空批次不写盘", () => {
    const dir = makeDir();
    seed(dir);
    const file = join(dir, LOG_JSONL_FILENAME);
    const before = readFileSync(file);

    const result = appendRecords(dir, []);
    expect(result).toEqual({ appendedBytes: 0, appendedRecords: 0 });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("一次批次只产生一次文件增长，且记录数正确", () => {
    const dir = makeDir();
    seed(dir);
    const before = statSync(join(dir, LOG_JSONL_FILENAME)).size;

    appendRecords(dir, [upsert(3, [rawEntry("a"), rawEntry("b")]), upsert(4, [rawEntry("c")])]);
    const after = statSync(join(dir, LOG_JSONL_FILENAME)).size;
    expect(after).toBeGreaterThan(before);

    const read = readRecords(dir);
    expect(read.records.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
    expect(read.warnings).toEqual([]);
    expect(read.repairedTail).toBe(false);
  });
});

describe("崩溃与坏行", () => {
  it("半条尾行被忽略并标记 repairedTail；下一次追加先补齐换行", () => {
    const dir = makeDir();
    seed(dir);
    appendFileSync(join(dir, LOG_JSONL_FILENAME), '{"v":4,"op":"ups', "utf-8");

    const first = readRecords(dir);
    expect(first.repairedTail).toBe(true);
    expect(first.warnings.some((warning) => /partial|tail|尾/i.test(warning))).toBe(true);
    expect(first.records.map((record) => record.seq)).toEqual([1, 2]);

    appendRecords(dir, [upsert(3, [rawEntry("asst-2")])]);
    const second = readRecords(dir);
    expect(second.repairedTail).toBe(false);
    expect(second.records.map((record) => record.seq)).toEqual([1, 2, 3]);
  });

  it("最后一行是完整 JSON 但缺换行：照常读取，下一次追加补齐换行", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, LOG_JSONL_FILENAME),
      [
        serializeRecord(sessionRecord(1)),
        serializeRecord(upsert(2, [rawEntry("asst-1")])),
      ].join("\n"),
      "utf-8",
    );

    const first = readRecords(dir);
    expect(first.repairedTail).toBe(false);
    expect(first.records.map((record) => record.seq)).toEqual([1, 2]);

    appendRecords(dir, [upsert(3, [rawEntry("asst-2")])]);
    expect(readRecords(dir).records.map((record) => record.seq)).toEqual([1, 2, 3]);
  });

  it("中间坏行跳过并告警，后续记录仍可读", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, LOG_JSONL_FILENAME),
      [
        serializeRecord(sessionRecord(1)),
        "not-a-json-line",
        serializeRecord(upsert(3, [rawEntry("asst-1")])),
        "",
      ].join("\n"),
      "utf-8",
    );

    const read = readRecords(dir);
    expect(read.records.map((record) => record.seq)).toEqual([1, 3]);
    expect(read.warnings.some((warning) => /invalid|坏|skip/i.test(warning))).toBe(true);
  });

  it("readLastSeq 能读取仅 header 的单行文件", () => {
    const dir = makeDir();
    appendRecords(dir, [sessionRecord(1)]);
    expect(readLastSeq(dir)).toBe(1);
    expect(() => appendRecords(dir, [upsert(2, [rawEntry("asst-1")])])).not.toThrow();
  });

  it("写入器拒绝 seq 跳号、重复与首条非 1", () => {
    const dir = makeDir();
    seed(dir);
    expect(() => appendRecords(dir, [upsert(4, [rawEntry("asst-gap")])])).toThrow(/seq/i);
    expect(() => appendRecords(dir, [upsert(2, [rawEntry("asst-dup")])])).toThrow(/seq/i);

    const emptyDir = makeDir();
    expect(() => appendRecords(emptyDir, [sessionRecord(2)])).toThrow(/seq/i);
  });

  it("seq 跳号只告警，不阻塞加载", () => {
    const dir = makeDir();
    // 直接落盘构造 gap：写入器本身应拒绝非连续 seq，读取器则要容忍已存在的缺口。
    writeFileSync(
      join(dir, LOG_JSONL_FILENAME),
      [
        serializeRecord(sessionRecord(1)),
        serializeRecord(upsert(3, [rawEntry("asst-1")])),
        "",
      ].join("\n"),
      "utf-8",
    );
    const read = readRecords(dir);
    expect(read.warnings.some((warning) => /seq/i.test(warning))).toBe(true);
    expect(replayRecords(read.records).entries.map((entry) => entry.id)).toEqual(["asst-1"]);
  });

  it("seq 重复只告警；同一 id 以文件顺序后者为准", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, LOG_JSONL_FILENAME),
      [
        serializeRecord(sessionRecord(1)),
        serializeRecord(upsert(2, [rawEntry("asst-1", { content: "first" })])),
        serializeRecord(upsert(2, [rawEntry("asst-1", { content: "second" })])),
        "",
      ].join("\n"),
      "utf-8",
    );
    const read = readRecords(dir);
    expect(read.warnings.some((warning) => /seq|duplicate/i.test(warning))).toBe(true);
    const replayed = replayRecords(read.records);
    expect(replayed.entries).toHaveLength(1);
    expect(replayed.entries[0].content).toBe("second");
  });
});

describe("重放语义", () => {
  it("session 记录映射为 LogSessionMeta", () => {
    const replayed = replayRecords([sessionRecord(1)]);
    expect(replayed.meta.sessionId).toBe("s-1");
    expect(replayed.meta.title).toBe("Demo");
    expect(replayed.meta.projectPath).toBe("/work/demo");
  });

  it("同 id 多次 upsert：最后一条生效", () => {
    const replayed = replayRecords([
      sessionRecord(1),
      upsert(2, [rawEntry("asst-1", { content: "v1" })]),
      upsert(3, [rawEntry("asst-1", { content: "v2" })]),
    ]);
    expect(replayed.entries).toHaveLength(1);
    expect(replayed.entries[0].content).toBe("v2");
  });

  it("patch 合并闭集 flags，并按 RETAINED_ARCHIVED_META_KEYS 剥 presentation", () => {
    const replayed = replayRecords([
      sessionRecord(1),
      upsert(2, [rawEntry("asst-1", {
        display: "hello",
        meta: {
          contextId: "c1",
          providerRoundId: "p1",
          fileMutationReverted: false,
          heavy: "x".repeat(1000),
        },
      })]),
      {
        v: 5, op: "patch", seq: 3, ts: "t",
        ids: ["asst-1"],
        flags: { archived: true, discarded: true, fileMutationReverted: true, bashMutationRevertedIndices: [0, 2] },
        dropPresentation: true,
      },
    ]);

    expect(replayed.entries[0].archived).toBe(true);
    expect(replayed.entries[0].discarded).toBe(true);
    expect(replayed.entries[0].display).toBe("");
    expect(replayed.entries[0].meta).toEqual({
      contextId: "c1",
      providerRoundId: "p1",
      fileMutationReverted: true,
      bashMutationRevertedIndices: [0, 2],
    });
  });

  it("patch 指向不存在的条目：告警但不抛错", () => {
    const replayed = replayRecords([
      sessionRecord(1),
      upsert(2, [rawEntry("asst-1")]),
      { v: 5, op: "patch", seq: 3, ts: "t", ids: ["missing"], flags: { archived: true } },
    ]);
    expect(replayed.entries.map((entry) => entry.id)).toEqual(["asst-1"]);
  });

  it("truncate 删除该条目及其之后；之后追加的条目保留", () => {
    const replayed = replayRecords([
      sessionRecord(1),
      upsert(2, [rawEntry("a"), rawEntry("b")]),
      { v: 5, op: "truncate", seq: 3, ts: "t", fromEntryId: "b" },
      upsert(4, [rawEntry("c")]),
    ]);
    expect(replayed.entries.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("compact_marker 的 discarded 翻转以最后一次 upsert 为准", () => {
    const marker = (discarded: boolean) => rawEntry("cm-1", { type: "compact_marker", discarded });
    const replayed = replayRecords([
      sessionRecord(1),
      upsert(2, [marker(true)]),
      upsert(3, [marker(false)]),
      upsert(4, [rawEntry("asst-1")]),
    ]);
    const live = replayed.entries.find((entry) => entry.id === "cm-1");
    expect(live?.discarded).toBeUndefined();
  });

  it("loadLogJsonl 与 replayRecords 返回一致的 entries", () => {
    const dir = makeDir();
    seed(dir);
    const replayed = replayRecords(readRecords(dir).records);
    const loaded = loadLogJsonl(dir);
    expect(loaded.meta.sessionId).toBe(replayed.meta.sessionId);
    expect(loaded.entries).toEqual(replayed.entries);
  });
});

describe("写放大", () => {
  it("追加一条只增加该条目的字节，不重写整份", () => {
    const dir = makeDir();
    const entries = Array.from({ length: 100 }, (_, index) =>
      rawEntry(`asst-${index}`, { content: "x".repeat(2000) }),
    );
    appendRecords(dir, [sessionRecord(1), upsert(2, entries)]);

    const file = join(dir, LOG_JSONL_FILENAME);
    const before = readFileSync(file);
    const beforeSize = before.length;

    appendRecords(dir, [upsert(3, [rawEntry("asst-99", { content: "changed" })])]);
    const after = readFileSync(file);

    expect(after.subarray(0, beforeSize).equals(before)).toBe(true);
    const delta = after.length - beforeSize;
    expect(delta).toBeLessThan(8 * 1024);
    expect(delta).toBeLessThan(beforeSize / 10);
  });
});

describe("nextSeq", () => {
  it("空日志从 1 开始；否则最大 seq + 1", () => {
    expect(nextSeq([])).toBe(1);
    expect(nextSeq([sessionRecord(1), upsert(7, [rawEntry("a")])])).toBe(8);
  });

  it("不因坏记录回退", () => {
    const records: JsonlRecord[] = [sessionRecord(3), upsert(9, [rawEntry("a")])];
    expect(nextSeq(records)).toBe(10);
  });
});
