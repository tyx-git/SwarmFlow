/**
 * SwarmCoordinator —  swarm 系统的中心编排器。
 *
 * 协调任务分解、agent 池管理、并行执行、
 * 消息传递和结果聚合。这是所有
 * swarm 操作的入口点。
 *
 * @packageDocumentation
 */

import { Agent } from "../agents/agent.js";
import type { SwarmAgentHandle, TaskResult, ExecutionResult } from "./types.js";
import {
  AgentRole,
  AgentLifecycle,
  SwarmTopology,
  RecoveryStrategy,
} from "./types.js";
import type { SwarmPattern, TaskNode, TaskDAG, ExecutionPlan, SwarmMessage } from "./types.js";
import { AgentPool, type AgentPoolConfig } from "./pool.js";
import { BUILTIN_PATTERNS, type SwarmPattern as SwarmPatternType } from "./patterns.js";

/** 协调器发出的事件。*/
export interface SwarmCoordinatorEvents {
  onAgentLifecycleChange?: (handle: SwarmAgentHandle) => void;
  onTaskComplete?: (result: TaskResult) => void;
  onTaskFailed?: (taskId: string, error: string) => void;
  onMessage?: (message: SwarmMessage) => void;
  onExecutionComplete?: (result: ExecutionResult) => void;
  onError?: (error: Error) => void;
}

/** 创建 SwarmCoordinator 的选项。*/
export interface SwarmCoordinatorOptions {
  /** Agent 池配置。*/
  poolConfig?: Partial<AgentPoolConfig>;
  /** 可用 agent 模板（name → Agent）。*/
  templates: Record<string, Agent>;
  /** 创建新 agent 的默认模型配置。*/
  defaultModelConfig?: { model: string; config: import("../config/config.js").Config };
  /** 事件回调。*/
  events?: SwarmCoordinatorEvents;
}

/**
 * SwarmCoordinator - 中央编排器。
 *
 * 用法：
 * ```typescript
 * const coordinator = new SwarmCoordinator({ templates, events: { ... } });
 * const result = await coordinator.runPattern("fan-out-fan-in", "Refactor auth module");
 * ```
 */
export class SwarmCoordinator {
  readonly pool: AgentPool;
  readonly templates: Record<string, Agent>;
  private _events: SwarmCoordinatorEvents;
  private _topology: SwarmTopology = SwarmTopology.Star;
  private _activeExecution: Promise<ExecutionResult> | null = null;
  private _abortController: AbortController | null = null;

  constructor(opts: SwarmCoordinatorOptions) {
    this.pool = new AgentPool(opts.poolConfig);
    this.templates = opts.templates;
    this._events = opts.events ?? {};

    // 连接池事件
    this.pool.onLifecycleChange = (handle) => {
      this._events.onAgentLifecycleChange?.(handle);
    };
  }

  /** 当前 swarm 拓扑。*/
  get topology(): SwarmTopology {
    return this._topology;
  }

  // ------------------------------------------------------------------
  // 拓扑
  // ------------------------------------------------------------------

  /**
   * 设置通信拓扑。
   */
  setTopology(topology: SwarmTopology): void {
    this._topology = topology;
  }

  // ------------------------------------------------------------------
  // Agent 管理
  // ------------------------------------------------------------------

  /**
   * 从模板创建并注册 swarm agent。
   */
  createAgent(id: string, role: AgentRole, templateName?: string): SwarmAgentHandle | null {
    const templateName_ = templateName ?? this._roleToTemplate(role);
    const template = this.templates[templateName_];
    if (!template) {
      this._events.onError?.(new Error(`Template not found: ${templateName_}`));
      return null;
    }
    if (!this.pool.canAcquire()) {
      this._events.onError?.(new Error("Pool at capacity"));
      return null;
    }
    const agent = template.clone();
    return this.pool.register(id, role, agent);
  }

  /**
   * 获取可用模式。
   */
  listPatterns(): string[] {
    return Object.keys(BUILTIN_PATTERNS);
  }

  /**
   * 获取特定模式。
   */
  getPattern(name: string): SwarmPatternType | undefined {
    return BUILTIN_PATTERNS[name];
  }

  // ------------------------------------------------------------------
  // 执行
  // ------------------------------------------------------------------

  /**
   * Run a pre-defined orchestration pattern.
   *
   * @param patternName - 模式名称 (e.g., "fan-out-fan-in", "pipeline")
   * @param task - 要执行的任务描述 to execute
   * @returns 聚合的执行结果
   */
  async runPattern(patternName: string, task: string): Promise<ExecutionResult> {
    const pattern = BUILTIN_PATTERNS[patternName];
    if (!pattern) {
      return this._errorResult(`Unknown pattern: ${patternName}`);
    }

    this._topology = pattern.topology;
    // 转换 pattern stages to a flat task DAG
    const dag = this._patternToDag(pattern, task);
    return this.executeDag(dag);
  }

