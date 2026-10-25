/**
 * 运行期 JSONL 持久化：真实 Session turn → 追加 → 重放，以及真实回退的 truncate。
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";

import { LOG_JSONL_FILENAME, readRecords } from "../../src/config/log-jsonl.js";
import { loadLog } from "../../src/config/log-serialization.js";
import { applySessionRestore } from "../../src/session/resume.js";
import { shouldPersistEntry } from "../../src/config/log-write-policy.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { LogIdAllocator } from "../../src/context/entry/id-allocator.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { createReasoning, createTokenUpdate, createTurnEnd, createTurnStart } from "../../src/context/entry/factories.js";
import { aggregateTokenUsage } from "../../src/session/usage-accounting.js";
import { makeScriptedSession, testToolDef } from "../helpers/session-harness.js";

function expectedPersisted(entries: readonly LogEntry[]): LogEntry[] {
  return entries.filter((entry) => shouldPersistEntry(entry));
}

describe("真实 turn 的 JSONL 持久化", () => {
  it("turn → 追加 → 重放一致；无变更时不重写；第二次 turn 只追加", async () => {
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "read_file", arguments: { text: "hello" } }] },
        { text: "first answer" },
        { text: "second answer" },
      ],
      tools: [testToolDef("read_file")],
      toolExecutorOverrides: {
        read_file: () => "probe output",
      },
    });
    try {
      await h.session.turn("first");
      const dir = h.internals._store.sessionDir as string;
      expect(h.session.persistToDisk()).toBe(true);

      const file = join(dir, LOG_JSONL_FILENAME);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(join(dir, "log.json"))).toBe(false);

      const firstLoaded = loadLog(dir);
      expect(firstLoaded.entries).toEqual(expectedPersisted(h.session.log));
      expect(firstLoaded.meta.turnCount).toBe(1);

      // 无变更的再次持久化不得触碰日志正文。
      const beforeNoop = readFileSync(file);
      expect(h.session.persistToDisk()).toBe(true);
      expect(readFileSync(file).equals(beforeNoop)).toBe(true);

      const beforeSecondTurn = readFileSync(file);
      await h.session.turn("second");
      expect(h.session.persistToDisk()).toBe(true);
      const afterSecondTurn = readFileSync(file);
      expect(afterSecondTurn.length).toBeGreaterThan(beforeSecondTurn.length);
      expect(afterSecondTurn.subarray(0, beforeSecondTurn.length).equals(beforeSecondTurn)).toBe(true);

      const secondLoaded = loadLog(dir);
      expect(secondLoaded.entries).toEqual(expectedPersisted(h.session.log));
      expect(secondLoaded.meta.turnCount).toBe(2);

      const records = readRecords(dir);
      expect(records.warnings).toEqual([]);
      expect(records.records.some((record) => record.op === "upsert")).toBe(true);
      expect(records.records.some((record) => record.op === "truncate")).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("JSONL 会话可被 applySessionRestore 恢复（fresh Session）", async () => {
    const h = makeScriptedSession({
      rounds: [{ text: "resume me" }],
    });
    const target = makeScriptedSession();
    try {
      await h.session.turn("first");
      const dir = h.internals._store.sessionDir as string;
      expect(h.session.persistToDisk()).toBe(true);
      // 模拟原会话已关闭：释放写锁后由新 store 接管。
      h.internals._store.releaseSessionLock(dir);

      const result = applySessionRestore(target.session, target.internals._store, dir);
      expect(result.ok).toBe(true);
      expect(target.session.log).toEqual(expectedPersisted(h.session.log));
      expect((target.session as any)._turnCount).toBe(1);
    } finally {
      target.dispose();
      h.dispose();
    }
  });

  it("手动压缩：marker/context 增量落盘，并写 usage 检查点", async () => {
    const h = makeScriptedSession({
      rounds: [{ text: "first answer" }, { text: `continuation summary ${"x".repeat(220)}` }],
    });
    try {
      await h.session.turn("first");
      const dir = h.internals._store.sessionDir as string;
      expect(h.session.persistToDisk()).toBe(true);
      const sizeAfterTurn = statSync(join(dir, LOG_JSONL_FILENAME)).size;

      await h.session.runManualCompact();
      expect(h.session.persistToDisk()).toBe(true);
      expect(statSync(join(dir, LOG_JSONL_FILENAME)).size).toBeGreaterThan(sizeAfterTurn);

      const records = readRecords(dir).records;
      expect(records.some((record) => record.op === "compact_checkpoint")).toBe(true);
      expect(records.some((record) =>
        record.op === "upsert" && record.entries.some((entry) => entry.type === "compact_marker"))).toBe(false);
      const usage = records.filter((record) => record.op === "usage");
      expect(usage.length).toBeGreaterThanOrEqual(1);
      expect(usage.at(-1)).toMatchObject({
        totals: {
          input: expect.any(Number),
          output: expect.any(Number),
          cacheRead: expect.any(Number),
        },
      });

      const loaded = loadLog(dir);
      // loadLog 会按 M0 从 archive 回填已归档条目的 display；
      // 持久化本体仍是 strip 视图，比较时忽略回填的 display。
      expect(loaded.entries.map((entry) => entry.archived ? { ...entry, display: "" } : entry))
        .toEqual(expectedPersisted(h.session.log));
      expect(loaded.entries.some((entry) => entry.type === "compact_context")).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("真实回退：truncate 记录重放后与内存一致，且不重写历史字节", async () => {
    const h = makeScriptedSession({
      rounds: [
        { text: "one" },
        { text: "two" },
      ],
    });
    try {
      await h.session.turn("first");
      await h.session.turn("second");
      const dir = h.internals._store.sessionDir as string;
      expect(h.session.persistToDisk()).toBe(true);
      const file = join(dir, LOG_JSONL_FILENAME);
      const before = readFileSync(file);
      const sizeBefore = statSync(file).size;

      const rewind = h.session.rewindConversation(2);
      expect(rewind.error).toBeUndefined();
      expect(rewind.removed).toBeGreaterThan(0);
      expect(h.session.persistToDisk()).toBe(true);

      const after = readFileSync(file);
      expect(after.length).toBeGreaterThan(sizeBefore);
      expect(after.subarray(0, before.length).equals(before)).toBe(true);

      const records = readRecords(dir).records;
      expect(records.some((record) => record.op === "truncate")).toBe(true);
      expect(loadLog(dir).entries).toEqual(expectedPersisted(h.session.log));
    } finally {
      h.dispose();
    }
  });

  it("中断正规化的 discarded 走网关落盘（重新加载仍生效）", () => {
    const h = makeScriptedSession();
    try {
      const session = h.internals;
      session._appendEntry(createTurnStart("ts-1", 1), false);
      session._appendEntry(createReasoning("rsn-1", 1, 0, "thinking", "thinking"), false);
      expect(h.session.persistToDisk()).toBe(true);

      // 已落盘后才发生中断正规化：内存里的就地修改不应依赖待写队列。
      session._normalizeInterruptedTurnFromLog("recovered after restart");
      expect(h.session.persistToDisk()).toBe(true);

      const dir = h.internals._store.sessionDir as string;
      const reasoning = loadLog(dir).entries.find((entry) => entry.id === "rsn-1");
      expect(reasoning?.discarded).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("有界恢复用量：以 meta.tokens 为基线，只累加恢复后的 token_update；回退扣减", () => {
    const h = makeScriptedSession();
    try {
      const meta = createLogSessionMeta({
        sessionId: "s-usage",
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
        projectPath: "/work/demo",
        modelConfigName: "gpt-test",
        summary: "",
        turnCount: 2,
        compactCount: 1,
        thinkingLevel: "off",
        tokens: { input: 1000, output: 100, cacheRead: 800 },
        firstInput: 900,
        firstUserMessageTokens: 30,
      });
      const entries = [
        createTurnStart("ts-1", 1),
        createTokenUpdate("tok-base", 1, 500, 400, undefined, 550),
        createTurnStart("ts-2", 2),
        createTokenUpdate("tok-new", 2, 50, 10, undefined, 60),
      ];
      const allocator = new LogIdAllocator();
      allocator.restoreFrom(entries);

      h.session.commitPreparedRestore(h.session.prepareRestoreFromLog(meta, entries, allocator, { bounded: true }));
      // 正常保存时 meta.tokens 已包含窗口内全部 token_update（tok-base/tok-new），恢复后不重复累加。
      expect(h.session.cumulativeInputTokens).toBe(1000);
      expect(h.session.cumulativeOutputTokens).toBe(100);
      expect(h.session.cumulativeCacheReadTokens).toBe(800);
      expect(h.session.cumulativeUncachedTokens).toBe(200);
      expect(h.session.systemPromptTokens).toBe(870);

      // 恢复后新增的 token_update 才累加。
      h.internals._appendEntry(createTurnStart("ts-3", 3), false);
      h.internals._appendEntry(createTokenUpdate("tok-live", 3, 20, 5, undefined, 25), false);
      expect(h.session.cumulativeInputTokens).toBe(1020);
      expect(h.session.cumulativeOutputTokens).toBe(105);

      // 回退到 turn 1：tok-base 计入过基线，必须从基线扣减；tok-live 只是新增量。
      const rewind = h.session.rewindConversation(1);
      expect(rewind.error).toBeUndefined();
      // tok-base(500/50/400) 与 tok-new(50/10/10) 都计入过基线，一并扣减。
      expect(h.session.cumulativeInputTokens).toBe(450);
      expect(h.session.cumulativeOutputTokens).toBe(40);
      expect(h.session.cumulativeCacheReadTokens).toBe(390);
    } finally {
      h.dispose();
    }
  });

  it("保存后 meta.tokens 等于日志 token_update 求和（含 cacheRead）", () => {
    const h = makeScriptedSession();
    try {
      h.internals._appendEntry(createTokenUpdate("tok-1", 1, 100, 40, undefined, 120), false);
      h.internals._appendEntry(createTokenUpdate("tok-2", 1, 200, 50, undefined, 260), false);
      expect(h.session.persistToDisk()).toBe(true);

      const dir = h.internals._store.sessionDir as string;
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as {
        tokens?: { input: number; output: number; cacheRead: number };
      };
      const agg = aggregateTokenUsage(h.session.log);
      expect(meta.tokens).toEqual({
        input: agg.cumulativeInput,
        output: agg.cumulativeOutput,
        cacheRead: agg.cumulativeCacheRead,
      });
      expect(meta.tokens).toEqual({ input: 300, output: 80, cacheRead: 90 });
    } finally {
      h.dispose();
    }
  });

  it("恢复信号：全量以日志扫描为准，有界才用 meta 快照补缺", () => {
    const h = makeScriptedSession();
    try {
      const meta = createLogSessionMeta({
        sessionId: "s-signal",
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
        projectPath: "/work/demo",
        modelConfigName: "gpt-test",
        summary: "",
        turnCount: 1,
        compactCount: 0,
        thinkingLevel: "off",
        workCount: 4,
        lifetimeToolCallCount: 9,
        lastTurnEndStatus: "error",
        recentSessionEvents: ["stale"],
        selfPhase: "thinking",
      });
      const entries = [createTurnStart("ts-1", 1), createTurnEnd("te-1", 1, "completed")];
      const allocator = new LogIdAllocator();
      allocator.restoreFrom(entries);

      h.session.commitPreparedRestore(h.session.prepareRestoreFromLog(meta, entries, allocator));
      expect(h.session.lastTurnEndStatus).toBe("completed");
      expect(h.session.recentSessionEvents).toEqual([]);
      expect(h.session.sessionPhase).toBe("idle");
      // 累计计数取最大值：日志扫描 0，meta 9。
      expect(h.session.lifetimeToolCallCount).toBe(9);

      h.session.commitPreparedRestore(h.session.prepareRestoreFromLog(meta, [], allocator, { bounded: true }));
      expect(h.session.lastTurnEndStatus).toBe("error");
      expect(h.session.recentSessionEvents).toEqual(["stale"]);
      expect(h.session.sessionPhase).toBe("thinking");
      expect(h.session.workCount).toBe(4);
    } finally {
      h.dispose();
    }
  });

  it("同一分钟内的重复落盘不重写 meta.json / project.json（P-14）", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "throttle" }] });
    const pinned = new Date("2001-02-03T04:05:06.000Z");
    const isPinned = (file: string) =>
      Math.abs(statSync(file).mtimeMs - pinned.getTime()) < 1000;
    try {
      await h.session.turn("first");
      const dir = h.internals._store.sessionDir as string;
      const metaFile = join(dir, "meta.json");
      const projectFile = join(dirname(dir), "project.json");

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-23T10:00:05.000Z"));
      expect(h.session.persistToDisk()).toBe(true);
      utimesSync(metaFile, pinned, pinned);
      utimesSync(projectFile, pinned, pinned);

      vi.setSystemTime(new Date("2026-10-23T10:00:50.000Z"));
      expect(h.session.persistToDisk()).toBe(true);
      expect(isPinned(metaFile)).toBe(true);
      expect(isPinned(projectFile)).toBe(true);
    } finally {
      vi.useRealTimers();
      h.dispose();
    }
  });
});
