/**
 * W-1 变更网关与 fork 独立性契约。
 * 期望值来自变更网关的记录契约，不来自实现。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  LOG_JSONL_FILENAME,
  LOG_JSONL_VERSION,
  appendRecords,
  loadLogJsonl,
  readLogHeader,
  type EntryFlags,
  type JsonlRecord,
  type UpsertRecord,
} from "../../src/config/log-jsonl.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import {
  createAssistantText,
  createCompactMarker,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import { SessionLog } from "../../src/session/log.js";
import { forkSessionDirectory } from "../../src/server/session-fork.js";

interface Gateway {
  updateEntry(id: string, mutator: (entry: LogEntry) => void): void;
  patchFlags(ids: readonly string[], flags: EntryFlags, opts?: { dropPresentation?: true }): void;
  truncateFrom(entryId: string): void;
  drainPendingRecords(startSeq: number): JsonlRecord[];
  assertNoDirectMutations(): void;
  enableDirectMutationGuard(): void;
}

function gateway(log: SessionLog): Gateway {
  return log as unknown as Gateway;
}

const tempDirs: string[] = [];

function makeDir(prefix = "swarmflow-log-gateway-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function assistant(id = "asst-1", turnIndex = 1): LogEntry {
  return createAssistantText(id, turnIndex, 0, `content-${id}`, `display-${id}`);
}

function entryIds(record: JsonlRecord): string[] {
  if (record.op !== "upsert") return [];
  return record.entries.map((entry) => String(entry.id));
}

function sessionRecord(seq = 1) {
  return {
    v: LOG_JSONL_VERSION,
    op: "session" as const,
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
      turn_count: 1,
      compact_count: 0,
      thinking_level: "medium",
    },
  };
}

describe("SessionLog 变更网关", () => {
  it("提供 append/update/patch/truncate/drain/assert 入口", () => {
    const gw = gateway(new SessionLog());
    expect(typeof gw.updateEntry).toBe("function");
    expect(typeof gw.patchFlags).toBe("function");
    expect(typeof gw.truncateFrom).toBe("function");
    expect(typeof gw.drainPendingRecords).toBe("function");
    expect(typeof gw.assertNoDirectMutations).toBe("function");
  });

  it("append 产生一条 upsert；没有变更时 drain 为空", () => {
    const log = new SessionLog();
    log.append(assistant("asst-1"));

    const records = gateway(log).drainPendingRecords(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ v: LOG_JSONL_VERSION, op: "upsert", seq: 2 });
    expect(entryIds(records[0])).toEqual(["asst-1"]);
    expect(gateway(log).drainPendingRecords(3)).toEqual([]);
  });

  it("创建 upsert 不带 replaces；已落盘条目再次写才带 replaces", () => {
    const log = new SessionLog();
    log.append(assistant("asst-1"));
    const gw = gateway(log);

    // 同批次 append + update：条目尚未落盘，仍是一条创建记录。
    gw.updateEntry("asst-1", (entry) => { entry.display = "streamed"; });
    const first = gw.drainPendingRecords(2) as UpsertRecord[];
    expect(first).toHaveLength(1);
    expect(first[0].replaces).toBeUndefined();
    expect(first[0].entries[0]).toMatchObject({ id: "asst-1", display: "streamed" });

    gw.updateEntry("asst-1", (entry) => { entry.display = "final"; });
    const second = gw.drainPendingRecords(3) as UpsertRecord[];
    expect(second).toHaveLength(1);
    expect(second[0].replaces).toBe(true);
  });

  it("同一 entry 多次 update 合并为一条 upsert（最后一次生效）", () => {
    const log = new SessionLog();
    log.append(assistant("asst-1"));
    gateway(log).drainPendingRecords(2);

    const gw = gateway(log);
    gw.updateEntry("asst-1", (entry) => { entry.content = "v1"; });
    gw.updateEntry("asst-1", (entry) => { entry.content = "v2"; entry.display = "d2"; });

    const records = gw.drainPendingRecords(3);
    expect(records).toHaveLength(1);
    expect(records[0].op).toBe("upsert");
    const upsert = records[0] as UpsertRecord;
    expect(upsert.entries).toHaveLength(1);
    expect(upsert.entries[0]).toMatchObject({ id: "asst-1", content: "v2", display: "d2" });
  });

  it("批量 flags 合并为一条 patch，不产生逐条 upsert", () => {
    const log = new SessionLog();
    log.append(assistant("a"));
    log.append(assistant("b"));
    log.append(assistant("c"));
    gateway(log).drainPendingRecords(2);

    gateway(log).patchFlags(["a", "b", "c"], { archived: true }, { dropPresentation: true });
    const records = gateway(log).drainPendingRecords(3);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      op: "patch",
      seq: 3,
      ids: ["a", "b", "c"],
      flags: { archived: true },
      dropPresentation: true,
    });
  });

  it("truncateFrom 截断数组，清掉被截断条目的待写 upsert，只发一条 truncate", () => {
    const log = new SessionLog();
    log.append(assistant("a"));
    log.append(assistant("b"));
    log.append(assistant("c"));
    gateway(log).drainPendingRecords(2);

    const gw = gateway(log);
    gw.updateEntry("c", (entry) => { entry.content = "changed"; });
    gw.truncateFrom("b");

    expect(log.entries.map((entry) => entry.id)).toEqual(["a"]);
    const records = gw.drainPendingRecords(3);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ op: "truncate", seq: 3, fromEntryId: "b" });
  });

  it("compact_marker 的 discarded 翻转走整条 upsert，而不是 patch", () => {
    const log = new SessionLog();
    const marker = createCompactMarker("cm-1", 1, 0, 100, 10);
    log.append(marker);
    gateway(log).drainPendingRecords(2);

    const gw = gateway(log);
    gw.patchFlags([marker.id], { discarded: true });
    const first = gw.drainPendingRecords(3);
    expect(first).toHaveLength(1);
    expect(first[0].op).toBe("upsert");
    expect(entryIds(first[0])).toEqual(["cm-1"]);
    expect((first[0] as UpsertRecord).entries[0].discarded).toBe(true);

    gw.patchFlags([marker.id], { discarded: false });
    const second = gw.drainPendingRecords(4);
    expect(second).toHaveLength(1);
    expect(second[0].op).toBe("upsert");
    expect((second[0] as UpsertRecord).entries[0].discarded).toBeUndefined();
  });

  it("truncate 后同 id 重新添加：再次写视为创建，不是覆盖", () => {
    const log = new SessionLog();
    log.append(assistant("asst-1"));
    gateway(log).drainPendingRecords(2);
    gateway(log).truncateFrom("asst-1");
    gateway(log).drainPendingRecords(3);

    log.append(assistant("asst-1"));
    const records = gateway(log).drainPendingRecords(4) as UpsertRecord[];
    expect(records).toHaveLength(1);
    expect(records[0].replaces).toBeUndefined();
  });

  it("不存在的 id：update/patch 静默忽略，不产生记录", () => {
    const log = new SessionLog();
    log.append(assistant("a"));
    gateway(log).drainPendingRecords(2);

    const gw = gateway(log);
    expect(() => gw.updateEntry("missing", (entry) => { entry.content = "x"; })).not.toThrow();
    expect(() => gw.patchFlags(["missing"], { archived: true })).not.toThrow();
    expect(gw.drainPendingRecords(3)).toEqual([]);
  });

  it("完整流程：追加/更新/丢弃/归档/回退 → 写盘 → 重放与内存逐项相等", () => {
    const dir = makeDir();
    const log = new SessionLog();
    const gw = gateway(log);
    let next = 2;

    appendRecords(dir, [sessionRecord(1)]);
    const flush = () => {
      const records = gw.drainPendingRecords(next);
      if (records.length > 0) {
        next += records.length;
        appendRecords(dir, records);
      }
    };

    log.append(assistant("a"));
    log.append(assistant("b"));
    log.append(assistant("c"));
    flush();

    gw.updateEntry("a", (entry) => { entry.content = "a-updated"; });
    gw.patchFlags(["b"], { archived: true }, { dropPresentation: true });
    gw.updateEntry("c", (entry) => { entry.discarded = true; });
    gw.truncateFrom("c");
    log.append(assistant("d"));
    flush();

    const replayed = loadLogJsonl(dir);
    expect(replayed.entries).toEqual(log.entries);
    expect(gw.drainPendingRecords(next)).toEqual([]);
  });

  it("绕过网关直接改 entries：assertNoDirectMutations 必须抛错", () => {
    const log = new SessionLog();
    gateway(log).enableDirectMutationGuard();
    log.append(assistant("a"));
    gateway(log).drainPendingRecords(2);

    log.entries[0].display = "mutated-behind-the-gateway";
    expect(() => gateway(log).assertNoDirectMutations()).toThrow(/direct|mutation|网关/i);
  });
});

describe("fork 与 JSONL", () => {
  function seedParent(): { homeDir: string; sessionDir: string } {
    const homeDir = makeDir("swarmflow-jsonl-fork-");
    const projectDir = join(homeDir, "projects", "demo");
    const sessionDir = join(projectDir, "s-parent");
    mkdirSync(sessionDir, { recursive: true });

    const session = {
      v: LOG_JSONL_VERSION,
      op: "session" as const,
      seq: 1,
      ts: "2026-10-23T00:00:00.000Z",
      session: {
        session_id: "s-parent",
        created_at: "2026-10-23T00:00:00Z",
        updated_at: "2026-10-23T00:00:00Z",
        project_path: "/work/demo",
        model_config_name: "test-model",
        summary: "",
        title: "Parent",
        turn_count: 1,
        compact_count: 0,
        thinking_level: "medium",
      },
    };
    const upsert: UpsertRecord = {
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: 2,
      ts: "2026-10-23T00:00:01.000Z",
      entries: [{ id: "asst-1", type: "assistant_text", timestamp: 1, turn_index: 1, content: "hi", display: "hi", meta: {} }],
    };
    appendRecords(sessionDir, [session, upsert]);
    writeFileSync(join(sessionDir, "meta.json"), JSON.stringify({
      session_id: "s-parent",
      created_at: "2026-10-23T00:00:00Z",
      last_active_at: "2026-10-23T00:00:00Z",
      title: "Parent",
      summary: "",
      turn_count: 1,
    }), "utf-8");
    return { homeDir, sessionDir };
  }

  it("fork 只凭 log.jsonl 也能工作；新 header 是 fork 自己的 id/title", () => {
    const { sessionDir } = seedParent();
    const forked = forkSessionDirectory(sessionDir);

    expect(forked.sessionId).not.toBe("s-parent");
    expect(existsSync(join(forked.sessionDir, LOG_JSONL_FILENAME))).toBe(true);

    const header = readLogHeader(forked.sessionDir);
    expect(header.sessionId).toBe(forked.sessionId);
    expect(header.title).toBe("(branch) Parent");

    const original = readLogHeader(sessionDir);
    expect(original.sessionId).toBe("s-parent");
    expect(original.title).toBe("Parent");
  });

  it("fork 后两个文件独立增长，互不影响", () => {
    const { sessionDir } = seedParent();
    const forked = forkSessionDirectory(sessionDir);
    const parentFile = join(sessionDir, LOG_JSONL_FILENAME);
    const forkFile = join(forked.sessionDir, LOG_JSONL_FILENAME);

    const parentBefore = readFileSync(parentFile);
    const forkBefore = readFileSync(forkFile);

    appendRecords(forked.sessionDir, [{
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: 3,
      ts: "2026-10-23T00:00:02.000Z",
      entries: [{ id: "asst-2", type: "assistant_text", timestamp: 2, turn_index: 1, content: "fork", display: "fork", meta: {} }],
    }]);

    expect(readFileSync(parentFile).equals(parentBefore)).toBe(true);
    expect(readFileSync(forkFile).length).toBeGreaterThan(forkBefore.length);

    const forkAfter = readFileSync(forkFile);
    appendRecords(sessionDir, [{
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: 3,
      ts: "2026-10-23T00:00:03.000Z",
      entries: [{ id: "asst-3", type: "assistant_text", timestamp: 3, turn_index: 1, content: "parent", display: "parent", meta: {} }],
    }]);
    expect(readFileSync(forkFile).equals(forkAfter)).toBe(true);
  });
});
