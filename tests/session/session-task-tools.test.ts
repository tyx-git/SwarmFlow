import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeScriptedSession, type SessionHarness } from "../helpers/session-harness.js";

let harness: SessionHarness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

/** 通过会话私有的执行器字典调用任务工具（与真实工具调用走同一条路径）。 */
async function exec(name: string, args: Record<string, unknown>): Promise<string> {
  const executors = harness!.internals._toolExecutors as Record<
    string,
    (a: Record<string, unknown>) => Promise<{ content?: unknown }> | { content?: unknown }
  >;
  const result = await executors[name](args);
  return String(result.content ?? "");
}

describe("session task wiring", () => {
  it("exposes every task tool to the root agent", () => {
    harness = makeScriptedSession();
    const names = harness.session.primaryAgent.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["task_create", "task_list", "task_get", "task_update", "task_resume"]),
    );
  });

  it("creates, lists, reads and updates tasks, and writes tasks.json", async () => {
    harness = makeScriptedSession();

    const created = await exec("task_create", {
      subject: "Wire the task layer",
      description: "Make the task tools callable.",
      active_form: "Wiring the task layer",
      metadata: { agentId: "scout-1" },
    });
    expect(created).toContain("Task #1 created: Wire the task layer");

    // 内存态即时可见（读路径不读盘）
    expect(harness.session.getTaskState().map((task) => [task.id, task.status])).toEqual([["1", "pending"]]);
    expect(harness.session.getTaskState()[0].activeForm).toBe("Wiring the task layer");
    expect(harness.session.getTaskState()[0].metadata["agentId"]).toBe("scout-1");

    // write-through：变更即落盘
    const artifactsDir = harness.internals._getArtifactsDirIfAvailable() as string;
    const file = join(artifactsDir, "tasks.json");
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as { sessionId: string; tasks: Array<{ subject: string }> };
    expect(onDisk.tasks[0].subject).toBe("Wire the task layer");
    expect(onDisk.sessionId.length).toBeGreaterThan(0);

    const listed = await exec("task_list", {});
    expect(listed).toContain("#1 [pending] Wire the task layer (scout-1)");

    const got = await exec("task_get", { task_id: "1" });
    expect(got).toContain("Task #1: Wire the task layer");
    expect(got).toContain("Description: Make the task tools callable.");

    const updated = await exec("task_update", { task_id: "1", status: "in_progress" });
    expect(updated).toContain("Updated task #1 status");
    expect(harness.session.getTaskState()[0].status).toBe("in_progress");

    // 依赖边双向维护 + 告警透出
    await exec("task_create", { subject: "Second", description: "d" });
    const edge = await exec("task_update", { task_id: "2", add_blocked_by: ["1"] });
    expect(edge).toContain("Updated task #2 blockedBy");
    expect(harness.session.getTaskState()[1].blockedBy).toEqual(["1"]);
    expect(harness.session.getTaskState()[0].blocks).toEqual(["2"]);

    const selfEdge = await exec("task_update", { task_id: "2", add_blocked_by: ["2"] });
    expect(selfEdge).toContain("warning: #2 blocks itself");
  });

  it("reports argument errors without touching the store", async () => {
    harness = makeScriptedSession();
    expect(await exec("task_create", { subject: "no description" })).toContain("Error:");
    expect(await exec("task_get", { task_id: "9" })).toContain("Task #9 not found");
    expect(await exec("task_update", { task_id: "1", status: "bogus" })).toContain("Error: 'status' must be one of");
    expect(harness.session.getTaskState()).toEqual([]);

    await exec("task_create", { subject: "A", description: "d" });
    const noHint = await exec("task_resume", { task_id: "1" });
    expect(noHint).toContain("has no interrupted run to resume");
  });

  it("notifies subscribers on every mutation", async () => {
    harness = makeScriptedSession();
    let notifications = 0;
    const unsubscribe = harness.session.subscribeTaskState(() => {
      notifications += 1;
    });
    await exec("task_create", { subject: "A", description: "d" });
    await exec("task_update", { task_id: "1", status: "completed" });
    unsubscribe();
    await exec("task_create", { subject: "B", description: "d" });
    expect(notifications).toBe(2);
  });
});