  /**
   * Execute a TaskDAG — the core execution engine.
   *
   * 逐级别处理 DAG: 同一级别的任务并行运行,
   * 有依赖的级别顺序运行. 结果被聚合并返回.
   *
   * @param dag - 要执行的 task DAG
   * @returns 聚合的执行结果
   */
  async executeDag(dag: TaskDAG): Promise<ExecutionResult> {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const startTime = Date.now();

    const results = new Map<string, TaskResult>();
    const plan = this._buildPlan(dag);

    try {
      for (const level of plan.levels) {
        if (signal.aborted) break;

        // 并行执行此级别的所有任务
        const levelPromises = level.taskIds.map((taskId) =>
          this._executeTask(taskId, dag, signal),
        );
        const levelResults = await Promise.allSettled(levelPromises);

        // 收集结果
        for (let i = 0; i < levelResults.length; i++) {
          const taskId = level.taskIds[i]!;
          const settled = levelResults[i]!;
          if (settled.status === "fulfilled") {
            results.set(taskId, settled.value);
            this._events.onTaskComplete?.(settled.value);
          } else {
            const err = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
            results.set(taskId, {
              taskId,
              agentId: "",
              success: false,
              output: "",
              usage: { inputTokens: 0, outputTokens: 0 },
              error: err,
              durationMs: Date.now() - startTime,
            });
            this._events.onTaskFailed?.(taskId, err);
          }
        }
      }
    } catch (err) {
      this._events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }

    const durationMs = Date.now() - startTime;
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    const failedTaskIds: string[] = [];

    for (const r of results.values()) {
      totalUsage.inputTokens += r.usage.inputTokens;
      totalUsage.outputTokens += r.usage.outputTokens;
      if (!r.success) failedTaskIds.push(r.taskId);
    }

    const result: ExecutionResult = {
      results,
      success: failedTaskIds.length === 0,
      totalUsage,
      totalDurationMs: durationMs,
      failedTaskIds,
      summary: this._buildSummary(results, failedTaskIds),
    };

    this._events.onExecutionComplete?.(result);
    return result;
  }

  /**
   * 取消当前执行。
   */
  cancel(): void {
    this._abortController?.abort();
  }

  // ------------------------------------------------------------------
  // 私有辅助函数
  // ------------------------------------------------------------------

  /**
   * 将角色映射到默认模板名称。
   */
  private _roleToTemplate(role: AgentRole): string {
    switch (role) {
      case AgentRole.Queen: return "main";
      case AgentRole.Scout: return "explorer";
      case AgentRole.Worker: return "worker";
      case AgentRole.Reviewer: return "reviewer";
      case AgentRole.Guard: return "reviewer";
      case AgentRole.Merger: return "explorer";
    }
  }

  /**
   * 将模式转换为扁平的 TaskDAG。
   */
  private _patternToDag(pattern: SwarmPattern, task: string): TaskDAG {
    const nodes = new Map<string, TaskNode>();
    let nodeIndex = 0;

    for (let stageIdx = 0; stageIdx < pattern.stages.length; stageIdx++) {
      const stage = pattern.stages[stageIdx]!;
      for (let i = 0; i < stage.count; i++) {
        const id = `${stage.role}-${stageIdx}-${i}`;
        const deps: string[] = [];

        // 依赖于上一阶段的所有任务
        if (stageIdx > 0) {
          const prevStage = pattern.stages[stageIdx - 1]!;
          for (let j = 0; j < prevStage.count; j++) {
            deps.push(`${prevStage.role}-${stageIdx - 1}-${j}`);
          }
        }

        nodes.set(id, {
          id,
          role: stage.role,
          description: stage.count > 1
            ? `${task} (partition ${i + 1}/${stage.count})`
            : task,
          dependencies: deps,
          priority: stageIdx === 0 ? 1 : 2,
          instructions: stage.mergeStrategy
            ? `Merge strategy: ${stage.mergeStrategy}`
            : undefined,
        });
        nodeIndex++;
      }
    }

    return {
      nodes,
      entryPoints: [...nodes.values()]
        .filter((n) => n.dependencies.length === 0)
        .map((n) => n.id),
    };
  }

