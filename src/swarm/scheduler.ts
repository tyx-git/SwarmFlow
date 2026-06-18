/**
 * SwarmScheduler — converts TaskDAGs to executable plans.
 *
 * Takes a decomposed TaskDAG and produces a concrete execution plan
 * with level assignments, resource estimates, and timing predictions.
 *
 * @packageDocumentation
 */

import type { TaskNode, TaskDAG, ExecutionPlan, ExecutionLevel } from "./types.js";
import { AgentRole } from "./types.js";
import { getLevels, validateDAG } from "./task-dag.js";

/** Timing estimation for a task. */
export interface TaskEstimate {
  taskId: string;
  /** Estimated duration in ms. */
  estimatedMs: number;
  /** Estimated input tokens. */
  estimatedInputTokens: number;
  /** Estimated output tokens. */
  estimatedOutputTokens: number;
}

/** Detailed schedule with estimates. */
export interface Schedule {
  plan: ExecutionPlan;
  estimates: TaskEstimate[];
  /** Estimated wall-clock time in ms. */
  estimatedWallTimeMs: number;
  /** Estimated total tokens. */
  estimatedTotalTokens: number;
  /** Maximum parallelism across all levels. */
  maxParallelism: number;
}

/** Default token budgets per role. */
const ROLE_TOKEN_ESTIMATES: Record<AgentRole, { input: number; output: number }> = {
  [AgentRole.Queen]: { input: 4000, output: 2000 },
  [AgentRole.Scout]: { input: 3000, output: 4000 },
  [AgentRole.Worker]: { input: 4000, output: 6000 },
  [AgentRole.Reviewer]: { input: 5000, output: 3000 },
  [AgentRole.Guard]: { input: 3000, output: 2000 },
  [AgentRole.Merger]: { input: 6000, output: 4000 },
};

/** Default time estimates per role (ms). */
const ROLE_TIME_ESTIMATES: Record<AgentRole, number> = {
  [AgentRole.Queen]: 15000,
  [AgentRole.Scout]: 20000,
  [AgentRole.Worker]: 30000,
  [AgentRole.Reviewer]: 15000,
  [AgentRole.Guard]: 10000,
  [AgentRole.Merger]: 15000,
};

/** Scheduler configuration. */
export interface SchedulerConfig {
  /** Maximum parallel agents. */
  maxConcurrency: number;
  /** Token budget per level (aggregate). */
  levelTokenBudget: number;
}

/** Default scheduler config. */
const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrency: 5,
  levelTokenBudget: 100_000,
};

/**
 * SwarmScheduler — plan execution of a TaskDAG.
 *
 * 1. Takes a validated DAG
 * 2. Assigns execution levels (topological sort)
 * 3. Estimates resource requirements
 * 4. Returns a Schedule for the Executor
 */
export class SwarmScheduler {
  private _config: SchedulerConfig;

  constructor(config?: Partial<SchedulerConfig>) {
    this._config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  /** Current config. */
  get config(): SchedulerConfig {
    return { ...this._config };
  }

  /**
   * Create a schedule from a TaskDAG.
   *
   * @param dag - Validated task DAG
   * @returns Complete schedule with estimates
   * @throws If DAG is invalid
   */
  schedule(dag: TaskDAG): Schedule {
    // Validate
    const validation = validateDAG(dag);
    if (!validation.valid) {
      throw new Error(`Cannot schedule invalid DAG: ${validation.errors.join("; ")}`);
    }

    // Get execution levels
    const levels = getLevels(dag);

    // Build the execution plan
    const plan: ExecutionPlan = {
      levels: levels.map((l) => ({
        index: l.index,
        taskIds: l.taskIds,
      })),
      complexity: Math.min(10, dag.nodes.size),
    };

    // Generate estimates
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
   * Quick schedule without full validation (for hot paths).
   */
  scheduleFast(dag: TaskDAG): ExecutionPlan {
    const levels = getLevels(dag);
    return {
      levels: levels.map((l) => ({ index: l.index, taskIds: l.taskIds })),
      complexity: Math.min(10, dag.nodes.size),
    };
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  /**
   * Estimate resource usage for each task.
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
   * Estimate total wall-clock time, accounting for parallelism.
   * Each level = time of the longest task in that level.
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
 * Convenience: schedule a DAG with default config.
 */
export function scheduleDAG(dag: TaskDAG): Schedule {
  const scheduler = new SwarmScheduler();
  return scheduler.schedule(dag);
}
