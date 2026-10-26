/**
 * D20 集成：有界会话的回退菜单优先走 turn 索引；索引失效时重建；增量保存更新索引。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLastSeq, writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta, saveSessionMeta, type LogSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createCompactContext,
  createSystemPrompt,
  createToolResult,
  createTurnEnd,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { applySessionRestore } from "../../src/session/resume.js";
import {
  TURN_INDEX_FILENAME,
  readTurnIndex,
  writeTurnIndex,
} from "../../src/session/turn-index.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-turn-index-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function toolResult(id: string, turnIndex: number, path: string, additions = 1, reverted = false): LogEntry {
  const entry = createToolResult(
    id,
    turnIndex,
    0,
    { toolCallId: `call-${id}`, toolName: "apply_patch", content: "ok", toolSummary: "ok" },
    { isError: false, toolMetadata: { fileMutation: { path, additions, deletions: 0 } } },
  );
  if (reverted) (entry.meta as Record<string, unknown>)["fileMutationReverted"] = true;
  return entry;
}

function makeEntries(): LogEntry[] {
  return [
    createSystemPrompt("sys-1", 0, "system"),
    createTurnStart("ts-1", 1),
    createUserMessage("user-1", 1, "first", "first", "ctx-a"),
    toolResult("tr-1", 1, "a.ts", 2),
    createAssistantText("asst-1", 1, 0, "a1", "a1"),
    createTurnEnd("te-1", 1, "completed"),
    createTurnStart("ts-2", 2),
    createUserMessage("user-2", 2, "second", "second", "ctx-b"),
    toolResult("tr-2", 2, "b.ts", 1, true),
    createAssistantText("asst-2", 2, 0, "a2", "a2"),
    createTurnEnd("te-2", 2, "completed"),
  ];
}

function makeMeta(bounded: boolean): LogSessionMeta {
  return createLogSessionMeta({
    sessionId: "s-turn-index",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    projectPath: "/work/demo",
    modelConfigName: "gpt-test",
    summary: "",
    turnCount: 2,
    compactCount: bounded ? 1 : 0,
    thinkingLevel: "off",
    ...(bounded
      ? {
        idCounters: { sys: 1, ts: 2, user: 2, asst: 2, tr: 2, te: 2, cm: 1, cc: 1 },
        workCount: 0,
        tokens: { input: 100, output: 10, cacheRead: 80 },
      }
      : {}),
  });
}

function markerEntry(turnIndex: number, id = "cm-1"): LogEntry {
  return withCheckpointMetadata({
    id,
    type: "compact_marker",
    timestamp: 1,
    turnIndex,
    tuiVisible: true,
    displayKind: null,
    display: "",
    apiRole: null,
    content: null,
    archived: false,
    meta: { compactIndex: 0, originalTokens: 1, compactedTokens: 0 },
  } as unknown as LogEntry);
}

function withCheckpointMetadata(entry: LogEntry): LogEntry {
  if (entry.type !== "compact_marker") return entry;
  const checkpointId = String((entry.meta as Record<string, unknown>)["checkpointId"] ?? entry.id);
  return {
    ...entry,
    meta: {
      ...(entry.meta as Record<string, unknown>),
      checkpointId,
      archiveFile: `window-${checkpointId}.jsonl.gz`,
      archiveIndexFile: `window-${checkpointId}.jsonl.gz`,
    },
  };
}

function checkpointContext(marker: LogEntry): LogEntry {
  const meta = marker.meta as Record<string, unknown>;
  const checkpointId = String(meta["checkpointId"]);
  const compactIndex = Number(meta["compactIndex"] ?? 0);
  return createCompactContext(
    `cc-${checkpointId.replace(/^cm-/, "")}`,
    marker.turnIndex,
    "checkpoint continuation",
    `ctx-${checkpointId}`,
    compactIndex,
  );
}

function normalizeCheckpointEntries(entries: LogEntry[]): LogEntry[] {
  const normalized: LogEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "compact_marker") {
      normalized.push(entry);
      continue;
    }
    const marker = withCheckpointMetadata(entry);
    normalized.push(marker);
    const next = entries[index + 1];
    if (next?.type === "compact_context") {
      normalized.push({
        ...next,
        meta: {
          ...(next.meta as Record<string, unknown>),
          checkpointId: (marker.meta as Record<string, unknown>)["checkpointId"],
        },
      });
      index += 1;
    } else {
      normalized.push(checkpointContext(marker));
    }
  }
  return normalized;
}

function seed(dir: string, meta: LogSessionMeta, entries: LogEntry[]): void {
  writeLogJsonlSnapshot(dir, meta, normalizeCheckpointEntries(entries));
  saveSessionMeta(dir, meta);
}

/** marker 放在最前：有界加载仍包含全部条目，便于对窗口内条目做 patch。 */
function entriesWithLeadingMarker(): LogEntry[] {
  return [createSystemPrompt("sys-1", 0, "system"), markerEntry(0), ...makeEntries().slice(1)];
}

