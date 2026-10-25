/**
 * D20：turn 索引的构建、校验、增量追加与失效。
 */

import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TURN_INDEX_FILENAME,
  TURN_INDEX_VERSION,
  appendTurnIndex,
  buildTurnIndex,
  deleteTurnIndex,
  readTurnIndex,
  writeTurnIndex,
} from "../../src/session/turn-index.js";
import {
  createSystemPrompt,
  createToolResult,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-turn-index-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fileMutation(path: string, additions = 1, deletions = 0) {
  return createToolResult(
    `tr-${path}`,
    1,
    0,
    { toolCallId: `call-${path}`, toolName: "apply_patch", content: "ok", toolSummary: "ok" },
    { isError: false, toolMetadata: { fileMutation: { path, additions, deletions } } },
  );
}

function makeEntries(): LogEntry[] {
  return [
    createSystemPrompt("sys-1", 0, "system"),
    createTurnStart("ts-1", 1),
    createUserMessage("user-1", 1, "first", "first", "ctx-a"),
    fileMutation("a.ts", 2, 1),
    createTurnStart("ts-2", 2),
    createUserMessage("user-2", 2, "second", "second", "ctx-b"),
  ];
}

describe("turn 索引", () => {
  it("从完整条目构建 turn + mutation 摘要", () => {
    const data = buildTurnIndex(makeEntries());
    expect(data.turns.map((turn) => turn.turnIndex)).toEqual([1, 2]);
    expect(data.turns.map((turn) => turn.entryId)).toEqual(["ts-1", "ts-2"]);
    expect(data.mutations).toEqual([
      { entryId: "tr-a.ts", turnIndex: 1, path: "a.ts", additions: 2, deletions: 1, reverted: false },
    ]);
  });

  it("写入后 source_seq 一致才可读；不一致返回 null", () => {
    const dir = makeDir();
    writeTurnIndex(dir, buildTurnIndex(makeEntries()), 12);
    expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(true);
    expect(readTurnIndex(dir, 12)?.turns).toHaveLength(2);
    expect(readTurnIndex(dir, 11)).toBeNull();
  });

  it("增量追加 turn/mutation/revert；before_seq 不符则拒绝", () => {
    const dir = makeDir();
    writeTurnIndex(dir, buildTurnIndex(makeEntries()), 6);

    const ok = appendTurnIndex(dir, 6, [
      { v: TURN_INDEX_VERSION, op: "turn", turn: {
        turnIndex: 3, entryId: "ts-3", entryIndex: 6, kind: "user", preview: "(turn 3)", timestamp: 3,
      }},
      { v: TURN_INDEX_VERSION, op: "mutation", mutation: {
        entryId: "tr-b.ts", turnIndex: 3, path: "b.ts", additions: 1, deletions: 0, reverted: false,
      }},
      { v: TURN_INDEX_VERSION, op: "revert", entryId: "tr-a.ts" },
    ], 7);
    expect(ok).toBe(true);

    const updated = readTurnIndex(dir, 7)!;
    expect(updated.turns.map((turn) => turn.entryId)).toEqual(["ts-1", "ts-2", "ts-3"]);
    expect(updated.mutations.find((mutation) => mutation.entryId === "tr-a.ts")?.reverted).toBe(true);
    expect(updated.mutations.find((mutation) => mutation.entryId === "tr-b.ts")?.path).toBe("b.ts");

    expect(appendTurnIndex(dir, 6, [], 8)).toBe(false);
  });

  it("丢弃 mutation 与删除索引", () => {
    const dir = makeDir();
    writeTurnIndex(dir, buildTurnIndex(makeEntries()), 6);
    expect(appendTurnIndex(dir, 6, [
      { v: TURN_INDEX_VERSION, op: "drop-mutation", entryId: "tr-a.ts" },
    ], 7)).toBe(true);
    expect(readTurnIndex(dir, 7)?.mutations).toEqual([]);

    deleteTurnIndex(dir);
    expect(readTurnIndex(dir, 7)).toBeNull();
  });

  it("drop-turn 只移除该 turn；无同号 turn 时一并清掉其 mutation", () => {
    const dir = makeDir();
    writeTurnIndex(dir, buildTurnIndex(makeEntries()), 6);
    expect(appendTurnIndex(dir, 6, [
      { v: TURN_INDEX_VERSION, op: "mutation", mutation: {
        entryId: "tr-b.ts", turnIndex: 2, path: "b.ts", additions: 1, deletions: 0, reverted: false,
      }},
      { v: TURN_INDEX_VERSION, op: "drop-turn", entryId: "ts-2" },
    ], 7)).toBe(true);

    const updated = readTurnIndex(dir, 7)!;
    expect(updated.turns.map((turn) => turn.entryId)).toEqual(["ts-1"]);
    expect(updated.mutations.map((mutation) => mutation.entryId)).toEqual(["tr-a.ts"]);
  });

  it("drop-turns-from 丢弃该 turnIndex 及之后的 turn/mutation", () => {
    const dir = makeDir();
    writeTurnIndex(dir, buildTurnIndex(makeEntries()), 6);
    expect(appendTurnIndex(dir, 6, [
      { v: TURN_INDEX_VERSION, op: "mutation", mutation: {
        entryId: "tr-b.ts", turnIndex: 2, path: "b.ts", additions: 1, deletions: 0, reverted: false,
      }},
      { v: TURN_INDEX_VERSION, op: "drop-turns-from", turnIndex: 2 },
    ], 7)).toBe(true);

    const updated = readTurnIndex(dir, 7)!;
    expect(updated.turns.map((turn) => turn.entryId)).toEqual(["ts-1"]);
    expect(updated.mutations.map((mutation) => mutation.entryId)).toEqual(["tr-a.ts"]);
  });

  it("set-revert 可双向翻转", () => {
    const dir = makeDir();
    writeTurnIndex(dir, buildTurnIndex(makeEntries()), 6);
    expect(appendTurnIndex(dir, 6, [
      { v: TURN_INDEX_VERSION, op: "set-revert", entryId: "tr-a.ts", reverted: true },
    ], 7)).toBe(true);
    expect(readTurnIndex(dir, 7)?.mutations[0]?.reverted).toBe(true);

    expect(appendTurnIndex(dir, 7, [
      { v: TURN_INDEX_VERSION, op: "set-revert", entryId: "tr-a.ts", reverted: false },
    ], 8)).toBe(true);
    expect(readTurnIndex(dir, 8)?.mutations[0]?.reverted).toBe(false);
  });

  it("损坏行被跳过，索引仍可用", () => {
    const dir = makeDir();
    writeTurnIndex(dir, buildTurnIndex(makeEntries()), 6);
    appendTurnIndex(dir, 6, [
      { v: TURN_INDEX_VERSION, op: "turn", turn: {
        turnIndex: 3, entryId: "ts-3", entryIndex: 6, kind: "user", preview: "(turn 3)", timestamp: 3,
      }},
    ], 7);
    const file = join(dir, TURN_INDEX_FILENAME);
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(file, "{ broken\n");
    expect(readTurnIndex(dir, 7)?.turns).toHaveLength(3);
  });
});
