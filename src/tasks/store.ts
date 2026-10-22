/**
 * 任务清单领域：内存为权威，`tasks.json` 为 write-through 持久副本。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { asOptionalString, compareIdStrings, normalizeTask, sameStrings } from "./normalize.js";
import { asNonNegativeInt, asResumeHint } from "./resume.js";
import { compareById, edgeWarning } from "./snapshot.js";
import { RESUME_MAX_ATTEMPTS, TASK_STORE_FILENAME, TASK_STORE_VERSION } from "./types.js";
import type {
  Task,
  TaskStoreData,
  TaskUpdateFields,
  TaskUpdateResult,
  TaskMutationResult,
  TaskResumeHint,
} from "./types.js";

/** 会话工件目录下的任务文件路径。 */
export function taskStorePath(artifactsDir: string): string {
  return join(artifactsDir, TASK_STORE_FILENAME);
}

// ------------------------------------------------------------------
// Store
// ------------------------------------------------------------------

export class TaskStore {
  private readonly _filePath: string | undefined;
  private readonly _sessionId: string;
  private _nextId = 1;
  private _tasks = new Map<string, Task>();
  private _lastSaveError: string | undefined;
  private _blockedSaveError: string | undefined;
  /** 文件属于别的会话：不载入、也拒绝覆盖（防两个进程互踩同一会话）。 */
  private _foreignFile = false;

  constructor(opts: { filePath?: string; sessionId?: string } = {}) {
    this._filePath = opts.filePath;
    this._sessionId = opts.sessionId && opts.sessionId.length > 0 ? opts.sessionId : "session";
    if (this._filePath) this._load();
  }

  /** 纯内存 store（子会话用）：随对象消亡，不落盘。 */
  static memory(): TaskStore {
    return new TaskStore();
  }

  get isFileBacked(): boolean {
    return this._filePath !== undefined;
  }

  get lastSaveError(): string | undefined {
    return this._lastSaveError;
  }

  /** 文件属于其它会话（既未载入也不可写）。 */
  get isForeignFile(): boolean {
    return this._foreignFile;
  }

  // -- 载入 / 落盘 --------------------------------------------------

  private _load(): void {
    const path = this._filePath;
    if (!path || !existsSync(path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this._blockedSaveError = "tasks.json has an invalid envelope; refusing to overwrite it.";
        this._lastSaveError = this._blockedSaveError;
        return;
      }
      const record = parsed as Partial<TaskStoreData>;
      const { tasks, nextId, sessionId } = record;
      if (record.version !== undefined && record.version !== TASK_STORE_VERSION) {
        this._blockedSaveError = `tasks.json version ${String(record.version)} is not supported; refusing to overwrite it.`;
        this._lastSaveError = this._blockedSaveError;
        return;
      }
      // 信封不可用（截断写入 / 手工编辑）→ 保持现状，绝不清空。
      if (!Array.isArray(tasks)) {
        this._blockedSaveError = "tasks.json has no valid task list; refusing to overwrite it.";
        this._lastSaveError = this._blockedSaveError;
        return;
      }
      if (typeof sessionId === "string" && sessionId.length > 0 && sessionId !== this._sessionId) {
        this._foreignFile = true;
        return;
      }

      // 先构建完整替换，坏记录不会留下半载入状态。
      const loaded = new Map<string, Task>();
      let maxId = 0;
      let needsRepair = false;
      const seenIds = new Set<string>();
      for (const raw of tasks) {
        const task = normalizeTask(raw);
        if (!task) {
          needsRepair = true;
          this._blockedSaveError = "tasks.json contains an invalid task record; refusing to overwrite it.";
          this._lastSaveError = this._blockedSaveError;
          continue;
        }
        if (seenIds.has(task.id)) {
          needsRepair = true;
          this._blockedSaveError = `tasks.json contains duplicate task id '${task.id}'; refusing to overwrite it.`;
          this._lastSaveError = this._blockedSaveError;
          continue;
        }
        seenIds.add(task.id);
        loaded.set(task.id, task);
        const numeric = Number(task.id);
        if (Number.isFinite(numeric) && numeric > maxId) maxId = numeric;
      }
      this._tasks = loaded;
      if (this._repairDependencyEdges()) needsRepair = true;
      // 未来的 id 全部来自这个计数器：必须以文件中已用 id 为下限重算，
      // 否则缺失/陈旧的 nextId 会产生重复 id。
      this._nextId = typeof nextId === "number" && Number.isInteger(nextId) && nextId > maxId ? nextId : maxId + 1;
      if (needsRepair && !this._blockedSaveError) this._save();
    } catch {
      this._blockedSaveError = "tasks.json is unreadable or invalid JSON; refusing to overwrite it.";
      this._lastSaveError = this._blockedSaveError;
    }
  }

