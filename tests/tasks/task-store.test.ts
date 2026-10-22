import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RESUME_MAX_ATTEMPTS } from "../../src/tasks/types.js";
import { TASK_SNAPSHOT_MAX_COMPLETED, formatTaskSnapshot } from "../../src/tasks/snapshot.js";
import { TaskStore, taskStorePath } from "../../src/tasks/store.js";
import { isWorthResuming } from "../../src/tasks/resume.js";
import { normalizeTask } from "../../src/tasks/normalize.js";
import type { TaskResumeHint } from "../../src/tasks/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-task-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function hint(overrides: Partial<TaskResumeHint> = {}): TaskResumeHint {
  return { childId: "scout-1", toolCalls: 12, tokensIn: 40_000, resumable: true, reason: "in_progress_work", ...overrides };
}

describe("TaskStore CRUD", () => {
  it("assigns increasing ids and starts pending", () => {
    const store = TaskStore.memory();
    const a = store.create("First", "desc a");
    const b = store.create("Second", "desc b", "Doing second");
    expect(a.task.id).toBe("1");
    expect(b.task.id).toBe("2");
    expect(a.task.status).toBe("pending");
    expect(b.task.activeForm).toBe("Doing second");
    expect(store.list().map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("merges metadata and deletes keys set to null", () => {
    const store = TaskStore.memory();
    const { task } = store.create("T", "d");
    store.update(task.id, { metadata: { agentId: "a1", note: "x" } });
    const result = store.update(task.id, { metadata: { note: null, extra: 2 } });
    expect(result.changedFields).toEqual(["metadata"]);
    expect(result.task?.metadata).toEqual({ agentId: "a1", extra: 2 });
    expect("note" in (result.task?.metadata ?? {})).toBe(false);
  });

  it("does not save when no field changed", () => {
    const store = TaskStore.memory();
    const { task } = store.create("T", "d");
    const result = store.update(task.id, {});
    expect(result.changedFields).toEqual([]);
    expect(result.saveError).toBeUndefined();
  });

  it("maintains dependency edges in both directions", () => {
    const store = TaskStore.memory();
    const a = store.create("A", "d").task;
    const b = store.create("B", "d").task;
    const result = store.update(b.id, { addBlockedBy: [a.id] });
    expect(result.warnings).toEqual([]);
    expect(store.get(b.id)?.blockedBy).toEqual([a.id]);
    expect(store.get(a.id)?.blocks).toEqual([b.id]);
  });

  it("warns on self-dependency, dangling reference and cycle", () => {
    const store = TaskStore.memory();
    const a = store.create("A", "d").task;
    const b = store.create("B", "d").task;

    expect(store.update(a.id, { addBlockedBy: [a.id] }).warnings).toEqual([`#${a.id} blocks itself`]);
    expect(store.update(a.id, { addBlocks: ["99"] }).warnings).toEqual(["#99 does not exist"]);

    // a 阻塞 b（a.blocks += b）
    store.update(a.id, { addBlocks: [b.id] });
    // 反向再来一次才是环：b.blocks += a
    expect(store.update(b.id, { addBlocks: [a.id] }).warnings).toEqual([`cycle: #${b.id} and #${a.id} block each other`]);

    const c = store.create("C", "d").task;
    const d = store.create("D", "d").task;
    store.update(c.id, { addBlockedBy: [d.id] });
    expect(store.update(d.id, { addBlockedBy: [c.id] }).warnings).toEqual([`cycle: #${d.id} and #${c.id} block each other`]);
  });

  it("prunes edges when a task is deleted via status", () => {
    const store = TaskStore.memory();
    const a = store.create("A", "d").task;
    const b = store.create("B", "d").task;
    store.update(b.id, { addBlockedBy: [a.id] });
    const result = store.update(a.id, { status: "deleted" });
    expect(result.changedFields).toEqual(["deleted"]);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)?.blockedBy).toEqual([]);
  });

  it("clears completed tasks and their edges", () => {
    const store = TaskStore.memory();
    const a = store.create("A", "d").task;
    const b = store.create("B", "d").task;
    store.update(b.id, { addBlockedBy: [a.id] });
    store.update(a.id, { status: "completed" });
    expect(store.clearCompleted()).toEqual({ cleared: 1, saveError: undefined });
    expect(store.get(b.id)?.blockedBy).toEqual([]);
    expect(store.list().map((t) => t.id)).toEqual([b.id]);
  });
});

describe("TaskStore reconcile support", () => {
  it("downgrades every in_progress task and attaches a hint by agent id", () => {
    const store = TaskStore.memory();
    const dispatched = store.create("Dispatched", "d").task;
    const own = store.create("Own work", "d").task;
    const done = store.create("Done", "d").task;
    store.update(dispatched.id, { status: "in_progress", metadata: { agentId: "scout-1" } });
    store.update(own.id, { status: "in_progress" });
    store.update(done.id, { status: "completed" });

    const result = store.markInterrupted({ "scout-1": hint() }, 1_700_000_000_000);

    expect(result.changed.sort()).toEqual([dispatched.id, own.id].sort());
    const upgraded = store.get(dispatched.id);
    expect(upgraded?.status).toBe("pending");
    expect(upgraded?.metadata["interruptedAt"]).toBe(1_700_000_000_000);
    expect(upgraded?.metadata["resumeHint"]).toEqual(hint());
    expect(upgraded?.metadata["agentId"]).toBe("scout-1");

    const ownTask = store.get(own.id);
    expect(ownTask?.status).toBe("pending");
    expect(ownTask?.metadata["interruptedAt"]).toBe(1_700_000_000_000);
    expect(ownTask?.metadata["resumeHint"]).toBeUndefined();
    expect(store.get(done.id)?.status).toBe("completed");
  });

  it("does not touch tasks that are not in progress", () => {
    const store = TaskStore.memory();
    const task = store.create("T", "d").task;
    expect(store.markInterrupted({}, 1).changed).toEqual([]);
    expect(store.get(task.id)?.metadata["interruptedAt"]).toBeUndefined();
  });

  it("resumes a hinted task, clears the marker and counts attempts", () => {
    const store = TaskStore.memory();
    const task = store.create("T", "d").task;
    store.update(task.id, { status: "in_progress", metadata: { agentId: "scout-1" } });
    store.markInterrupted({ "scout-1": hint() }, 1);

    const first = store.beginResume(task.id);
    expect(first.ok).toBe(true);
    expect(first.task?.status).toBe("in_progress");
    expect(first.task?.metadata["resumeAttempts"]).toBe(1);
    expect(first.task?.metadata["interruptedAt"]).toBeUndefined();
  });

  it("refuses resume when not resumable, superseded or attempts exhausted", () => {
    const store = TaskStore.memory();
    const task = store.create("T", "d").task;
    store.update(task.id, { status: "in_progress", metadata: { agentId: "scout-1" } });

    store.markInterrupted({ "scout-1": hint({ resumable: false, reason: "too_early" }) }, 1);
    expect(store.beginResume(task.id).reason).toBe("too_early");

    store.update(task.id, { metadata: { resumeHint: hint() } });
    store.update(task.id, { metadata: { agentId: "worker-2" } });
    expect(store.beginResume(task.id).reason).toBe("superseded");

    store.update(task.id, { metadata: { agentId: "scout-1" } });
    expect(store.beginResume(task.id).ok).toBe(true);
    for (let i = 1; i < RESUME_MAX_ATTEMPTS; i++) store.beginResume(task.id);
    expect(store.beginResume(task.id).reason).toBe("attempts_exhausted");
  });

  it("refuses resume without a hint or for completed tasks", () => {
    const store = TaskStore.memory();
    const task = store.create("T", "d").task;
    expect(store.beginResume(task.id).reason).toBe("no_resume_hint");
    expect(store.beginResume("99").reason).toBe("not_found");

    store.update(task.id, { status: "in_progress", metadata: { agentId: "scout-1" } });
    store.markInterrupted({ "scout-1": hint() }, 1);
    store.update(task.id, { status: "completed" });
    expect(store.beginResume(task.id).reason).toBe("already_completed");
  });
});

describe("TaskStore persistence", () => {
  it("reloads planned roles and repairs dependency edges in both directions", () => {
    const dir = makeTempDir();
    const filePath = taskStorePath(dir);
    const store = new TaskStore({ filePath, sessionId: "s1" });
    const scout = store.create("Explore", "read only", undefined, undefined, "scout").task;
    const worker = store.create("Implement", "write code", undefined, undefined, "worker").task;
    store.update(worker.id, { addBlockedBy: [scout.id] });

    const reloaded = new TaskStore({ filePath, sessionId: "s1" });
    expect(reloaded.get(scout.id)?.role).toBe("scout");
    expect(reloaded.get(worker.id)?.role).toBe("worker");
    expect(reloaded.get(worker.id)?.blockedBy).toEqual([scout.id]);
    expect(reloaded.get(scout.id)?.blocks).toEqual([worker.id]);
  });

  it("writes through and reloads from disk", () => {
    const dir = makeTempDir();
    const filePath = taskStorePath(dir);
    const store = new TaskStore({ filePath, sessionId: "s1" });
    const { task } = store.create("Persisted", "desc", "Persisting");
    store.update(task.id, { status: "in_progress", metadata: { agentId: "a1" } });

    const reloaded = new TaskStore({ filePath, sessionId: "s1" });
    expect(reloaded.list().map((t) => [t.id, t.subject, t.status])).toEqual([[task.id, "Persisted", "in_progress"]]);
    expect(reloaded.get(task.id)?.activeForm).toBe("Persisting");
    expect(reloaded.get(task.id)?.metadata["agentId"]).toBe("a1");

    const onDisk = JSON.parse(readFileSync(filePath, "utf-8")) as { version: number; sessionId: string; nextId: number };
    expect(onDisk.sessionId).toBe("s1");
    expect(onDisk.nextId).toBe(2);
  });

  it("keeps the in-memory store usable when nothing is persisted yet", () => {
    const store = TaskStore.memory();
    store.create("Only memory", "d");
    expect(store.isFileBacked).toBe(false);
    expect(store.lastSaveError).toBeUndefined();
  });

  it("recomputes nextId so ids never collide after a hand-edited file", () => {
    const dir = makeTempDir();
    const filePath = taskStorePath(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        sessionId: "s1",
        nextId: 1,
        tasks: [{ id: "7", subject: "seven", description: "", status: "pending", metadata: {}, blocks: [], blockedBy: [] }],
      }),
    );
    const store = new TaskStore({ filePath, sessionId: "s1" });
    expect(store.create("new", "d").task.id).toBe("8");
  });

  it("keeps current state when the file envelope is unusable", () => {
    const dir = makeTempDir();
    const filePath = taskStorePath(dir);
    writeFileSync(filePath, JSON.stringify({ version: 1, sessionId: "s1" }));
    const store = new TaskStore({ filePath, sessionId: "s1" });
    expect(store.count).toBe(0);
    expect(store.create("after bad load", "d").task.id).toBe("1");
  });

  it("neither loads nor overwrites a file owned by another session", () => {
    const dir = makeTempDir();
    const filePath = taskStorePath(dir);
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, sessionId: "other", nextId: 3, tasks: [{ id: "1", subject: "theirs", description: "", status: "pending", metadata: {}, blocks: [], blockedBy: [] }] }),
    );
    const store = new TaskStore({ filePath, sessionId: "s1" });
    expect(store.isForeignFile).toBe(true);
    expect(store.count).toBe(0);

    const created = store.create("mine", "d");
    expect(created.saveError).toContain("属于其它会话");
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8")) as { sessionId: string; tasks: unknown[] };
    expect(onDisk.sessionId).toBe("other");
    expect(onDisk.tasks).toHaveLength(1);
  });

  it("surfaces a save failure without losing the in-memory change", () => {
    const dir = makeTempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const store = new TaskStore({ filePath: join(blocker, "tasks.json"), sessionId: "s1" });
    const created = store.create("T", "d");
    expect(created.saveError).toContain("任务落盘失败");
    expect(store.count).toBe(1);
  });
});