  /**
   * Build an execution plan from a DAG (topological sort).
   */
  private _buildPlan(dag: TaskDAG): ExecutionPlan {
    const visited = new Set<string>();
    const levels: Array<{ index: number; taskIds: string[] }> = [];
    let currentLevel = 0;

    // Track which level each task belongs to
    const taskLevels = new Map<string, number>();
    const nodeArray = [...dag.nodes.values()];

    // Simple level assignment: max(dependency levels) + 1
    function assignLevel(taskId: string): number {
      if (taskLevels.has(taskId)) return taskLevels.get(taskId)!;
      const node = dag.nodes.get(taskId);
      if (!node || node.dependencies.length === 0) {
        taskLevels.set(taskId, 0);
        return 0;
      }
      let maxDepLevel = 0;
      for (const depId of node.dependencies) {
        const depLevel = assignLevel(depId);
        maxDepLevel = Math.max(maxDepLevel, depLevel);
      }
      const level = maxDepLevel + 1;
      taskLevels.set(taskId, level);
      return level;
    }

    for (const node of nodeArray) {
      assignLevel(node.id);
    }

    // Group by level
    const levelGroups = new Map<number, string[]>();
    for (const [taskId, level] of taskLevels) {
      if (!levelGroups.has(level)) levelGroups.set(level, []);
      levelGroups.get(level)!.push(taskId);
    }

    for (const [index, taskIds] of [...levelGroups.entries()].sort(([a], [b]) => a - b)) {
      levels.push({ index, taskIds });
    }

    return {
      levels,
      complexity: Math.min(10, dag.nodes.size),
    };
  }

  /**
   * Execute a single task.
   */
  private async _executeTask(
    taskId: string,
    dag: TaskDAG,
    signal: AbortSignal,
  ): Promise<TaskResult> {
    const node = dag.nodes.get(taskId);
    if (!node) throw new Error(`Task not found: ${taskId}`);
    if (signal.aborted) throw new Error("Execution cancelled");

    const startTime = Date.now();

    // 创建 or reuse an agent for this task
    const agentId = `${node.role}-exec-${taskId}`;
    let handle = this.pool.getHandle(agentId);

    if (!handle) {
      handle = this.createAgent(agentId, node.role);
      if (!handle) throw new Error("Failed to create agent: pool at capacity");
    }

    this.pool.setLifecycle(agentId, AgentLifecycle.Thinking);
    this.pool.assignTask(agentId, taskId);

    try {
      const agent = this.pool.getAgent(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);

      // Prepare the task prompt
      const taskPrompt = node.instructions
        ? `${node.description}\n\nInstructions: ${node.instructions}`
        : node.description;

      // 处理 scout tasks — these are read-only
      if (node.role === AgentRole.Scout || node.role === AgentRole.Guard) {
        // Use a stripped-down tool set
        // (In production, this would use the template's tool configuration)
      }

      this.pool.setLifecycle(agentId, AgentLifecycle.ToolCalling);

      // 执行 the agent
      const result = await agent.asyncRun(taskPrompt, undefined, undefined, undefined, signal);

      this.pool.setLifecycle(agentId, AgentLifecycle.Completed);
      this.pool.recordUsage(agentId, result.totalUsage.inputTokens, result.totalUsage.outputTokens);
      this.pool.unassignTask(agentId, taskId);

      return {
        taskId,
        agentId,
        success: true,
        output: result.text,
        usage: result.totalUsage,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.pool.setLifecycle(agentId, AgentLifecycle.Error, errorMsg);
      this.pool.unassignTask(agentId, taskId);

      return {
        taskId,
        agentId,
        success: false,
        output: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Build a human-readable summary string.
   */
  private _buildSummary(
    results: Map<string, TaskResult>,
    failedTaskIds: string[],
  ): string {
    const total = results.size;
    const succeeded = total - failedTaskIds.length;
    let summary = `Swarm execution complete: ${succeeded}/${total} tasks succeeded.`;

    if (failedTaskIds.length > 0) {
      summary += `\nFailed tasks: ${failedTaskIds.join(", ")}`;
    }

    // 添加 output from successful tasks
    for (const [id, result] of results) {
      if (result.success && result.output) {
        summary += `\n\n--- Task: ${id} ---\n${result.output.slice(0, 1000)}`;
      }
    }

    return summary;
  }

  /**
   * Create an error result.
   */
  private _errorResult(message: string): ExecutionResult {
    const result: ExecutionResult = {
      results: new Map(),
      success: false,
      totalUsage: { inputTokens: 0, outputTokens: 0 },
      totalDurationMs: 0,
      failedTaskIds: [],
      summary: `Error: ${message}`,
    };
    this._events.onExecutionComplete?.(result);
    return result;
  }
}
