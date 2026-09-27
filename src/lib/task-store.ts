/**
 * 任务存储 —— 内存为权威，磁盘为持久副本。
 *
 * 与 pi-tasks 的差别（均为有意设计，见设计定稿）：
 *  - **内存是读路径的权威**；`tasks.json` 只是 write-through 副本
 *    （pi-tasks 每次 get/list 都同步读盘，导致渲染每帧 1+N 次 readFileSync）
 *  - **单写者**（只有父会话写盘）⇒ 不需要文件锁，只保留 tmp+rename 原子写
 *  - **每次变更即落盘**；落盘失败必须能被工具层看到（`saveError`），不允许静默分叉
 *  - **会话归属校验**：文件里的 `sessionId` 与当前会话不符时，既不载入也不覆盖
 *  - 子会话使用无路径的纯内存 store（{@link TaskStore.memory}）
 *
 * 作用域：
 *  - 父会话：`{SESSION_ARTIFACTS}/tasks.json`（{@link taskStorePath}）
 *  - 子会话：纯内存，随子会话对象消亡
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 任务文件名（位于会话工件目录下）。 */
export const TASK_STORE_FILENAME = "tasks.json";

/** 落盘格式版本，供未来迁移使用。 */
export const TASK_STORE_VERSION = 1;

/** 任务状态。`deleted` 只作为 update 的输入，不会出现在存储里。 */
export type TaskStatus = "pending" | "in_progress" | "completed";

/**
 * 子代理续跑提示 —— 启动对账的产物，写在父任务 metadata 里。
 * 它是**建议**：真正是否续跑由主 agent 调用 `task_resume` 决定。
 */
export interface TaskResumeHint {
  /** 上次执行该任务的子代理 id。 */
  childId: string;
  toolCalls: number;
  tokensIn: number;
  /** 阈值与规则的判定结果。 */
  resumable: boolean;
  /** 判定原因（见 task-reconcile.ts 的 ResumeReason）。 */
  reason: string;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  /** 进行中时展示的持续态文案（例如「正在运行测试」）。 */
  activeForm?: string;
  /** 执行者（子代理 id）。 */
  owner?: string;
  metadata: Record<string, unknown>;
  /** 本任务阻塞的任务 id。 */
  blocks: string[];
  /** 阻塞本任务的任务 id。 */
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** 磁盘格式。 */
export interface TaskStoreData {
  version: number;
  sessionId: string;
  nextId: number;
  updatedAt: string;
  tasks: Task[];
}

export interface TaskUpdateFields {
  status?: TaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  /** 浅合并；值为 `null` 时删除该键。 */
  metadata?: Record<string, unknown>;
  /** 本任务阻塞的任务 id。 */
  addBlocks?: string[];
  /** 阻塞本任务的任务 id。 */
  addBlockedBy?: string[];
}

export interface TaskUpdateResult {
  task?: Task;
  changedFields: string[];
  warnings: string[];
  /** 有值表示内存已变更但落盘失败。 */
  saveError?: string;
}

export interface TaskMutationResult {
  saveError?: string;
}

/** 续跑次数上限：超过后交回主 agent 重派或上报用户。 */
export const RESUME_MAX_ATTEMPTS = 2;

/**
 * 续跑阈值（**建议器**，不是执行器）：任一满足即认为「值得续」。
 *
 * 依据：续跑成本 ≈ 回放子上下文（输入 token，同 child id ⇒ 同 promptCacheKey ⇒ 可能命中前缀缓存）；
 * 重派成本 ≈ 重做全部已完成工作（工具调用、读文件、跑测试、输出 token），且新 id ⇒ 无缓存。
 * 因此门槛只用来排除「刚起步就挂」的子，不需要高。
 */
export const RESUME_MIN_TOOL_CALLS = 10;
export const RESUME_MIN_TOKENS_IN = 30_000;

export function isWorthResuming(toolCalls: number, tokensIn: number): boolean {
  return toolCalls >= RESUME_MIN_TOOL_CALLS || tokensIn >= RESUME_MIN_TOKENS_IN;
}

/** 会话工件目录下的任务文件路径。 */
export function taskStorePath(artifactsDir: string): string {
  return join(artifactsDir, TASK_STORE_FILENAME);
}

// ------------------------------------------------------------------
// 载入修复
// ------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 把磁盘记录修成可信形状。
 *
 * 任务文件可能来自旧版本、被手工编辑或写入中断，因此每个字段都要能独立回退，
 * 否则消费者（`task.blockedBy.length` 之类）会在载入后抛错。
 */
export function normalizeTask(raw: unknown): Task | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = asOptionalString(record["id"]);
  const subject = asOptionalString(record["subject"]);
  if (!id || !subject) return undefined;