describe("normalizeTask", () => {
  it("repairs missing or wrongly typed fields", () => {
    const task = normalizeTask({ id: "3", subject: "S" });
    expect(task).toMatchObject({ id: "3", subject: "S", status: "pending", blocks: [], blockedBy: [], metadata: {} });
    expect(typeof task?.createdAt).toBe("number");
  });

  it("drops records without a usable id or subject", () => {
    expect(normalizeTask({ subject: "no id" })).toBeUndefined();
    expect(normalizeTask({ id: "1" })).toBeUndefined();
    expect(normalizeTask(null)).toBeUndefined();
    expect(normalizeTask("nope")).toBeUndefined();
  });
});

describe("isWorthResuming", () => {
  it("uses an OR threshold so either signal qualifies", () => {
    expect(isWorthResuming(9, 29_999)).toBe(false);
    expect(isWorthResuming(10, 0)).toBe(true);
    expect(isWorthResuming(0, 30_000)).toBe(true);
  });
});

describe("formatTaskSnapshot", () => {
  it("returns an empty string for an empty list", () => {
    expect(formatTaskSnapshot([])).toBe("");
  });

  it("lists open tasks first, then recent completed ones, with owners and hints", () => {
    const store = TaskStore.memory();
    const first = store.create("Finished", "d").task;
    const second = store.create("Running", "d").task;
    const third = store.create("Waiting", "d").task;
    store.update(first.id, { status: "completed" });
    // third 由子代理推进 → 重启对账后降级为 pending 并带续跑提示
    store.update(third.id, { status: "in_progress", metadata: { agentId: "scout-1" } });
    store.markInterrupted({ "scout-1": hint() });
    // second 是本轮新开始的工作（对账之后），应保持 in_progress
    store.update(second.id, { status: "in_progress", metadata: { agentId: "worker-1" } });

    const snapshot = formatTaskSnapshot(store.list());
    expect(snapshot.startsWith("[Current Tasks]")).toBe(true);
    expect(snapshot).toContain(`- #${second.id} [in_progress] Running (owner: worker-1)`);
    expect(snapshot).toContain(`- #${third.id} [pending] Waiting (owner: scout-1) (interrupted — resumable via task_resume)`);
    expect(snapshot).toContain(`- #${first.id} [completed] Finished`);
    // 未完成项在已完成项之前
    expect(snapshot.indexOf("Running")).toBeLessThan(snapshot.indexOf("Finished"));
  });

  it("caps how many completed tasks it keeps", () => {
    const store = TaskStore.memory();
    for (let i = 0; i < TASK_SNAPSHOT_MAX_COMPLETED + 3; i++) {
      const task = store.create(`done-${i}`, "d").task;
      store.update(task.id, { status: "completed" });
    }
    const snapshot = formatTaskSnapshot(store.list());
    expect(snapshot).toContain("… and 3 earlier completed task(s)");
    expect(snapshot).not.toContain("done-0");
    expect(snapshot).toContain(`done-${TASK_SNAPSHOT_MAX_COMPLETED + 2}`);
  });

  it("renders dependency edges for open tasks", () => {
    const store = TaskStore.memory();
    const parent = store.create("Parent", "d").task;
    const child = store.create("Child", "d").task;
    store.update(parent.id, { addBlocks: [child.id] });
    store.update(child.id, { addBlockedBy: [parent.id] });

    const snapshot = formatTaskSnapshot(store.list());
    expect(snapshot).toContain(`- #${parent.id} [pending] Parent (blocks: #${child.id})`);
    expect(snapshot).toContain(`- #${child.id} [pending] Child (blocked by: #${parent.id})`);
  });

  it("marks non-resumable interruptions as needing re-dispatch", () => {
    const store = TaskStore.memory();
    const task = store.create("Stuck", "d").task;
    store.update(task.id, { status: "in_progress", metadata: { agentId: "scout-9" } });
    store.markInterrupted({ "scout-9": hint({ childId: "scout-9", resumable: false, reason: "too_early" }) });
    expect(formatTaskSnapshot(store.list())).toContain("(interrupted — needs re-dispatch)");
  });
});

