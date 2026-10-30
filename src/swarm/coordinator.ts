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
} from "./types.js";
import type { SwarmPattern, TaskNode, TaskDAG, SwarmMessage } from "./types.js";
import { AgentPool, type AgentPoolConfig } from "./pool.js";
import { BUILTIN_PATTERNS } from "./patterns.js";
import { formatDirectDependencyResults, parseTaskHandoff } from "./task-handoff.js";
import { buildExecutionPlan, validateDAG } from "./task-dag.js";

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
  defaultModelConfig?: { model: string; config: import("../config/loader.js").Config };
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
  getPattern(name: string): SwarmPattern | undefined {
    return BUILTIN_PATTERNS[name];
  }

  /** 按指定模式构建任务 DAG，不启动执行。 */
  buildPatternDag(patternName: string, task: string): TaskDAG | null {
    const pattern = BUILTIN_PATTERNS[patternName];
    if (!pattern) return null;
    this.setTopology(pattern.topology);
    return this._patternToDag(pattern, task);
  }

  // ------------------------------------------------------------------
  // 执行
  // ------------------------------------------------------------------

  /**
   * 运行预定义的编排模式。
   *
   * @param patternName - 模式名称（如 "fan-out-fan-in"、"pipeline"）
   * @param task - 要执行的任务描述
   * @returns 聚合的执行结果
   */
  async runPattern(patternName: string, task: string): Promise<ExecutionResult> {
    const dag = this.buildPatternDag(patternName, task);
    if (!dag) {
      return this._errorResult(`Unknown pattern: ${patternName}`);
    }

    // 把 pattern 的各阶段转换成扁平的任务 DAG
    return this.executeDag(dag);
  }

  /**
   * 执行 TaskDAG——核心执行引擎。
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

    const validation = validateDAG(dag);
    if (!validation.valid) {
      return this._errorResult(`Cannot execute invalid DAG: ${validation.errors.join("; ")}`);
    }

    const results = new Map<string, TaskResult>();
    const plan = buildExecutionPlan(dag);

    try {
      for (const level of plan.levels) {
        if (signal.aborted) {
          this._markCancelledTasks(dag, results, startTime);
          break;
        }

        // 直接依赖失败会阻塞下游节点。保留一条具体的失败结果，
        // 避免后续层级误运行。
        const levelPromises = level.taskIds.map((taskId) => {
          const node = dag.nodes.get(taskId);
          const failedDependencies = node?.dependencies.filter((dependencyId) => {
            const dependency = results.get(dependencyId);
            return dependency !== undefined && !dependency.success;
          }) ?? [];
          if (failedDependencies.length === 0) {
            return this._executeTask(taskId, dag, results, signal);
          }

          const blocked: TaskResult = {
            taskId,
            agentId: "",
            success: false,
            output: "",
            usage: { inputTokens: 0, outputTokens: 0 },
            error: `Blocked by failed dependencies: ${failedDependencies.join(", ")}`,
            durationMs: 0,
          };
          return Promise.resolve(blocked);
        });
        const levelResults = await Promise.allSettled(levelPromises);

        // 收集结果
        for (let i = 0; i < levelResults.length; i++) {
          const taskId = level.taskIds[i]!;
          const settled = levelResults[i]!;
          if (settled.status === "fulfilled") {
            results.set(taskId, settled.value);
            if (settled.value.success) {
              this._events.onTaskComplete?.(settled.value);
            } else {
              this._events.onTaskFailed?.(taskId, settled.value.error ?? "Task failed");
            }
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

    if (signal.aborted) {
      this._markCancelledTasks(dag, results, startTime);
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
    return role;
  }

  /**
   * 将模式转换为扁平的 TaskDAG。
   */
  private _patternToDag(pattern: SwarmPattern, task: string): TaskDAG {
    const nodes = new Map<string, TaskNode>();

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
   * 执行单个任务。
   */
  private async _executeTask(
    taskId: string,
    dag: TaskDAG,
    results: ReadonlyMap<string, TaskResult>,
    signal: AbortSignal,
  ): Promise<TaskResult> {
    const node = dag.nodes.get(taskId);
    if (!node) throw new Error(`Task not found: ${taskId}`);
    if (signal.aborted) throw new Error("Execution cancelled");

    const startTime = Date.now();

    // 为该任务创建或复用 agent
    const agentId = `${node.role}-exec-${taskId}`;
    let handle = this.pool.getHandle(agentId) ?? null;

    if (!handle) {
      handle = this.createAgent(agentId, node.role);
      if (!handle) throw new Error("Failed to create agent: pool at capacity");
    }

    this.pool.setLifecycle(agentId, AgentLifecycle.Thinking);
    this.pool.assignTask(agentId, taskId);

    try {
      const agent = this.pool.getAgent(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);

      // 准备任务提示词
      const taskInstructions = node.instructions
        ? `${node.description}\n\nInstructions: ${node.instructions}`
        : node.description;
      const dependencyResults = formatDirectDependencyResults(node, dag, results);
      const taskPrompt = dependencyResults
        ? `${taskInstructions}\n\n${dependencyResults}`
        : taskInstructions;

      // 处理 scout 任务——这些是只读的
      this.pool.setLifecycle(agentId, AgentLifecycle.ToolCalling);

      // 执行 agent
      const result = await agent.asyncRun(taskPrompt, undefined, undefined, undefined, signal);

      this.pool.setLifecycle(agentId, AgentLifecycle.Completed);
      this.pool.recordUsage(agentId, result.totalUsage.inputTokens, result.totalUsage.outputTokens);
      this.pool.unassignTask(agentId, taskId);
      const handoff = parseTaskHandoff(result.text);

      return {
        taskId,
        agentId,
        success: true,
        output: result.text,
        handoff,
        modifiedFiles: handoff?.modifiedFiles,
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
   * 构建人类可读的摘要字符串。
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

    // 追加成功任务的输出
    for (const [id, result] of results) {
      if (result.success && result.output) {
        summary += `\n\n--- Task: ${id} ---\n${result.output.slice(0, 1000)}`;
      }
    }

    return summary;
  }

  /** 记录协作式取消后始终未启动的任务。 */
  private _markCancelledTasks(
    dag: TaskDAG,
    results: Map<string, TaskResult>,
    startTime: number,
  ): void {
    for (const taskId of dag.nodes.keys()) {
      if (results.has(taskId)) continue;
      const result: TaskResult = {
        taskId,
        agentId: "",
        success: false,
        output: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "Execution cancelled before task started",
        durationMs: Date.now() - startTime,
      };
      results.set(taskId, result);
      this._events.onTaskFailed?.(taskId, result.error!);
    }
  }

  /**
   * 创建错误结果。
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
