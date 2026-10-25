/**
 * W-1 格式契约：log.jsonl 的 header、记录形状、校验与解析。
 * 期望值来自 LOG_WRITE_DESIGN.md §W3，不来自实现。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionMetaFromSnake } from "../../src/config/log-codec.js";
import {
  LOG_JSONL_FILENAME,
  LOG_JSONL_VERSION,
  parseRecordLine,
  readLogHeader,
  serializeRecord,
  type JsonlRecord,
  type SessionRecord,
  type UpsertRecord,
} from "../../src/config/log-jsonl.js";

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    v: LOG_JSONL_VERSION,
    op: "session",
    seq: 1,
    ts: "2026-10-23T00:00:00.000Z",
    session: {
      session_id: "01900000-0000-7000-8000-000000000001",
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
    ...overrides,
  };
}

function upsertRecord(seq = 2, entries: Record<string, unknown>[] = [rawEntry()]): UpsertRecord {
  return { v: LOG_JSONL_VERSION, op: "upsert", seq, ts: "2026-10-23T00:00:01.000Z", entries };
}

function rawEntry(id = "asst-1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "assistant_text",
    timestamp: 1,
    turn_index: 0,
    tui_visible: true,
    display_kind: null,
    display: "hello",
    api_role: "assistant",
    content: "hello",
    archived: false,
    meta: {},
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-jsonl-format-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("log.jsonl 常量", () => {
  it("文件名与版本固定", () => {
    expect(LOG_JSONL_FILENAME).toBe("log.jsonl");
    expect(LOG_JSONL_VERSION).toBe(4);
  });
});

describe("记录序列化与解析", () => {
  it("session/upsert 往返不丢字段", () => {
    const session = sessionRecord();
    expect(parseRecordLine(serializeRecord(session))).toEqual(session);

    const upsert = upsertRecord(2, [
      rawEntry("asst-1", { content: "中文内容 with emoji 🙂 and \n escaped" }),
      rawEntry("rsn-1", { type: "reasoning" }),
    ]);
    expect(parseRecordLine(serializeRecord(upsert))).toEqual(upsert);
  });

  it("序列化结果是单行 JSON，不含裸换行", () => {
    const line = serializeRecord(upsertRecord(2, [rawEntry("asst-1", { content: "a\nb" })]));
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
  });

  it("upsert.replaces 只允许 true（缺省=创建）", () => {
    expect(() => serializeRecord({ ...upsertRecord(), replaces: false } as unknown as JsonlRecord)).toThrow();
    expect(serializeRecord({ ...upsertRecord(), replaces: true })).toContain('"replaces":true');
  });

  it("解析允许一个尾随换行", () => {
    const line = serializeRecord(sessionRecord());
    expect(parseRecordLine(`${line}\n`)).toEqual(sessionRecord());
    expect(parseRecordLine(`${line}\r\n`)).toEqual(sessionRecord());
  });

  it.each([
    ["非 JSON", "not json"],
    ["非对象", "[1,2,3]"],
    ["null", "null"],
    ["缺 v", JSON.stringify({ op: "session", seq: 1, ts: "t", session: {} })],
    ["版本不是 4", JSON.stringify({ ...sessionRecord(), v: 3 })],
    ["缺 op", JSON.stringify({ v: 4, seq: 1, ts: "t" })],
    ["未知 op", JSON.stringify({ v: 4, op: "append", seq: 1, ts: "t" })],
    ["seq 非正整数", JSON.stringify({ ...sessionRecord(), seq: 0 })],
    ["seq 小数", JSON.stringify({ ...sessionRecord(), seq: 1.5 })],
    ["seq 字符串", JSON.stringify({ ...sessionRecord(), seq: "1" })],
    ["ts 缺失", JSON.stringify({ ...sessionRecord(), ts: undefined })],
    ["ts 非字符串", JSON.stringify({ ...sessionRecord(), ts: 123 })],
    ["upsert 无 entries", JSON.stringify({ v: 4, op: "upsert", seq: 2, ts: "t" })],
    ["upsert entries 为空", JSON.stringify({ v: 4, op: "upsert", seq: 2, ts: "t", entries: [] })],
    ["upsert entries 非数组", JSON.stringify({ v: 4, op: "upsert", seq: 2, ts: "t", entries: {} })],
    ["patch 无 ids", JSON.stringify({ v: 4, op: "patch", seq: 2, ts: "t" })],
    ["patch ids 为空", JSON.stringify({ v: 4, op: "patch", seq: 2, ts: "t", ids: [] })],
    ["patch ids 非字符串", JSON.stringify({ v: 4, op: "patch", seq: 2, ts: "t", ids: [1] })],
    ["patch 未知 flag", JSON.stringify({ v: 4, op: "patch", seq: 2, ts: "t", ids: ["a"], flags: { oops: true } })],
    ["truncate 无 fromEntryId", JSON.stringify({ v: 4, op: "truncate", seq: 2, ts: "t" })],
    ["usage 无 totals", JSON.stringify({ v: 4, op: "usage", seq: 2, ts: "t" })],
    ["usage totals 字段非数字", JSON.stringify({ v: 4, op: "usage", seq: 2, ts: "t", totals: { input: "1", output: 0, cacheRead: 0 } })],
  ])("拒绝非法记录：%s", (_label, line) => {
    // 正例先行：若实现缺失或正例都解析不了，这条测试必须红，而不是被 toThrow 吃掉。
    expect(parseRecordLine(serializeRecord(sessionRecord()))).toEqual(sessionRecord());
    expect(() => parseRecordLine(line)).toThrow();
  });
});

describe("header 读取", () => {
  it("只读第一行；第二行是坏 JSON 也能拿到 header", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, LOG_JSONL_FILENAME),
      `${serializeRecord(sessionRecord())}\nnot-json-at-all\n`,
      "utf-8",
    );

    const header = readLogHeader(dir);
    expect(header.sessionId).toBe("01900000-0000-7000-8000-000000000001");
    expect(header.title).toBe("Demo");
    expect(header.turnCount).toBe(0);
  });

  it("第一行不是 session 记录时拒绝", () => {
    const dir = makeDir();
    writeFileSync(join(dir, LOG_JSONL_FILENAME), `${serializeRecord(upsertRecord(2))}\n`, "utf-8");
    expect(() => readLogHeader(dir)).toThrow();
  });

  it("文件不存在时报错，而不是返回空 header", () => {
    // 正例先行。
    const validDir = makeDir();
    writeFileSync(join(validDir, LOG_JSONL_FILENAME), `${serializeRecord(sessionRecord())}\n`, "utf-8");
    expect(readLogHeader(validDir).sessionId).toBe("01900000-0000-7000-8000-000000000001");

    const dir = makeDir();
    expect(() => readLogHeader(dir)).toThrow();
  });
});

describe("session 元数据的可选字段", () => {
  it("磁盘上的 null 恢复为 undefined（与 legacy 读取一致）", () => {
    const meta = sessionMetaFromSnake({
      model_provider: null,
      model_selection_key: null,
      model_id: null,
      initial_model: null,
      title: null,
      prompt_cache_affinity_key: null,
    });
    expect(meta.modelProvider).toBeUndefined();
    expect(meta.modelSelectionKey).toBeUndefined();
    expect(meta.modelId).toBeUndefined();
    expect(meta.initialModel).toBeUndefined();
    expect(meta.title).toBeUndefined();
    expect(meta.promptCacheAffinityKey).toBeUndefined();
  });
});

describe("类型面", () => {
  it("JsonlRecord 是五种 op 的联合", () => {
    const records: JsonlRecord[] = [
      sessionRecord(),
      upsertRecord(2),
      { v: 4, op: "patch", seq: 3, ts: "t", ids: ["a"], flags: { archived: true }, dropPresentation: true },
      { v: 4, op: "truncate", seq: 4, ts: "t", fromEntryId: "user-1" },
      { v: 4, op: "usage", seq: 5, ts: "t", totals: { input: 1, output: 2, cacheRead: 3 } },
    ];
    expect(records.map((record) => record.op)).toEqual([
      "session",
      "upsert",
      "patch",
      "truncate",
      "usage",
    ]);
  });
});