  /** 根据仍有效的依赖边重建 DAG 的正反向引用。 */
  private _repairDependencyEdges(): boolean {
    const edges = new Set<string>();
    let repaired = false;
    for (const task of this._tasks.values()) {
      for (const targetId of task.blocks) {
        if (targetId === task.id || !this._tasks.has(targetId)) {
          repaired = true;
          continue;
        }
        edges.add(`${task.id}\0${targetId}`);
      }
      for (const sourceId of task.blockedBy) {
        if (sourceId === task.id || !this._tasks.has(sourceId)) {
          repaired = true;
          continue;
        }
        edges.add(`${sourceId}\0${task.id}`);
      }
    }

    const blocks = new Map<string, Set<string>>();
    const blockedBy = new Map<string, Set<string>>();
    for (const id of this._tasks.keys()) {
      blocks.set(id, new Set());
      blockedBy.set(id, new Set());
    }
    for (const edge of edges) {
      const [sourceId, targetId] = edge.split("\0");
      if (!sourceId || !targetId) continue;
      blocks.get(sourceId)!.add(targetId);
      blockedBy.get(targetId)!.add(sourceId);
    }

    for (const task of this._tasks.values()) {
      const nextBlocks = [...blocks.get(task.id)!].sort(compareIdStrings);
      const nextBlockedBy = [...blockedBy.get(task.id)!].sort(compareIdStrings);
      if (!sameStrings(task.blocks, nextBlocks) || !sameStrings(task.blockedBy, nextBlockedBy)) repaired = true;
      task.blocks = nextBlocks;
      task.blockedBy = nextBlockedBy;
    }
    return repaired;
  }

  private _save(): string | undefined {
    const path = this._filePath;
    if (!path) return undefined;
    if (this._foreignFile) {
      this._lastSaveError = `tasks.json 属于其它会话，已拒绝写入：${path}`;
      return this._lastSaveError;
    }
    if (this._blockedSaveError) {
      this._lastSaveError = this._blockedSaveError;
      return this._lastSaveError;
    }
    const data: TaskStoreData = {
      version: TASK_STORE_VERSION,
      sessionId: this._sessionId,
      nextId: this._nextId,
      updatedAt: new Date().toISOString(),
      tasks: [...this._tasks.values()],
    };
    let tmp = "";
    try {
      mkdirSync(dirname(path), { recursive: true });
      tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, path);
      this._lastSaveError = undefined;
      return undefined;
    } catch (error) {
      if (tmp) {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
      const message = error instanceof Error ? error.message : String(error);
      this._lastSaveError = `任务落盘失败（内存态仍有效）：${message}`;
      return this._lastSaveError;
    }
  }

  // -- 查询 ---------------------------------------------------------

  /** 按 id 升序返回全部任务。排序与裁剪由展示层负责。 */
  list(): Task[] {
    return [...this._tasks.values()].sort(compareById);
  }

  get(id: string): Task | undefined {
    return this._tasks.get(id);
  }

  get count(): number {
    return this._tasks.size;
  }

  /** 无副作用的快照（用于 fork 继承）。 */
  snapshot(): TaskStoreData {
    return {
      version: TASK_STORE_VERSION,
      sessionId: this._sessionId,
      nextId: this._nextId,
      updatedAt: new Date().toISOString(),
      tasks: [...this._tasks.values()],
    };
  }