describe("D20 回退菜单 turn 索引", () => {
  it("有界会话首开重建索引，结果与整读路径一致", () => {
    const boundedDir = makeDir();
    const entries = makeEntries();
    // 为有界加载插入 marker：放到 turn 2 之前会隐藏 turn1，改用末尾 marker 不改变回退列表。
    entries.push(createTurnStart("ts-3", 3), createUserMessage("user-3", 3, "third", "third", "ctx-c"), createTurnEnd("te-3", 3, "completed"));
    const marker = {
      id: "cm-1",
      type: "compact_marker",
      timestamp: 1,
      turnIndex: 3,
      tuiVisible: true,
      displayKind: null,
      display: "",
      apiRole: null,
      content: null,
      archived: false,
      meta: { compactIndex: 0, originalTokens: 1, compactedTokens: 0 },
    } as unknown as LogEntry;
    const boundedEntries = [...entries, marker];
    seed(boundedDir, makeMeta(true), boundedEntries);

    const fullDir = makeDir();
    seed(fullDir, makeMeta(false), [...entries, marker]);

    const bounded = makeScriptedSession();
    const full = makeScriptedSession();
    try {
      expect(applySessionRestore(bounded.session, bounded.internals._store, boundedDir).ok).toBe(true);
      expect(applySessionRestore(full.session, full.internals._store, fullDir).ok).toBe(true);

      const boundedTargets = bounded.session.getRewindTargets();
      expect(boundedTargets).toEqual(full.session.getRewindTargets());
      expect(existsSync(join(boundedDir, TURN_INDEX_FILENAME))).toBe(true);
      expect(readTurnIndex(boundedDir, readLastSeq(boundedDir))?.turns.map((turn) => turn.turnIndex)).toEqual([1, 2, 3]);
      // 第二次打开只读索引（文件仍在，seq 未变）。
      expect(bounded.session.getRewindTargets()).toEqual(boundedTargets);
    } finally {
      bounded.dispose();
      full.dispose();
    }
  });

  it("保存新 turn 时增量更新索引", () => {
    const dir = makeDir();
    seed(dir, makeMeta(true), [...makeEntries(), {
      id: "cm-1",
      type: "compact_marker",
      timestamp: 1,
      turnIndex: 2,
      tuiVisible: true,
      displayKind: null,
      display: "",
      apiRole: null,
      content: null,
      archived: false,
      meta: { compactIndex: 0, originalTokens: 1, compactedTokens: 0 },
    } as unknown as LogEntry]);
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);

      h.internals._appendEntry(createTurnStart("ts-3", 3), false);
      h.internals._appendEntry(createUserMessage("user-3", 3, "third", "third", "ctx-c"), false);
      h.internals._appendEntry(toolResult("tr-3", 3, "c.ts", 3), false);
      h.internals._appendEntry(createTurnEnd("te-3", 3, "completed"), false);
      expect(h.session.persistToDisk()).toBe(true);

      const seq = readLastSeq(dir);
      const index = readTurnIndex(dir, seq);
      expect(index?.turns.map((turn) => turn.entryId)).toEqual(["ts-1", "ts-2", "ts-3"]);
      expect(index?.mutations.map((mutation) => mutation.entryId)).toEqual(["tr-1", "tr-2", "tr-3"]);

      const targets = h.session.getRewindTargets();
      expect(targets.map((target) => target.turnIndex)).toEqual([3, 2, 1]);
      expect(targets[0]).toMatchObject({ additions: 3, fileCount: 1 });
    } finally {
      h.dispose();
    }
  });

  it("turn_end 批次补全该 turn 的完整记录与 mutation", () => {
    const dir = makeDir();
    const marker = {
      id: "cm-1", type: "compact_marker", timestamp: 1, turnIndex: 2,
      tuiVisible: true, displayKind: null, display: "", apiRole: null, content: null, archived: false,
      meta: { compactIndex: 0, originalTokens: 1, compactedTokens: 0 },
    } as unknown as LogEntry;
    seed(dir, makeMeta(true), [...makeEntries(), marker]);
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);

      // 新 turn 的边界先落盘，但暂时不在索引里。
      h.internals._appendEntry(createTurnStart("ts-3", 3), false);
      h.internals._appendEntry(createUserMessage("user-3", 3, "third", "third", "ctx-c"), false);
      h.internals._appendEntry(toolResult("tr-3", 3, "c.ts", 4), false);
      expect(h.session.persistToDisk()).toBe(true);
      const seqBeforeEnd = readLastSeq(dir);
      const withoutTurn3 = readTurnIndex(dir, seqBeforeEnd)!;
      writeTurnIndex(dir, {
        turns: withoutTurn3.turns.filter((turn) => turn.turnIndex !== 3),
        mutations: withoutTurn3.mutations.filter((mutation) => mutation.turnIndex !== 3),
      }, seqBeforeEnd);

      // 只追加 turn_end：同样要补全该 turn 记录与 mutation。
      h.internals._appendEntry(createTurnEnd("te-3", 3, "completed"), false);
      expect(h.session.persistToDisk()).toBe(true);

      const seq = readLastSeq(dir);
      const index = readTurnIndex(dir, seq);
      expect(index?.turns.find((turn) => turn.turnIndex === 3)?.entryId).toBe("ts-3");
      expect(index?.mutations.find((mutation) => mutation.entryId === "tr-3")).toMatchObject({
        path: "c.ts",
        additions: 4,
      });
    } finally {
      h.dispose();
    }
  });

  it("短会话首个 turn_end 自建索引（无需先打开回退菜单）", () => {
    const h = makeScriptedSession();
    try {
      const dir = h.internals._store.sessionDir as string;
      h.internals._appendEntry(createTurnStart("ts-1", 1), false);
      h.internals._appendEntry(createUserMessage("user-1", 1, "first", "first", "ctx-a"), false);
      h.internals._appendEntry(toolResult("tr-1", 1, "a.ts", 2), false);
      h.internals._appendEntry(createTurnEnd("te-1", 1, "completed"), false);
      expect(h.session.persistToDisk()).toBe(true); // 首次快照

      h.internals._appendEntry(createTurnStart("ts-2", 2), false);
      h.internals._appendEntry(createUserMessage("user-2", 2, "second", "second", "ctx-b"), false);
      h.internals._appendEntry(createTurnEnd("te-2", 2, "completed"), false);
      expect(h.session.persistToDisk()).toBe(true); // 增量 + turn_end 自建

      const index = readTurnIndex(dir, readLastSeq(dir));
      expect(index?.turns.map((turn) => turn.turnIndex)).toEqual([1, 2]);
    } finally {
      h.dispose();
    }
  });

  it("截断定向更新索引并得到正确结果", () => {
    const dir = makeDir();
    const marker = {
      id: "cm-1", type: "compact_marker", timestamp: 1, turnIndex: 2,
      tuiVisible: true, displayKind: null, display: "", apiRole: null, content: null, archived: false,
      meta: { compactIndex: 0, originalTokens: 1, compactedTokens: 0 },
    } as unknown as LogEntry;
    seed(dir, makeMeta(true), [...makeEntries(), marker]);
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);
      expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(true);

      expect(h.session.rewindConversation(2).error).toBeUndefined();
      expect(h.session.persistToDisk()).toBe(true);
      const index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.turns.map((turn) => turn.turnIndex)).toEqual([1]);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([1]);
    } finally {
      h.dispose();
    }
  });

  it("索引进度落后于日志时整读重建", () => {
    const dir = makeDir();
    seed(dir, makeMeta(true), [...makeEntries(), {
      id: "cm-1", type: "compact_marker", timestamp: 1, turnIndex: 2,
      tuiVisible: true, displayKind: null, display: "", apiRole: null, content: null, archived: false,
      meta: { compactIndex: 0, originalTokens: 1, compactedTokens: 0 },
    } as unknown as LogEntry]);
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      // 故意写一份落后一个 seq 的索引。
      writeTurnIndex(dir, { turns: [], mutations: [] }, readLastSeq(dir) - 1);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);
      expect(readTurnIndex(dir, readLastSeq(dir))?.turns).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });

  it("归档/presentation patch 不删除索引，旧 mutation 摘要保留", () => {
    const dir = makeDir();
    seed(dir, makeMeta(true), entriesWithLeadingMarker());
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);

      h.internals._logStore.patchFlags(["tr-1"], { archived: true }, { dropPresentation: true });
      expect(h.session.persistToDisk()).toBe(true);

      const index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.mutations.find((mutation) => mutation.entryId === "tr-1")).toMatchObject({
        path: "a.ts",
        additions: 2,
        deletions: 0,
      });
      expect(h.session.getRewindTargets().find((target) => target.turnIndex === 1)).toMatchObject({
        fileCount: 1,
        additions: 2,
      });
    } finally {
      h.dispose();
    }
  });

  it("文件回退标记通过 set-revert 双向更新索引", () => {
    const dir = makeDir();
    seed(dir, makeMeta(true), entriesWithLeadingMarker());
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);

      h.internals._logStore.patchFlags(["tr-1"], { fileMutationReverted: true });
      expect(h.session.persistToDisk()).toBe(true);
      let index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.mutations.find((mutation) => mutation.entryId === "tr-1")?.reverted).toBe(true);
      expect(h.session.getRewindTargets().find((target) => target.turnIndex === 1)?.filesReverted).toBe(true);

      h.internals._logStore.patchFlags(["tr-1"], { fileMutationReverted: false });
      expect(h.session.persistToDisk()).toBe(true);
      index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.mutations.find((mutation) => mutation.entryId === "tr-1")?.reverted).toBe(false);
      expect(h.session.getRewindTargets().find((target) => target.turnIndex === 1)).toMatchObject({
        fileCount: 1,
        filesReverted: false,
      });
    } finally {
      h.dispose();
    }
  });

  it("丢弃 turn 边界只移除该 turn，不删除索引", () => {
    const dir = makeDir();
    seed(dir, makeMeta(true), entriesWithLeadingMarker());
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);

      h.internals._logStore.patchFlags(["ts-2"], { discarded: true });
      expect(h.session.persistToDisk()).toBe(true);

      const index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.turns.map((turn) => turn.entryId)).toEqual(["ts-1"]);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([1]);
    } finally {
      h.dispose();
    }
  });

  it("丢弃 tool_result 只移除该 mutation，不删除索引", () => {
    const dir = makeDir();
    seed(dir, makeMeta(true), entriesWithLeadingMarker());
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);

      h.internals._logStore.patchFlags(["tr-1"], { discarded: true });
      expect(h.session.persistToDisk()).toBe(true);

      const index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.mutations.map((mutation) => mutation.entryId)).toEqual(["tr-2"]);
      expect(h.session.getRewindTargets().find((target) => target.turnIndex === 1)).toMatchObject({
        fileCount: 0,
        additions: 0,
      });
    } finally {
      h.dispose();
    }
  });

  it("未知 patch（discarded:false）回退为删除索引并重建", () => {
    const dir = makeDir();
    seed(dir, makeMeta(true), entriesWithLeadingMarker());
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);
      expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(true);

      h.internals._logStore.patchFlags(["ts-2"], { discarded: false });
      expect(h.session.persistToDisk()).toBe(false);
      expect(h.session.getPersistenceStatus()).toMatchObject({ dirty: true });
      expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(false);

      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);
      expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(true);
      expect(h.session.persistToDisk()).toBe(true);
      expect(h.session.getPersistenceStatus()).toMatchObject({ dirty: false });
    } finally {
      h.dispose();
    }
  });

  it("回退截断用 drop-turns-from 定向更新索引", () => {
    const dir = makeDir();
    // marker 放在 turn 1 之前：截断 turn 2 后仍保持有界恢复，可验证索引路径。
    seed(dir, makeMeta(true), entriesWithLeadingMarker());
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);
      expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(true);

      expect(h.session.rewindConversation(2).error).toBeUndefined();
      expect(h.session.persistToDisk()).toBe(true);

      const index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.turns.map((turn) => turn.entryId)).toEqual(["ts-1"]);
      expect(index?.mutations.map((mutation) => mutation.entryId)).toEqual(["tr-1"]);

      // 模拟原会话已关闭：释放写锁后由新 store 接管。
      h.internals._store.releaseSessionLock(dir);
      const reopened = makeScriptedSession();
      try {
        expect(applySessionRestore(reopened.session, reopened.internals._store, dir).ok).toBe(true);
        expect(reopened.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([1]);
      } finally {
        reopened.dispose();
      }
    } finally {
      h.dispose();
    }
  });

  it("首次快照立即构建索引", () => {
    const h = makeScriptedSession();
    try {
      const dir = h.internals._store.sessionDir as string;
      h.internals._appendEntry(createTurnStart("ts-1", 1), false);
      h.internals._appendEntry(createUserMessage("user-1", 1, "first", "first", "ctx-a"), false);
      h.internals._appendEntry(toolResult("tr-1", 1, "a.ts", 2), false);
      h.internals._appendEntry(createTurnEnd("te-1", 1, "completed"), false);
      expect(h.session.persistToDisk()).toBe(true); // 首次快照

      const index = readTurnIndex(dir, readLastSeq(dir));
      expect(index).not.toBeNull();
      expect(index?.turns.map((turn) => turn.entryId)).toEqual(["ts-1"]);
      expect(index?.mutations.map((mutation) => mutation.entryId)).toEqual(["tr-1"]);

      h.internals._appendEntry(createTurnStart("ts-2", 2), false);
      h.internals._appendEntry(createUserMessage("user-2", 2, "second", "second", "ctx-b"), false);
      h.internals._appendEntry(createTurnEnd("te-2", 2, "completed"), false);
      expect(h.session.persistToDisk()).toBe(true);

      expect(readTurnIndex(dir, readLastSeq(dir))?.turns.map((turn) => turn.entryId)).toEqual(["ts-1", "ts-2"]);
    } finally {
      h.dispose();
    }
  });
});
