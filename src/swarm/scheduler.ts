/**
 * SwarmScheduler — 将 TaskDAG 转换为可执行计划。
 *
 * 接收分解后的 TaskDAG，并生成包含层级分配、资源估算
 * 和时间预测的具体执行计划。
 *
 * @packageDocumentation
 */

import type { TaskDAG, ExecutionPlan } from "./types.js";
import { AgentRole } from "./types.js";
import { getLevels, validateDAG } from "./task-dag.js";

/** 任务的计时估算。 */
export interface TaskEstimate {
  taskId: string;
  /** 预估持续时间（毫秒）。 */
  estimatedMs: number;
  /** 预估输入 tokens。 */
  estimatedInputTokens: number;
  /** 预估输出 tokens。 */
  estimatedOutputTokens: number;
}

/** 带估算的详细计划。 */
export interface Schedule {
  plan: ExecutionPlan;
  estimates: TaskEstimate[];
  /** 预估墙上时间（毫秒）。 */
  estimatedWallTimeMs: number;
  /** 预估总 tokens。 */
  estimatedTotalTokens: number;
  /** 所有级别的最大并行度。 */
  maxParallelism: number;
}

/** 每个角色的默认 token 预算。 */
const ROLE_TOKEN_ESTIMATES: Record<AgentRole, { input: number; output: number }> = {
  [AgentRole.Queen]: { input: 4000, output: 2000 },
  [AgentRole.Scout]: { input: 3000, output: 4000 },
  [AgentRole.Worker]: { input: 4000, output: 6000 },
  [AgentRole.Reviewer]: { input: 5000, output: 3000 },
  [AgentRole.Guard]: { input: 3000, output: 2000 },
  [AgentRole.Merger]: { input: 6000, output: 4000 },
};

/** 每个角色的默认时间估算（毫秒）。 */
const ROLE_TIME_ESTIMATES: Record<AgentRole, number> = {
  [AgentRole.Queen]: 15000,
  [AgentRole.Scout]: 20000,
  [AgentRole.Worker]: 30000,
  [AgentRole.Reviewer]: 15000,
  [AgentRole.Guard]: 10000,
  [AgentRole.Merger]: 15000,
};

/** 调度器配置。 */
export interface SchedulerConfig {
  /** 最大并行 agent 数。 */
  maxConcurrency: number;
  /** 每级 token 预算（合计）。 */
  levelTokenBudget: number;
}

/** 默认调度器配置。 */
const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrency: 5,
  levelTokenBudget: 100_000,
};

/**
 * SwarmScheduler — 规划 TaskDAG 的执行。
 *
 * 1. 获取验证过的 DAG
 * 2. 分配执行级别（拓扑排序）
 * 3. 估算资源需求
 * 4. 为 Executor 返回一个 Schedule
 */
export class SwarmScheduler {
  private _config: SchedulerConfig;

  constructor(config?: Partial<SchedulerConfig>) {
    this._config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  /** 当前配置。 */
  get config(): SchedulerConfig {
    return { ...this._config };
  }

  /**
   * 从 TaskDAG 创建计划。
   *
   * @param dag - 验证过的任务 DAG
   * @returns 带估算的完整计划
   * @throws 如果 DAG 无效
   */
  schedule(dag: TaskDAG): Schedule {
    // 验证
    const validation = validateDAG(dag);
    if (!validation.valid) {
      throw new Error(`无法调度无效的 DAG：${validation.errors.join("; ")}`);
    }

    // 获取执行层级
    const levels = getLevels(dag);

    // 构建执行计划
    const plan: ExecutionPlan = {
      levels: levels.map((l) => ({
        index: l.index,
        taskIds: l.taskIds,
      })),
      complexity: Math.min(10, dag.nodes.size),
    };

    // 生成估算
    const estimates = this._estimateTasks(dag);
    const estimatedWallTimeMs = this._estimateWallTime(levels, dag);
    const estimatedTotalTokens = estimates.reduce(
      (sum, e) => sum + e.estimatedInputTokens + e.estimatedOutputTokens,
      0,
    );
    const maxParallelism = Math.max(...levels.map((l) => l.taskIds.length));

    return {
      plan,
      estimates,
      estimatedWallTimeMs,
      estimatedTotalTokens,
      maxParallelism,
    };
  }

  /**
   * 无需完整验证的快速计划（用于热路径）。
   */
  scheduleFast(dag: TaskDAG): ExecutionPlan {
    const levels = getLevels(dag);
    return {
      levels: levels.map((l) => ({ index: l.index, taskIds: l.taskIds })),
      complexity: Math.min(10, dag.nodes.size),
    };
  }

  // ------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------

  /**
   * 估算每个任务的资源使用。
   */
  private _estimateTasks(dag: TaskDAG): TaskEstimate[] {
    const estimates: TaskEstimate[] = [];

    for (const [id, node] of dag.nodes) {
      const tokenEst = ROLE_TOKEN_ESTIMATES[node.role] ?? { input: 2000, output: 2000 };
      estimates.push({
        taskId: id,
        estimatedMs: ROLE_TIME_ESTIMATES[node.role] ?? 15000,
        estimatedInputTokens: tokenEst.input,
        estimatedOutputTokens: tokenEst.output,
      });
    }

    return estimates;
  }

  /**
   * 估算总墙上时间，考虑并行度。
   * 每级 = 该级中最长任务的耗时。
   */
  private _estimateWallTime(
    levels: Array<{ index: number; taskIds: string[] }>,
    dag: TaskDAG,
  ): number {
    let totalMs = 0;

    for (const level of levels) {
      let levelMaxMs = 0;
      for (const taskId of level.taskIds) {
        const node = dag.nodes.get(taskId);
        if (node) {
          levelMaxMs = Math.max(
            levelMaxMs,
            ROLE_TIME_ESTIMATES[node.role] ?? 15000,
          );
        }
      }
      totalMs += levelMaxMs;
    }

    return totalMs;
  }
}

/**
 * 便捷函数：使用默认配置调度 DAG。
 */
export function scheduleDAG(dag: TaskDAG): Schedule {
  const scheduler = new SwarmScheduler();
  return scheduler.schedule(dag);
}