  // -- 变更 ---------------------------------------------------------

  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, unknown>,
    role?: string,
  ): { task: Task } & TaskMutationResult {
    const now = Date.now();
    const task: Task = {
      id: String(this._nextId++),
      subject,
      description,
      status: "pending",
      metadata: metadata ? { ...metadata } : {},
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };
    if (role) task.role = role;
    if (activeForm) task.activeForm = activeForm;
    this._tasks.set(task.id, task);
    return { task, saveError: this._save() };
  }

  update(id: string, fields: TaskUpdateFields): TaskUpdateResult {
    const task = this._tasks.get(id);
    if (!task) return { changedFields: [], warnings: [] };

    const changedFields: string[] = [];
    const warnings: string[] = [];

    if (fields.status === "deleted") {
      this._deleteWithEdges(id);
      return { changedFields: ["deleted"], warnings, saveError: this._save() };
    }

    if (fields.status !== undefined) {
      task.status = fields.status;
      changedFields.push("status");
    }
    if (fields.subject !== undefined) {
      task.subject = fields.subject;
      changedFields.push("subject");
    }
    if (fields.description !== undefined) {
      task.description = fields.description;
      changedFields.push("description");
    }
    if (fields.role !== undefined) {
      task.role = fields.role;
      changedFields.push("role");
    }
    if (fields.activeForm !== undefined) {
      task.activeForm = fields.activeForm;
      changedFields.push("activeForm");
    }
    if (fields.owner !== undefined) {
      task.owner = fields.owner;
      changedFields.push("owner");
    }

    if (fields.metadata !== undefined) {
      for (const [key, raw] of Object.entries(fields.metadata)) {
        if (raw === null) delete task.metadata[key];
        else task.metadata[key] = raw;
      }
      changedFields.push("metadata");
    }

    if (fields.addBlocks && fields.addBlocks.length > 0) {
      for (const targetId of fields.addBlocks) {
        if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
        const target = this._tasks.get(targetId);
        if (target && !target.blockedBy.includes(id)) {
          target.blockedBy.push(id);
          target.updatedAt = Date.now();
        }
        const warning = edgeWarning(id, targetId, target, target?.blocks.includes(id) === true);
        if (warning) warnings.push(warning);
      }
      changedFields.push("blocks");
    }

    if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
      for (const targetId of fields.addBlockedBy) {
        if (!task.blockedBy.includes(targetId)) task.blockedBy.push(targetId);
        const target = this._tasks.get(targetId);
        if (target && !target.blocks.includes(id)) {
          target.blocks.push(id);
          target.updatedAt = Date.now();
        }
        const warning = edgeWarning(id, targetId, target, task.blocks.includes(targetId));
        if (warning) warnings.push(warning);
      }
      changedFields.push("blockedBy");
    }

    if (changedFields.length === 0) return { task, changedFields, warnings };

    task.updatedAt = Date.now();
    return { task, changedFields, warnings, saveError: this._save() };
  }

  delete(id: string): { deleted: boolean } & TaskMutationResult {
    if (!this._tasks.has(id)) return { deleted: false };
    this._deleteWithEdges(id);
    return { deleted: true, saveError: this._save() };
  }

  clearCompleted(): { cleared: number } & TaskMutationResult {
    let cleared = 0;
    for (const [id, task] of this._tasks) {
      if (task.status === "completed") {
        this._tasks.delete(id);
        cleared += 1;
      }
    }
    if (cleared > 0) this._pruneEdges();
    return { cleared, saveError: cleared > 0 ? this._save() : undefined };
  }

  clearAll(): { cleared: number } & TaskMutationResult {
    const cleared = this._tasks.size;
    this._tasks.clear();
    this._nextId = 1;
    return { cleared, saveError: cleared > 0 ? this._save() : undefined };
  }

  /**
   * 分叉消毒：分叉里从来没有活着的执行体。
   *
   * 清掉与父会话运行体的全部关联（`agentId` / `result` / `lastError` / 续跑痕迹 /
   * 子清单摘要），并把 `in_progress` 降级为 `pending` —— 分叉继承任务内容，
   * 但不继承"谁在做"。
   */
  sanitizeForFork(now = Date.now()): { changed: string[] } & TaskMutationResult {
    const dropped = [
      "agentId",
      "result",
      "lastError",
      "resumeHint",
      "resumeAttempts",
      "interruptedAt",
      "resumedAt",
      "lastSettledAt",
      "lastOutcome",
      "taskSummary",
      "childOpenTasks",
    ];
    const changed: string[] = [];
    for (const task of this._tasks.values()) {
      let touched = false;
      const metadata: Record<string, unknown> = { ...task.metadata };
      for (const key of dropped) {
        if (key in metadata) {
          delete metadata[key];
          touched = true;
        }
      }
      if (task.owner !== undefined) {
        delete task.owner;
        touched = true;
      }
      if (task.status === "in_progress") {
        task.status = "pending";
        touched = true;
      }
      if (!touched) continue;
      task.metadata = metadata;
      task.updatedAt = now;
      changed.push(task.id);
    }
    return { changed, saveError: changed.length > 0 ? this._save() : undefined };
  }

  // -- 启动对账 -----------------------------------------------------

  /**
   * 重启对账：把所有 `in_progress` 任务降级为 `pending` 并打上中断标记。
   *
   * 依据「重启后没有任何执行体是活的」这一不变量 —— 无论任务原本由父自己推进
   * 还是由子代理推进，`in_progress` 在此时都是错误信号（面板会显示在跑，
   * 但 `activeTaskIds` 已随进程清空）。
   *
   * `hints` 以 **子代理 id** 为键；命中时写入 `metadata.resumeHint`（建议，不是执行）。
   */
  markInterrupted(hints: Record<string, TaskResumeHint> = {}, now = Date.now()): { changed: string[] } & TaskMutationResult {
    const changed: string[] = [];
    for (const task of this._tasks.values()) {
      if (task.status !== "in_progress") continue;
      task.status = "pending";
      const metadata: Record<string, unknown> = { ...task.metadata, interruptedAt: now };
      const agentId = asOptionalString(task.metadata["agentId"]);
      const hint = agentId ? hints[agentId] : undefined;
      if (hint) metadata.resumeHint = { ...hint };
      task.metadata = metadata;
      task.updatedAt = now;
      changed.push(task.id);
    }
    return { changed, saveError: changed.length > 0 ? this._save() : undefined };
  }

  /**
   * 续跑前置：校验提示仍然有效，并把任务置回 `in_progress`。
   *
   * 守卫（任一不满足即拒绝）：
   *  - 存在 resumable 的 `resumeHint`
   *  - `resumeHint.childId` 仍等于 `metadata.agentId`（未被新的 run 接管）
   *  - `resumeAttempts < RESUME_MAX_ATTEMPTS`
   */
  beginResume(id: string): { ok: boolean; task?: Task; reason?: string } & TaskMutationResult {
    const task = this._tasks.get(id);
    if (!task) return { ok: false, reason: "not_found" };

    const hint = asResumeHint(task.metadata["resumeHint"]);
    if (!hint) return { ok: false, reason: "no_resume_hint" };
    if (!hint.resumable) return { ok: false, reason: hint.reason || "not_resumable" };

    const agentId = asOptionalString(task.metadata["agentId"]);
    if (agentId !== undefined && hint.childId !== agentId) return { ok: false, reason: "superseded" };
    if (task.status === "completed") return { ok: false, reason: "already_completed" };

    const attempts = asNonNegativeInt(task.metadata["resumeAttempts"]);
    if (attempts >= RESUME_MAX_ATTEMPTS) return { ok: false, reason: "attempts_exhausted" };

    const now = Date.now();
    const metadata: Record<string, unknown> = { ...task.metadata, resumeAttempts: attempts + 1, resumedAt: now };
    delete metadata["interruptedAt"];
    task.metadata = metadata;
    task.status = "in_progress";
    task.updatedAt = now;
    return { ok: true, task, saveError: this._save() };
  }

  // -- 内部 ---------------------------------------------------------

  private _deleteWithEdges(id: string): void {
    this._tasks.delete(id);
    for (const task of this._tasks.values()) {
      task.blocks = task.blocks.filter((other) => other !== id);
      task.blockedBy = task.blockedBy.filter((other) => other !== id);
    }
  }

  /** 清除指向不存在任务的依赖边（clearCompleted 之后调用）。 */
  private _pruneEdges(): void {
    for (const task of this._tasks.values()) {
      task.blocks = task.blocks.filter((other) => this._tasks.has(other));
      task.blockedBy = task.blockedBy.filter((other) => this._tasks.has(other));
    }
  }
}

// ------------------------------------------------------------------
// 压缩快照
// ------------------------------------------------------------------

/** 快照里最多保留多少条已完成任务（清单可能很长，但压缩上下文要省 token）。 */
export const TASK_SNAPSHOT_MAX_COMPLETED = 5;
