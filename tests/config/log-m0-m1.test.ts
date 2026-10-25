/**
 * M0（标记前 presentation 不落盘）与 M1（reasoningState 外置）契约。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { archiveWindow, loadArchive } from "../../src/config/archive.js";
import { loadArchivedDisplaysForEntries } from "../../src/config/archive.js";
import {
  SEALED_INLINE_BUDGET_BYTES,
  isSealedRef,
  maybeExternalizeReasoning,
  pruneSealed,
  readSealed,
  type SealedRef,
} from "../../src/config/log-sealed.js";
import { LOG_JSONL_VERSION, appendRecords, readRecords } from "../../src/config/log-jsonl.js";
import { loadLog } from "../../src/config/log-serialization.js";
import { applySessionRestore } from "../../src/session/resume.js";
import {
  createAssistantText,
  createCompactMarker,
  createReasoning,
  createSystemPrompt,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import { projectToApiMessages } from "../../src/context/projection/api.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-m0-m1-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function persistedEntry(dir: string, id: string): { display: unknown; meta: Record<string, unknown> } {
  const records = readRecords(dir).records;
  for (const record of records) {
    if (record.op !== "upsert") continue;
    const entry = record.entries.find((candidate) => candidate.id === id);
    if (entry) return entry as { display: unknown; meta: Record<string, unknown> };
  }
  throw new Error(`entry ${id} not found in log.jsonl`);
}

function seedArchivedWindow(h: ReturnType<typeof makeScriptedSession>): { dir: string; user: LogEntry; marker: LogEntry } {
  const dir = h.internals._store.sessionDir as string;
  const log = h.session.log as LogEntry[];
  h.internals._appendEntry(createSystemPrompt("sys-1", 0, "system"), false);
  const user = createUserMessage("user-1", 1, "hello", "hello", "ctx-1");
  (user.meta as Record<string, unknown>)["heavy"] = "h".repeat(1024);
  const assistant = createAssistantText("asst-1", 1, 0, "answer", "answer");
  h.internals._appendEntry(user, false);
  h.internals._appendEntry(assistant, false);
  const marker = createCompactMarker("cm-1", 2, 0, 100, 50);
  h.internals._appendEntry(marker, false);
  const ids = archiveWindow(dir, 0, log, 0, log.length - 2);
  h.internals._logStore.archiveEntries(ids);
  return { dir, user, marker };
}

describe("M0：标记前 presentation 不落盘", () => {
  it("磁盘条目只留身份键与 display 空串；历史页显式从 archive 取回 display", () => {
    const h = makeScriptedSession();
    try {
      const { dir, user } = seedArchivedWindow(h);
      expect(user.display).toBe("hello");
      expect((user.meta as Record<string, unknown>)["heavy"]).toBe("h".repeat(1024));

      expect(h.session.persistToDisk()).toBe(true);
      const stored = persistedEntry(dir, user.id);
      expect(stored.display).toBe("");
      expect(stored.meta["heavy"]).toBeUndefined();
      expect(stored.meta["contextId"]).toBe("ctx-1");

      // 内存条目不被就地清空（D11a）。
      expect(user.display).toBe("hello");
      expect((user.meta as Record<string, unknown>)["heavy"]).toBe("h".repeat(1024));

      const loaded = loadLog(dir);
      const loadedUser = loaded.entries.find((entry) => entry.id === user.id)!;
      expect(loadedUser.display).toBe("");
      expect(loadedUser.meta["heavy"]).toBeUndefined();
      expect(loadedUser.meta["contextId"]).toBe("ctx-1");
      const page = loadArchivedDisplaysForEntries(dir, [loadedUser]);
      expect(page.displays.get(user.id)).toBe("hello");
      expect(loadedUser.display).toBe("");
    } finally {
      h.dispose();
    }
  });

  it("presentation 索引与正文共享 envelope，不读取旁路旧 index", () => {
    const h = makeScriptedSession();
    try {
      const { dir, user } = seedArchivedWindow(h);
      expect(h.session.persistToDisk()).toBe(true);
      const stored = persistedEntry(dir, user.id);
      expect(stored.display).toBe("");
      expect(stored.meta["heavy"]).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  it("没有 marker 时一个字段都不剥", () => {
    const h = makeScriptedSession();
    try {
      const dir = h.internals._store.sessionDir as string;
      const log = h.session.log as LogEntry[];
      h.internals._appendEntry(createSystemPrompt("sys-1", 0, "system"), false);
      const user = createUserMessage("user-1", 1, "hello", "hello", "ctx-1");
      (user.meta as Record<string, unknown>)["heavy"] = "h".repeat(1024);
      h.internals._appendEntry(user, false);
      archiveWindow(dir, 0, log, 0, log.length - 1);

      expect(h.session.persistToDisk()).toBe(true);
      const stored = persistedEntry(dir, user.id);
      expect(stored.display).toBe("hello");
      expect(stored.meta["heavy"]).toBe("h".repeat(1024));
    } finally {
      h.dispose();
    }
  });
});

describe("M1：reasoningState 外置", () => {
  it("≥ 4 KiB 写 sidecar，日志只留引用；取回与投影逐字等价；缺 sidecar 降级", () => {
    const h = makeScriptedSession();
    try {
      const dir = h.internals._store.sessionDir as string;
      const state = { blob: "z".repeat(5000) };
      h.internals._appendEntry(createSystemPrompt("sys-1", 0, "system"), false);
      h.internals._appendEntry(createTurnStart("ts-1", 1), false);
      h.internals._appendEntry(createUserMessage("user-1", 1, "hi", "hi", "ctx-1"), false);
      h.internals._appendEntry(
        createReasoning("rsn-1", 1, 0, "thinking", "thinking text", state, "ctx-1"),
        false,
      );
      h.internals._appendEntry(createAssistantText("asst-1", 1, 0, "answer", "answer"), false);

      expect(h.session.persistToDisk()).toBe(true);
      const stored = persistedEntry(dir, "rsn-1");
      const ref = stored.meta["reasoningState"];
      expect(isSealedRef(ref)).toBe(true);
      expect(stored.meta["thinkingArtifact"]).toBeTruthy();
      expect(JSON.stringify(stored)).not.toContain("z".repeat(5000));

      const sidecar = join(dir, "sealed", "rsn-1.json.gz");
      expect(existsSync(sidecar)).toBe(true);
      expect(readSealed(dir, ref as SealedRef)).toEqual(state);

      const loaded = loadLog(dir);
      const projected = projectToApiMessages(loaded.entries, {
        resolveReasoningState: (value) => {
          if (!isSealedRef(value)) return value;
          return readSealed(dir, value);
        },
      });
      const assistant = projected.find((message) => message.role === "assistant" && message["_reasoning_state"]);
      expect(assistant?.["_reasoning_state"]).toEqual(state);

      unlinkSync(sidecar);
      const degraded = projectToApiMessages(loaded.entries, {
        resolveReasoningState: (value) => (isSealedRef(value) ? readSealed(dir, value) : value),
      });
      const degradedAssistant = degraded.find((message) => message.role === "assistant" && message["_reasoning_state"]);
      expect(degradedAssistant).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  it("4 KiB 边界：4096 B 外置，4095 B 内联", () => {
    const dir = makeDir();
    // JSON.stringify 会加一对引号：字符串长度 4094/4093 分别对应 4096/4095 字节。
    expect(maybeExternalizeReasoning(dir, "rsn-4095", "x".repeat(4093))).toBeUndefined();
    const ref = maybeExternalizeReasoning(dir, "rsn-4096", "x".repeat(4094));
    expect(ref).toBeTruthy();
    expect(ref!.bytes).toBe(4096);
    expect(readSealed(dir, ref!)).toBe("x".repeat(4094));
  });

  it("低于 4 KiB 保持内联；prune 只删孤儿", () => {
    const dir = makeDir();
    expect(maybeExternalizeReasoning(dir, "rsn-small", { blob: "x".repeat(1000) })).toBeUndefined();

    const refA = maybeExternalizeReasoning(dir, "rsn-a", { blob: "a".repeat(SEALED_INLINE_BUDGET_BYTES + 100) });
    const refB = maybeExternalizeReasoning(dir, "rsn-b", { blob: "b".repeat(SEALED_INLINE_BUDGET_BYTES + 100) });
    expect(refA).toBeTruthy();
    expect(refB).toBeTruthy();
    expect(refA!.bytes).toBeGreaterThanOrEqual(SEALED_INLINE_BUDGET_BYTES);

    expect(pruneSealed(dir, new Set(["rsn-a"]))).toBe(1);
    expect(existsSync(join(dir, "sealed", "rsn-a.json.gz"))).toBe(true);
    expect(existsSync(join(dir, "sealed", "rsn-b.json.gz"))).toBe(false);
    expect(readSealed(dir, refA!)).toEqual({ blob: "a".repeat(SEALED_INLINE_BUDGET_BYTES + 100) });
  });

  it("归档剥离后 sidecar 被回收，archive 保留唯一一份密文", () => {
    const h = makeScriptedSession();
    try {
      const dir = h.internals._store.sessionDir as string;
      const log = h.session.log as LogEntry[];
      const state = { blob: "q".repeat(5000) };
      h.internals._appendEntry(createSystemPrompt("sys-1", 0, "system"), false);
      h.internals._appendEntry(createReasoning("rsn-1", 1, 0, "think", "think", state, "ctx-1"), false);
      h.internals._appendEntry(createCompactMarker("cm-1", 2, 0, 100, 50), false);
      const ids = archiveWindow(dir, 0, log, 0, log.length - 2);
      h.internals._logStore.archiveEntries(ids);

      expect(h.session.persistToDisk()).toBe(true);
      expect(existsSync(join(dir, "sealed", "rsn-1.json.gz"))).toBe(false);
      expect(persistedEntry(dir, "rsn-1").meta["reasoningState"]).toBeUndefined();
      const archived = loadArchive(dir, 0);
      expect((archived.find((record) => record.id === "rsn-1")!.meta as Record<string, unknown>)["reasoningState"]).toEqual(state);
    } finally {
      h.dispose();
    }
  });

  it("旧 JSONL（无 persistence_policy）在下一次保存时归一化", () => {
    const h = makeScriptedSession();
    try {
      const dir = h.internals._store.sessionDir as string;
      const sessionId = basename(dir);
      const state = { blob: "n".repeat(5000) };
      appendRecords(dir, [
        {
          v: LOG_JSONL_VERSION,
          op: "session",
          seq: 1,
          ts: "2026-10-23T00:00:00.000Z",
          session: {
            session_id: sessionId,
            created_at: "2026-10-23T00:00:00Z",
            updated_at: "2026-10-23T00:00:00Z",
            project_path: "/work/demo",
            model_config_name: "test-model",
            summary: "",
            title: "old",
            turn_count: 1,
            compact_count: 0,
            thinking_level: "off",
          },
        },
        {
          v: LOG_JSONL_VERSION,
          op: "upsert",
          seq: 2,
          ts: "2026-10-23T00:00:01.000Z",
          entries: [{
            id: "rsn-old",
            type: "reasoning",
            timestamp: 1,
            turn_index: 1,
            content: "think",
            display: "think",
            meta: { reasoningState: state },
          }],
        },
      ]);
      writeFileSync(join(dir, "meta.json"), JSON.stringify({
        session_id: sessionId,
        created_at: "2026-10-23T00:00:00Z",
        last_active_at: "2026-10-23T00:00:00Z",
        summary: "",
        title: "old",
        turn_count: 1,
      }), "utf-8");

      // 模拟原会话已关闭：释放写锁后由新 store 接管。
      h.internals._store.releaseSessionLock(dir);
      const fresh = makeScriptedSession();
      try {
        const restored = applySessionRestore(fresh.session, fresh.internals._store, dir);
        expect(restored.ok).toBe(true);
        expect(fresh.session.persistToDisk()).toBe(true);
      } finally {
        fresh.dispose();
      }

      const stored = persistedEntry(dir, "rsn-old");
      expect(isSealedRef(stored.meta["reasoningState"])).toBe(true);
      expect(existsSync(join(dir, "sealed", "rsn-old.json.gz"))).toBe(true);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
      expect(meta.persistence_policy).toBe(3);
    } finally {
      h.dispose();
    }
  });

  it("sidecar 路径越界或损坏返回 null", () => {
    const dir = makeDir();
    expect(readSealed(dir, { sealedRef: "../evil.json.gz", bytes: 1, encoding: "gzip" })).toBeNull();
    expect(readSealed(dir, { sealedRef: "sealed/missing.json.gz", bytes: 1, encoding: "gzip" })).toBeNull();
  });
});
