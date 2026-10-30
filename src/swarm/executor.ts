/**
 * SwarmExecutor — 高层并行执行引擎。
 *
 * 把任务 DAG、协调器、消息总线、上下文桥和恢复策略整合成一条执行管线，
 * 并提供生命周期事件、进度追踪与完整的错误处理。
 *
 * @packageDocumentation
 */

import { SwarmCoordinator, type SwarmCoordinatorOptions } from "./coordinator.js";
import { MessageBus } from "./message-bus.js";
import { ContextBridge } from "./context-bridge.js";
import { mergeResults } from "./merger.js";
import { TaskDecomposer } from "./decomposer.js";
import { SwarmScheduler, type Schedule } from "./scheduler.js";
import { getTerminalMergerResults, stripTaskHandoffBlock } from "./task-handoff.js";
import type { TaskDAG, ExecutionResult, TaskResult, SwarmSnapshot, SwarmMetrics } from "./types.js";
import { AgentLifecycle, SwarmTopology } from "./types.js";

/** SwarmExecutor 发出的事件。 */
export interface ExecutorEvents {
  onDagCreated?: (dag: TaskDAG) => void;
  onScheduleCreated?: (schedule: Schedule) => void;
  onLevelStart?: (levelIndex: number, taskCount: number) => void;
  onLevelComplete?: (levelIndex: number) => void;
  onTaskStart?: (taskId: string) => void;
  onTaskComplete?: (result: TaskResult) => void;
  onTaskFailed?: (taskId: string, error: string, recovery: string) => void;
  onRecoveryAttempt?: (taskId: string, attempt: number) => void;
  onExecutionComplete?: (result: ExecutionResult) => void;
  onError?: (error: Error) => void;
  onSnapshot?: (snapshot: SwarmSnapshot) => void;
}

/** 执行 swarm 任务的高级选项。 */
export interface SwarmExecutionOptions {
  /** 自然语言任务描述。 */
  task: string;
  /** 预构建 DAG（跳过分解）。 */
  dag?: TaskDAG;
  /** 使用的模式名称（例如 "fan-out-fan-in"）。 */
  pattern?: string;
  /** 并行 worker 数量。 */
  parallelCount?: number;
  /** 拓扑覆盖。 */
  topology?: SwarmTopology;
}

/**
 * SwarmExecutor — swarm 执行的唯一入口。
 *
 * 用法:
 * ```typescript
 * const executor = new SwarmExecutor({ templates, events: { ... } });
 * const result = await executor.run({ task: "Implement auth", pattern: "pipeline" });
 * ```
 */
export class SwarmExecutor {
  readonly coordinator: SwarmCoordinator;
  readonly messageBus: MessageBus;
  readonly contextBridge: ContextBridge;
  readonly decomposer: TaskDecomposer;
  readonly scheduler: SwarmScheduler;
  private _events: ExecutorEvents;

  constructor(opts: SwarmCoordinatorOptions) {
    this._events = opts.events ?? {};
    this.messageBus = new MessageBus();
    this.contextBridge = new ContextBridge();
    this.decomposer = new TaskDecomposer();
    this.scheduler = new SwarmScheduler();

    // 连接协调器
    this.coordinator = new SwarmCoordinator({
      templates: opts.templates,
      poolConfig: opts.poolConfig,
      events: {
        onTaskComplete: (r) => this._events.onTaskComplete?.(r),
        onTaskFailed: (id, err) => this._events.onTaskFailed?.(id, err, ""),
        onExecutionComplete: (r) => this._events.onExecutionComplete?.(r),
        onError: (e) => this._events.onError?.(e),
      },
    });

    // 连接分解器
    this.decomposer.onDecomposition = (dag) => {
      this._events.onDagCreated?.(dag);
    };
  }

  // ------------------------------------------------------------------
  // 执行
  // ------------------------------------------------------------------

  /**
   * 端到端运行 swarm 任务。
   *
   * 流程：
   * 1. 解析任务描述
   * 2. 分解为 DAG（或使用提供的 DAG/模式）
   * 3. 调度执行
   * 4. 按级别执行
   * 5. 合并结果
   * 6. 返回聚合结果
   */
  async run(opts: SwarmExecutionOptions): Promise<ExecutionResult> {
    try {
      // 步骤 1：构建 DAG
      const dag = await this._buildDag(opts);
      if (!dag || dag.nodes.size === 0) {
        throw new Error("Failed to create task DAG");
      }

      // 步骤 2：调度
      const schedule = this.scheduler.schedule(dag);
      this._events.onScheduleCreated?.(schedule);

      // 步骤 3：通过协调器执行
      const result = await this.coordinator.executeDag(dag);

      // 终端 Merger 已基于直接依赖结果做了模型汇总，优先展示它的输出。
      const mergerResults = getTerminalMergerResults(dag, result.results);
      if (mergerResults.length > 0) {
        result.summary = mergerResults
          .map((mergerResult) => stripTaskHandoffBlock(mergerResult.output) || mergerResult.output)
          .join("\n\n");
      } else {
        result.summary = mergeResults(
          [...result.results.values()],
          { strategy: "synthesize" },
        );
      }

      this._events.onExecutionComplete?.(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._events.onError?.(error);
      return {
        results: new Map(),
        success: false,
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        totalDurationMs: 0,
        failedTaskIds: [],
        summary: `Execution failed: ${error.message}`,
      };
    }
  }

  /**
   * 取消当前执行。
   */
  cancel(): void {
    this.coordinator.cancel();
  }

  // ------------------------------------------------------------------
  // 状态
  // ------------------------------------------------------------------

  /**
   * 获取当前 swarm 状态的快照。
   */
  getSnapshot(): SwarmSnapshot {
    const now = Date.now();
    const agents = this.coordinator.pool.handles;
    const activeAgents = agents.filter(
      (a) => ![AgentLifecycle.Completed, AgentLifecycle.Cancelled].includes(a.lifecycle as AgentLifecycle),
    );
    const usage = this.coordinator.pool.totalTokenUsage;

    const metrics: SwarmMetrics = {
      totalTokens: usage.inputTokens + usage.outputTokens,
      tasksCompleted: agents.reduce((s, a) => s + a.taskIds.length, 0),
      tasksFailed: 0,
      tasksPending: 0,
      activeAgents: activeAgents.length,
      elapsedMs: now - (agents[0]?.createdAt ?? now),
    };

    return {
      agents,
      topology: this.coordinator.topology,
      completedResults: [],
      metrics,
      timestamp: now,
    };
  }

  // ------------------------------------------------------------------
  // 私有
  // ------------------------------------------------------------------

  /**
   * 根据选项构建 DAG（模式、任务描述或现成 DAG）。
   */
  private async _buildDag(opts: SwarmExecutionOptions): Promise<TaskDAG | null> {
    // 已提供现成 DAG
    if (opts.dag) return opts.dag;

    // 指定了模式
    if (opts.pattern) {
      const dag = this.coordinator.buildPatternDag(opts.pattern, opts.task);
      if (!dag) {
        throw new Error(`Unknown pattern: ${opts.pattern}`);
      }
      return dag;
    }

    // 默认：分解任务
    return this.decomposer.decompose(opts.task);
  }
}