describe("session restart reconciliation", () => {
  it("downgrades in-progress tasks and records an interrupted marker", async () => {
    harness = makeScriptedSession();
    await exec("task_create", { subject: "Dispatched work", description: "d", metadata: { agentId: "scout-1" } });
    await exec("task_update", { task_id: "1", status: "in_progress" });
    await exec("task_create", { subject: "Own work", description: "d" });
    await exec("task_update", { task_id: "2", status: "in_progress" });

    const result = harness.session.reconcileTaskListAfterRestore();

    const tasks = harness.session.getTaskState();
    expect(tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
    expect(typeof tasks[0].metadata["interruptedAt"]).toBe("number");
    // 该子代理并没有恢复出来的会话 → 判定为不可续，并给出原因
    expect(tasks[0].metadata["resumeHint"]).toMatchObject({ childId: "scout-1", resumable: false, reason: "log_unavailable" });
    // 父自己推进的任务只降级，不给续跑建议
    expect(tasks[1].metadata["resumeHint"]).toBeUndefined();

    expect(result.warnings.join("\n")).toContain("重启对账");
    expect(result.notice).toContain("<task-reconciliation>");
    expect(result.notice).toContain("#1 Dispatched work");
  });

  it("is a no-op when nothing is in progress and on repeated calls", async () => {
    harness = makeScriptedSession();
    expect(harness.session.reconcileTaskListAfterRestore()).toEqual({ warnings: [] });

    await exec("task_create", { subject: "A", description: "d" });
    await exec("task_update", { task_id: "1", status: "in_progress" });
    const first = harness.session.reconcileTaskListAfterRestore();
    expect(first.warnings.length).toBeGreaterThan(0);
    expect(harness.session.reconcileTaskListAfterRestore()).toEqual({ warnings: [] });
  });

  it("queues the model-visible notice as a ride-along system message", async () => {
    harness = makeScriptedSession();
    harness.session.deliverRestoreNotice("<task-reconciliation>test</task-reconciliation>");
    const inbox = harness.internals._inbox as Array<{ type: string; wake?: boolean; tuiVisible?: boolean }>;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ type: "system_notice", wake: false, tuiVisible: false });
  });
});

describe("session fork reconciliation", () => {
  it("sanitizes inherited tasks instead of offering a resume", async () => {
    harness = makeScriptedSession();
    await exec("task_create", {
      subject: "Inherited work",
      description: "d",
      metadata: { agentId: "scout-1", result: "partial" },
    });
    await exec("task_update", { task_id: "1", status: "in_progress", owner: "scout-1" });

    const result = harness.session.reconcileTaskListAfterRestore({ fork: true });

    const task = harness.session.getTaskState()[0];
    expect(task.status).toBe("pending");
    expect(task.metadata["agentId"]).toBeUndefined();
    expect(task.metadata["result"]).toBeUndefined();
    expect(task.metadata["resumeHint"]).toBeUndefined();
    expect(task.owner).toBeUndefined();
    // 分叉不提供续跑：给出分叉专用提示，且通知里没有任何"可续跑"字样
    expect(result.warnings.join("\n")).toContain("分叉对账");
    expect(result.notice ?? "").toContain("Nothing can be resumed in a fork");
    expect(result.notice ?? "").not.toContain("call task_resume");
  });

  it("is a no-op on a fork with no inherited task state", () => {
    harness = makeScriptedSession();
    expect(harness.session.reconcileTaskListAfterRestore({ fork: true })).toEqual({ warnings: [] });
  });
});

