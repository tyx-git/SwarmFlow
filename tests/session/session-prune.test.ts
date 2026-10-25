/**
 * D22：显式 prune 只删除 archive 有正文副本（或 discarded/旧 marker）的前缀。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveWindow } from "../../src/config/archive.js";
import { loadLogJsonl, writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta, type LogSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createCompactMarker,
  createSystemPrompt,
  createTurnEnd,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { pruneSessionDirectory } from "../../src/session/session-prune.js";
import { TURN_INDEX_FILENAME } from "../../src/session/turn-index.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-prune-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function meta(turnCount: number): LogSessionMeta {
  return createLogSessionMeta({
    sessionId: "s-prune",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    projectPath: "/work/demo",
    modelConfigName: "test-model",
    summary: "prune",
    title: "Prune",
    turnCount,
    compactCount: 2,
    thinkingLevel: "off",
  });
}

function makeEntries(): LogEntry[] {
  return [
    createSystemPrompt("sys-1", 0, "system"),
    createTurnStart("ts-old", 1),
    createUserMessage("u-old", 1, "old", "old", "ctx-old"),
    createAssistantText("a-old", 1, 0, "old answer", "old answer"),
    createTurnEnd("te-old", 1, "completed"),
    createCompactMarker("cm-old", 2, 0, 100, 0),
    createCompactMarker("cm-live", 3, 0, 100, 0),
    createTurnStart("ts-new", 3),
    createUserMessage("u-new", 3, "new", "new", "ctx-new"),
    createAssistantText("a-new", 3, 0, "new answer", "new answer"),
    createTurnEnd("te-new", 3, "completed"),
  ];
}

/** 旧 turn 已归档；旧 marker 无正文；返回日志原始字节。 */
function seedPrunable(dir: string): { entries: LogEntry[]; before: number } {
  const entries = makeEntries();
  const archivedIds = archiveWindow(dir, 0, entries, 1, 4);
  for (const id of archivedIds) {
    const entry = entries.find((item) => item.id === id)!;
    entry.archived = true;
    entry.content = null;
  }
  writeLogJsonlSnapshot(dir, meta(3), entries);
  writeFileSync(join(dir, TURN_INDEX_FILENAME), "{}\n");
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "big.bin"), "x".repeat(2_000));
  mkdirSync(join(dir, "sealed"), { recursive: true });
  writeFileSync(join(dir, "sealed", "r.json.gz"), "y".repeat(500));
  return { entries, before: statSync(join(dir, "log.jsonl")).size };
}

describe("显式 prune", () => {
  it("dry-run 不写盘；实际 prune 删除已归档前缀并保留 marker 与活动窗口", () => {
    const dir = makeDir();
    const { before } = seedPrunable(dir);

    const dry = pruneSessionDirectory(dir, { dryRun: true });
    expect(dry).toMatchObject({
      ok: true,
      pruned: true,
      dryRun: true,
      droppedEntries: 5,
      droppedUserTurns: [1],
      logBytesBefore: before,
    });
    expect(statSync(join(dir, "log.jsonl")).size).toBe(before);
    expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(true);

    const result = pruneSessionDirectory(dir);
    expect(result).toMatchObject({
      ok: true,
      pruned: true,
      droppedEntries: 5,
      droppedUserTurns: [1],
      entriesAfter: 6,
    });
    if (result.ok) {
      expect(result.logBytesAfter).toBeLessThan(before);
      expect(result.archiveBytes).toBeGreaterThan(0);
      expect(result.artifactsBytes).toBe(2_000);
      expect(result.sealedBytes).toBe(500);
    }
    expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(false);
    expect(existsSync(join(dir, "archive", "window-0.json.gz"))).toBe(true);
    expect(loadLogJsonl(dir).entries.map((entry) => entry.id)).toEqual([
      "sys-1", "cm-live", "ts-new", "u-new", "a-new", "te-new",
    ]);
  });

  it("marker 前有未归档正文时拒绝并保持日志不变", () => {
    const dir = makeDir();
    const entries = [
      createSystemPrompt("sys-1", 0, "system"),
      createAssistantText("a-unarchived", 1, 0, "keep", "keep"),
      createCompactMarker("cm-live", 2, 0, 100, 0),
    ];
    writeLogJsonlSnapshot(dir, meta(1), entries);
    const before = statSync(join(dir, "log.jsonl")).size;

    const result = pruneSessionDirectory(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("a-unarchived");
    expect(statSync(join(dir, "log.jsonl")).size).toBe(before);
  });

  it("没有 live marker 时不清理", () => {
    const dir = makeDir();
    writeLogJsonlSnapshot(dir, meta(1), [
      createSystemPrompt("sys-1", 0, "system"),
      createUserMessage("u-1", 1, "hi", "hi", "ctx"),
    ]);
    const result = pruneSessionDirectory(dir);
    expect(result).toMatchObject({ ok: true, pruned: false, reason: "no-live-marker" });
  });

  it("未超过 maxLogBytes 时不清理", () => {
    const dir = makeDir();
    const { before } = seedPrunable(dir);
    const result = pruneSessionDirectory(dir, { maxLogBytes: before + 1 });
    expect(result).toMatchObject({ ok: true, pruned: false, reason: "below-threshold" });
    expect(statSync(join(dir, "log.jsonl")).size).toBe(before);
  });
});