describe("sanitizeForFork", () => {
  it("keeps task content but drops every link to the parent run", () => {
    const store = TaskStore.memory();
    const task = store.create("Inherited", "desc", "Inheriting").task;
    store.update(task.id, {
      status: "in_progress",
      owner: "worker-1",
      metadata: { agentId: "worker-1", result: "partial", lastError: "boom", taskSummary: { total: 2, open: 1, done: 1 } },
    });
    store.markInterrupted({ "worker-1": hint({ childId: "worker-1" }) });

    const result = store.sanitizeForFork(1_700_000_000_000);

    expect(result.changed).toEqual([task.id]);
    const forked = store.get(task.id);
    expect(forked?.status).toBe("pending");
    expect(forked?.owner).toBeUndefined();
    expect(forked?.metadata).toEqual({});
    expect(forked?.subject).toBe("Inherited");
    expect(forked?.activeForm).toBe("Inheriting");
  });

  it("is a no-op for tasks with nothing to sanitize", () => {
    const store = TaskStore.memory();
    store.create("Plain", "d");
    expect(store.sanitizeForFork().changed).toEqual([]);
  });

  it("persists the sanitized list when file-backed", () => {
    const dir = makeTempDir();
    const filePath = taskStorePath(dir);
    const store = new TaskStore({ filePath, sessionId: "s1" });
    const task = store.create("T", "d").task;
    store.update(task.id, { status: "in_progress", metadata: { agentId: "a1" } });
    store.sanitizeForFork();

    const reloaded = new TaskStore({ filePath, sessionId: "s1" });
    expect(reloaded.get(task.id)?.status).toBe("pending");
    expect(reloaded.get(task.id)?.metadata["agentId"]).toBeUndefined();
  });
});