  const now = Date.now();
  const status = record["status"];
  const normalized: Task = {
    id,
    subject,
    description: typeof record["description"] === "string" ? record["description"] : "",
    status: status === "in_progress" || status === "completed" || status === "pending" ? status : "pending",
    metadata: asPlainObject(record["metadata"]),
    blocks: asStringArray(record["blocks"]),
    blockedBy: asStringArray(record["blockedBy"]),
    createdAt: typeof record["createdAt"] === "number" ? record["createdAt"] : now,
    updatedAt: typeof record["updatedAt"] === "number" ? record["updatedAt"] : now,
  };

  const activeForm = asOptionalString(record["activeForm"]);
  if (activeForm) normalized.activeForm = activeForm;
  const owner = asOptionalString(record["owner"]);
  if (owner) normalized.owner = owner;
  return normalized;
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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const { tasks, nextId, sessionId } = parsed as Partial<TaskStoreData>;
      // 信封不可用（截断写入 / 手工编辑）→ 保持现状，绝不清空。
      if (!Array.isArray(tasks)) return;
      if (typeof sessionId === "string" && sessionId.length > 0 && sessionId !== this._sessionId) {
        this._foreignFile = true;
        return;
      }

      // 先构建完整替换，坏记录不会留下半载入状态。
      const loaded = new Map<string, Task>();
      let maxId = 0;
      for (const raw of tasks) {
        const task = normalizeTask(raw);
        if (!task) continue;
        loaded.set(task.id, task);
        const numeric = Number(task.id);
        if (Number.isFinite(numeric) && numeric > maxId) maxId = numeric;
      }
      this._tasks = loaded;
      // 未来的 id 全部来自这个计数器：必须以文件中已用 id 为下限重算，
      // 否则缺失/陈旧的 nextId 会产生重复 id。
      this._nextId = typeof nextId === "number" && Number.isInteger(nextId) && nextId > maxId ? nextId : maxId + 1;
    } catch {
      /* 不可读或非 JSON —— 保持内存现状 */
    }
  }

  private _save(): string | undefined {
    const path = this._filePath;
    if (!path) return undefined;
    if (this._foreignFile) {
      this._lastSaveError = `tasks.json 属于其它会话，已拒绝写入：${path}`;
      return this._lastSaveError;
    }
    const data: TaskStoreData = {
      version: TASK_STORE_VERSION,
      sessionId: this._sessionId,
      nextId: this._nextId,
      updatedAt: new Date().toISOString(),
      tasks: [...this._tasks.values()],
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, path);
      this._lastSaveError = undefined;
      return undefined;
    } catch (error) {
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

/**
 * 把任务清单渲染成压缩上下文用的快照。
 *
 * 压缩会用一条 continuation prompt 替换旧对话，而任务清单在磁盘上、不在消息里；
 * 这条快照在压缩点重新注入，保证新实例仍能看到当前任务。
 * 限量：全部未完成项 + 最近完成的若干条。
 */
export function formatTaskSnapshot(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "";
  const open = tasks.filter((task) => task.status !== "completed");
  const completed = tasks.filter((task) => task.status === "completed");
  const shown = completed.slice(-TASK_SNAPSHOT_MAX_COMPLETED);

  const lines: string[] = [];
  for (const task of [...open, ...shown]) {
    let line = `- #${task.id} [${task.status}] ${task.subject}`;
    const agentId = typeof task.metadata["agentId"] === "string" ? (task.metadata["agentId"] as string) : undefined;
    if (agentId) line += ` (owner: ${agentId})`;
    const hint = readResumeHint(task);
    if (hint && task.status !== "completed") {
      line += hint.resumable ? " (interrupted — resumable via task_resume)" : " (interrupted — needs re-dispatch)";
    }
    lines.push(line);
  }

  const hidden = completed.length - shown.length;
  if (hidden > 0) lines.push(`- … and ${hidden} earlier completed task(s)`);
  return `[Current Tasks]\n${lines.join("\n")}`;
}
// ------------------------------------------------------------------
// 辅助
// ------------------------------------------------------------------

function compareById(a: Task, b: Task): number {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.id.localeCompare(b.id);
}

/** 依赖边告警：自依赖 / 目标不存在 / 互相阻塞成环。 */
function edgeWarning(
  id: string,
  targetId: string,
  target: Task | undefined,
  mutual: boolean,
): string | undefined {
  if (targetId === id) return `#${id} blocks itself`;
  if (!target) return `#${targetId} does not exist`;
  if (mutual) return `cycle: #${id} and #${targetId} block each other`;
  return undefined;
}

/** 读取任务上的续跑提示（对账产物）。 */
export function readResumeHint(task: Task): TaskResumeHint | undefined {
  return asResumeHint(task.metadata["resumeHint"]);
}

function asResumeHint(raw: unknown): TaskResumeHint | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const childId = asOptionalString(record["childId"]);
  if (!childId) return undefined;
  return {
    childId,
    toolCalls: asNonNegativeInt(record["toolCalls"]),
    tokensIn: asNonNegativeInt(record["tokensIn"]),
    resumable: record["resumable"] === true,
    reason: typeof record["reason"] === "string" ? record["reason"] : "",
  };
}

function asNonNegativeInt(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
