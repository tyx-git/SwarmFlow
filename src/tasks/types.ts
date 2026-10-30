/** 任务清单的数据结构、落盘格式与续跑阈值。 */

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
  /** 判定原因（见 reconcile.ts 的 ResumeReason）。 */
  reason: string;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  /** 计划执行此节点的角色 ID。 */
  role?: string;
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
  role?: string;
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
