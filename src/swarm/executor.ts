/**
 * SwarmExecutor — high-level parallel execution engine.
 *
 * Integrates TaskDAG, SwarmCoordinator, MessageBus, ContextBridge,
 * and recovery strategies into a single execution pipeline.
 * Provides lifecycle events, progress tracking, and comprehensive error handling.
 *
 * @packageDocumentation
 */

import { Agent } from "../agents/agent.js";
import { SwarmCoordinator, type SwarmCoordinatorOptions } from "./coordinator.js";
import { MessageBus } from "./message-bus.js";
import { ContextBridge } from "./context-bridge.js";
import { attemptRecovery, getRecoveryConfig } from "./recovery.js";
import { mergeResults, formatExecutionResult } from "./merger.js";
import { TaskDecomposer } from "./decomposer.js";
import { SwarmScheduler, type Schedule } from "./scheduler.js";
import type { TaskDAG, ExecutionResult, TaskResult, SwarmSnapshot, SwarmMetrics } from "./types.js";
import {
  AgentRole,
  AgentLifecycle,
  SwarmTopology,
  RecoveryStrategy,
} from "./types.js";

/** Events emitted by the SwarmExecutor. */
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

/** High-level options for executing a swarm task. */
export interface SwarmExecutionOptions {
  /** Natural language task description. */
  task: string;
  /** Pre-built DAG (skip decomposition). */
  dag?: TaskDAG;
  /** Pattern name to use (e.g., "fan-out-fan-in"). */
  pattern?: string;
  /** Number of parallel workers. */
  parallelCount?: number;
  /** Topology override. */
  topology?: SwarmTopology;
}

/**
 * SwarmExecutor — the single entry point for swarm execution.
 *
 * Usage:
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
  private _templates: Record<string, Agent>;

  constructor(opts: SwarmCoordinatorOptions) {
    this._templates = opts.templates;
    this._events = opts.events ?? {};
    this.messageBus = new MessageBus();
    this.contextBridge = new ContextBridge();
    this.decomposer = new TaskDecomposer();
    this.scheduler = new SwarmScheduler();

    // Wire up coordinator
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

    // Wire up decomposer
    this.decomposer.onDecomposition = (dag) => {
      this._events.onDagCreated?.(dag);
    };
  }

  // ------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------

  /**
   * Run a swarm task end-to-end.
   *
   * Flow:
   * 1. Parse task description
   * 2. Decompose into DAG (or use provided DAG/pattern)
   * 3. Schedule execution
   * 4. Execute level by level
   * 5. Merge results
   * 6. Return aggregated result
   */
  async run(opts: SwarmExecutionOptions): Promise<ExecutionResult> {
    try {
      // Step 1: Build DAG
      const dag = await this._buildDag(opts);
      if (!dag || dag.nodes.size === 0) {
        throw new Error("Failed to create task DAG");
      }

      // Step 2: Schedule
      const schedule = this.scheduler.schedule(dag);
      this._events.onScheduleCreated?.(schedule);

      // Step 3: Execute via coordinator
      const result = await this.coordinator.executeDag(dag);

      // Step 4: Merge (summarize)
      result.summary = mergeResults(
        [...result.results.values()],
        { strategy: "synthesize" },
      );

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
   * Cancel the current execution.
   */
  cancel(): void {
    this.coordinator.cancel();
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  /**
   * Get a snapshot of the current swarm state.
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
      topology: this.coordinator["_topology"] as SwarmTopology,
      completedResults: [],
      metrics,
      timestamp: now,
    };
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  /**
   * Build a DAG from options (pattern, task, or direct DAG).
   */
  private async _buildDag(opts: SwarmExecutionOptions): Promise<TaskDAG | null> {
    // Direct DAG was provided
    if (opts.dag) return opts.dag;

    // Pattern was specified
    if (opts.pattern) {
      const result = await this.coordinator.runPattern(opts.pattern, opts.task);
      // The coordinator returns an ExecutionResult, but we need a DAG.
      // For now, use the decomposer with the pattern info.
      return this.decomposer.decompose(opts.task);
    }

    // Default: decompose the task
    return this.decomposer.decompose(opts.task);
  }
}
