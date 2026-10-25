/**
 * R-3 接线：resume 走有界模型上下文，历史按页取回，回退时物化完整日志。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDefaultRegistry } from "../../src/commands/registration.js";
import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { writeArchiveEnvelopeForMigration } from "../../src/config/archive.js";
import { createLogSessionMeta, saveSessionMeta, type LogSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createSystemPrompt,
  createTokenUpdate,
  createTurnEnd,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { applySessionRestore } from "../../src/session/resume.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-bounded-resume-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<LogSessionMeta> = {}): LogSessionMeta {
  return createLogSessionMeta({
    sessionId: "s-bounded",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    projectPath: "/work/demo",
    modelConfigName: "gpt-test",
    summary: "",
    title: "bounded",
    turnCount: 2,
    compactCount: 1,
    thinkingLevel: "off",
    idCounters: { sys: 1, ts: 2, user: 2, asst: 2, cm: 1, cc: 1, tok: 1 },
    workCount: 0,
    tokens: { input: 500, output: 50, cacheRead: 400 },
    firstInput: 500,
    firstUserMessageTokens: 10,
    ...overrides,
  });
}

function makeEntries(): LogEntry[] {
  return [
    createSystemPrompt("sys-1", 0, "system"),
    createTurnStart("ts-1", 1),
    createUserMessage("user-1", 1, "old", "old", "ctx-a"),
    createAssistantText("asst-1", 1, 0, "old answer", "old answer"),
    createCompactMarker("cm-1", 2, 0, 1000, 100),
    createCompactContext("cc-1", 2, "briefing", "ctx-b", 0),
    createTurnStart("ts-2", 2),
    createUserMessage("user-2", 2, "new", "new", "ctx-b"),
    createAssistantText("asst-2", 2, 0, "new answer", "new answer"),
    createTurnEnd("te-2", 2, "completed"),
  ];
}

function seedSession(meta: LogSessionMeta): string {
  const dir = makeDir();
  writeLogJsonlSnapshot(dir, meta, makeEntries());
  // meta.json 必须带 counters/tokens；writeLogJsonlSnapshot 只写 header。
  saveSessionMeta(dir, meta);
  return dir;
}

describe("resume 走有界模型上下文", () => {
  it("只加载活动窗口；历史按页取回；回退前物化完整日志", async () => {
    const dir = seedSession(makeMeta());
    const h = makeScriptedSession();
    try {
      const result = applySessionRestore(h.session, h.internals._store, dir);
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);

      // 窗口 = marker 及之后（marker 用于 M0 边界）。
      expect(h.session.log.map((entry) => entry.id)).toEqual([
        "cm-1", "cc-1", "ts-2", "user-2", "asst-2", "te-2",
      ]);
      expect(h.session.hasEarlierHistory()).toBe(true);
      expect(h.session.getDisplayLog().map((entry) => entry.id)).toEqual(h.session.log.map((entry) => entry.id));

      // 回退菜单/轮次列表仍能看到标记前的 turn（按需读完整日志）。
      expect(h.session.listTurns().map((turn) => turn.turnIndex)).toEqual([1, 2]);
      expect(h.session.getRewindTargets().map((target) => target.turnIndex)).toEqual([2, 1]);

      // 分页：3 + 1 条历史，最终与全量展示一致。
      const first = h.session.loadEarlierHistoryPage(3);
      expect(first).toEqual({ loaded: 3, hasMore: true });
      expect(h.session.getDisplayLog().slice(0, 3).map((entry) => entry.id)).toEqual(["ts-1", "user-1", "asst-1"]);
      const second = h.session.loadEarlierHistoryPage(3);
      expect(second).toEqual({ loaded: 1, hasMore: false });
      expect(h.session.hasEarlierHistory()).toBe(false);
      expect(h.session.getDisplayLog().map((entry) => entry.id)).toEqual([
        "sys-1", "ts-1", "user-1", "asst-1", "cm-1", "cc-1", "ts-2", "user-2", "asst-2", "te-2",
      ]);

      // 用量：窗口内 tok 不在本例；基线原样保留。
      expect(h.session.cumulativeInputTokens).toBe(500);
      h.internals._appendEntry(createTokenUpdate("tok-live", 2, 20, 5, undefined, 25), false);
      expect(h.session.cumulativeInputTokens).toBe(520);

      // 回退到 turn 1：先物化完整日志再截断，分页状态关闭。
      const rewind = h.session.rewindConversation(1);
      expect(rewind.error).toBeUndefined();
      expect(h.session.log.map((entry) => entry.id)).toEqual(["sys-1"]);
      expect(h.session.hasEarlierHistory()).toBe(false);
      // 物化后用量回到完整日志口径；turn 1 之后的 token_update 已被截断。
      expect(h.session.cumulativeInputTokens).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("缺计数器/基线的旧 JSONL：回退整读并给出 warning", () => {
    const meta = makeMeta();
    delete meta.idCounters;
    delete meta.workCount;
    const dir = seedSession(meta);
    const h = makeScriptedSession();
    try {
      const result = applySessionRestore(h.session, h.internals._store, dir);
      expect(result.ok).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("unbounded"))).toBe(true);
      expect(h.session.log).toHaveLength(makeEntries().length);
      expect(h.session.hasEarlierHistory()).toBe(true);
      expect(h.session.getDisplayLog().map((entry) => entry.id)).toEqual([
        "cm-1", "cc-1", "ts-2", "user-2", "asst-2", "te-2",
      ]);
    } finally {
      h.dispose();
    }
  });

  it("旧 persistence_policy：禁用有界，整读以免归一化快照丢掉标记前历史", () => {
    const dir = seedSession(makeMeta());
    // saveSessionMeta 总会写 3；手工降回 2 模拟旧会话。
    const metaFile = join(dir, "meta.json");
    const raw = JSON.parse(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
    raw["persistence_policy"] = 2;
    writeFileSync(metaFile, JSON.stringify(raw));

    const h = makeScriptedSession();
    try {
      const result = applySessionRestore(h.session, h.internals._store, dir);
      expect(result.ok).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("persistence policy"))).toBe(true);
      expect(h.session.log).toHaveLength(makeEntries().length);
      expect(h.session.hasEarlierHistory()).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("缺少 tokens：不启用有界（用量口径无法保证），整读", () => {
    const meta = makeMeta();
    delete meta.tokens;
    const dir = seedSession(meta);
    const h = makeScriptedSession();
    try {
      const result = applySessionRestore(h.session, h.internals._store, dir);
      expect(result.ok).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("unbounded"))).toBe(true);
      expect(h.session.log).toHaveLength(makeEntries().length);
      expect(h.session.hasEarlierHistory()).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("历史页的已归档条目按需从 archive 取回 display", () => {
    const dir = makeDir();
    const meta = makeMeta();
    const entries = makeEntries();
    const archived = entries[3]!; // asst-1（标记前）
    archived.display = "";
    archived.content = null;
    archived.archived = true;
    archived.meta = { contextId: "ctx-a" };
    writeLogJsonlSnapshot(dir, meta, entries);
    saveSessionMeta(dir, meta);
    writeArchiveEnvelopeForMigration(
      dir,
      "cm-1",
      "window-cm-1.jsonl.gz",
      [{
        id: "asst-1",
        content: "old answer",
        display: "old answer",
        meta: { contextId: "ctx-a" },
      }],
      { turns: [], mutations: [], entryIds: ["asst-1"] },
    );

    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      h.session.loadEarlierHistoryPage(3);
      const found = h.session.getDisplayLog().find((entry) => entry.id === "asst-1");
      expect(found?.display).toBe("old answer");
      expect(found?.archived).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("planRewind 会把有界会话物化为完整日志", async () => {
    const dir = seedSession(makeMeta());
    const h = makeScriptedSession();
    try {
      expect(applySessionRestore(h.session, h.internals._store, dir).ok).toBe(true);
      expect(h.session.log).toHaveLength(6);

      await h.session.planRewind(1);
      expect(h.session.log).toHaveLength(makeEntries().length);
      // 物化后仍是完整日志；TUI 默认只显示活动窗口，历史可从内存分页。
      expect(h.session.hasEarlierHistory()).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe("/history 命令", () => {
  it("注册并调用 loadEarlierHistoryPage", async () => {
    const registry = buildDefaultRegistry();
    const command = registry.lookup("/history");
    expect(command).toBeTruthy();

    const messages: string[] = [];
    const ctx = {
      session: { loadEarlierHistoryPage: () => ({ loaded: 2, hasMore: true }) },
      showMessage: (text: string) => messages.push(text),
    } as never;
    await command!.handler(ctx, "");
    expect(messages[0]).toContain("Loaded 2 earlier entries");
    expect(messages[0]).toContain("more available");
  });
});