describe("task persistence boundary", () => {
  it("reports file-backed storage for a normal session", () => {
    harness = makeScriptedSession();
    expect(harness.session.getTaskPersistence()).toBe("file");
  });

  it("reports memory only when the session genuinely has no task storage", () => {
    harness = makeScriptedSession();
    // 子会话形态：清单为纯内存（子代理不写持久化文件）
    harness.internals._taskStoreScope = "memory";
    expect(harness.session.getTaskPersistence()).toBe("memory");
  });

  it("keeps the store usable while storage is still pending", async () => {
    harness = makeScriptedSession();
    harness.internals._store = { sessionDir: undefined };
    const created = await exec("task_create", { subject: "Before storage", description: "d" });
    expect(created).toContain("Task #1 created");
    expect(harness.session.getTaskState().map((task) => task.subject)).toEqual(["Before storage"]);
    // 过渡态下没有落盘错误（内存态仍有效，且不会误报"不持久化"）
    expect(created).not.toContain("warning");
  });
});


describe("new user turn task cleanup", () => {
  it("clears completed tasks before the model can list them and writes the empty store", async () => {
    harness = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "list-after-cleanup", name: "task_list", arguments: {} }] },
        { text: "ready for the next task" },
      ],
    });
    await exec("task_create", { subject: "Old completed work", description: "already done" });
    await exec("task_update", { task_id: "1", status: "completed" });

    let notifications = 0;
    const unsubscribe = harness.session.subscribeTaskState(() => {
      notifications += 1;
    });
    const file = join(harness.internals._getArtifactsDirIfAvailable() as string, "tasks.json");

    await harness.session.turn("Start a new user turn");

    expect(harness.session.getTaskState()).toEqual([]);
    expect(harness.provider.sawToolResultText("No tasks found")).toBe(true);
    expect(harness.provider.sawToolResultText("Old completed work")).toBe(false);
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as { tasks: unknown[] };
    expect(onDisk.tasks).toEqual([]);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("preserves every task and emits no cleanup notification when any task is unfinished", async () => {
    harness = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "list-preserved", name: "task_list", arguments: {} }] },
        { text: "continuing existing work" },
      ],
    });
    await exec("task_create", { subject: "Pending work", description: "not started" });
    await exec("task_create", { subject: "Active work", description: "in progress" });
    await exec("task_update", { task_id: "2", status: "in_progress" });
    await exec("task_create", { subject: "Completed work", description: "done" });
    await exec("task_update", { task_id: "3", status: "completed" });

    let notifications = 0;
    const unsubscribe = harness.session.subscribeTaskState(() => {
      notifications += 1;
    });
    await harness.session.turn("Continue the current work");

    expect(harness.session.getTaskState().map((task) => [task.subject, task.status])).toEqual([
      ["Pending work", "pending"],
      ["Active work", "in_progress"],
      ["Completed work", "completed"],
    ]);
    expect(harness.provider.sawToolResultText("Pending work")).toBe(true);
    expect(harness.provider.sawToolResultText("Active work")).toBe(true);
    expect(harness.provider.sawToolResultText("Completed work")).toBe(true);
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it("does not call clearAll for an empty task list", async () => {
    harness = makeScriptedSession({ rounds: [{ text: "hello" }] });
    const store = harness.internals._ensureTaskStore() as {
      clearAll: () => { cleared: number };
    };
    let clearCalls = 0;
    const clearAll = store.clearAll.bind(store);
    store.clearAll = () => {
      clearCalls += 1;
      return clearAll();
    };
    let notifications = 0;
    const unsubscribe = harness.session.subscribeTaskState(() => {
      notifications += 1;
    });

    await harness.session.turn("A fresh turn with no old tasks");

    expect(clearCalls).toBe(0);
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it("does not clear completed tasks during compact or restore reconciliation", async () => {
    harness = makeScriptedSession({ rounds: [{ text: "compact summary" }] });
    await exec("task_create", { subject: "Completed before compact", description: "done" });
    await exec("task_update", { task_id: "1", status: "completed" });
    let notifications = 0;
    const unsubscribe = harness.session.subscribeTaskState(() => {
      notifications += 1;
    });

    await harness.session.runManualCompact();
    expect(harness.session.getTaskState().map((task) => task.subject)).toEqual(["Completed before compact"]);
    expect(harness.session.reconcileTaskListAfterRestore()).toEqual({ warnings: [] });
    expect(harness.session.getTaskState().map((task) => task.subject)).toEqual(["Completed before compact"]);
    expect(notifications).toBe(0);
    unsubscribe();
  });
});
