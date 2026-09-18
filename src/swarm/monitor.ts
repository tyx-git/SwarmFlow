/**
 * SwarmMonitor — swarm 的实时监控和可观测性。
 *
 * 从协调器、消息总线和执行器收集事件；
 * 聚合指标；为 TUI/GUI 提供快照。
 *
 * @packageDocumentation
 */

import type { SwarmSnapshot, SwarmMetrics, TaskResult, SwarmMessage, SwarmAgentHandle, TaskDAG } from "./types.js";
import { AgentLifecycle, MessageType } from "./types.js";

/** Swarm 时间线中的单个事件。 */
export interface TimelineEvent {
  timestamp: number;
  type: "agent_created" | "agent_state_change" | "task_start" | "task_complete" | "task_fail" | "message_sent" | "level_start" | "level_complete" | "execution_complete" | "error";
  agentId?: string;
  taskId?: string;
  detail?: string;
}

/** Swarm 事件和指标的收集器。 */
export class SwarmMonitor {
  private _timeline: TimelineEvent[] = [];
  private _metrics: SwarmMetrics = {
    totalTokens: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksPending: 0,
    activeAgents: 0,
    elapsedMs: 0,
  };
  private _startTime = Date.now();
  private _stateHistory: SwarmSnapshot[] = [];
  private _maxHistory = 1000;
  private _agentErrors = new Map<string, string[]>();
  private _taskDurations = new Map<string, number>();

  /** 订阅实时更新。 */
  onUpdate?: (snapshot: SwarmSnapshot) => void;

  // ------------------------------------------------------------------
  // 事件 recording
  // ------------------------------------------------------------------

  /** 记录新 DAG 已创建。 */
  recordDagCreated(dag: TaskDAG): void {
    this._metrics.tasksPending = dag.nodes.size;
  }

  /** 记录 agent 已创建。 */
  recordAgentCreated(handle: SwarmAgentHandle): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "agent_created",
      agentId: handle.id,
      detail: `${handle.role} agent created`,
    });
    this._pruneTimeline();
  }

  /** Record an agent lifecycle change. */
  recordAgentStateChange(handle: SwarmAgentHandle): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "agent_state_change",
      agentId: handle.id,
      detail: `→ ${handle.lifecycle}`,
    });
    this._updateMetrics();
    this._pruneTimeline();
  }

  /** Record that a task started. */
  recordTaskStart(taskId: string, agentId: string): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "task_start",
      taskId,
      agentId,
      detail: `Task started`,
    });
    this._metrics.tasksPending = Math.max(0, this._metrics.tasksPending - 1);
    this._pruneTimeline();
  }

  /** Record that a task completed successfully. */
  recordTaskComplete(result: TaskResult): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "task_complete",
      taskId: result.taskId,
      agentId: result.agentId,
      detail: `✓ ${result.taskId} (${(result.durationMs / 1000).toFixed(1)}s)`,
    });
    this._metrics.tasksCompleted++;
    this._metrics.totalTokens += result.usage.inputTokens + result.usage.outputTokens;
    this._taskDurations.set(result.taskId, result.durationMs);
    this._pruneTimeline();
  }

  /** Record that a task failed. */
  recordTaskFailed(taskId: string, error: string): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "task_fail",
      taskId,
      detail: `✗ ${taskId}: ${error.slice(0, 100)}`,
    });
    this._metrics.tasksFailed++;
    if (!this._agentErrors.has(taskId)) {
      this._agentErrors.set(taskId, []);
    }
    this._agentErrors.get(taskId)!.push(error);
    this._pruneTimeline();
  }

  /** Record a message sent on the bus. */
  recordMessage(message: SwarmMessage): void {
    // Don't record every heartbeat to avoid noise
    if (message.type === MessageType.Heartbeat) return;

    this._timeline.push({
      timestamp: Date.now(),
      type: "message_sent",
      agentId: message.sender,
      detail: `${message.type}: ${message.sender} → ${message.recipient ?? "broadcast"}`,
    });
    this._pruneTimeline();
  }

  /** Record an execution-level start. */
  recordLevelStart(levelIndex: number, taskCount: number): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "level_start",
      detail: `Level ${levelIndex}: ${taskCount} tasks`,
    });
    this._pruneTimeline();
  }

  /** Record an execution-level completion. */
  recordLevelComplete(levelIndex: number): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "level_complete",
      detail: `Level ${levelIndex} done`,
    });
    this._pruneTimeline();
  }

  /** Record an error. */
  recordError(error: string): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "error",
      detail: error.slice(0, 200),
    });
    this._pruneTimeline();
  }

  // ------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------

  /**
   * Build a point-in-time snapshot of the swarm.
   * Call this periodically (e.g., every 500ms) from the TUI.
   */
  getSnapshot(
    agents: SwarmAgentHandle[],
    topology?: string,
  ): SwarmSnapshot {
    this._updateMetrics(agents);

    const snapshot: SwarmSnapshot = {
      agents,
      topology: topology as any,
      completedResults: [],
      metrics: { ...this._metrics },
      timestamp: Date.now(),
    };

    this._stateHistory.push(snapshot);
    if (this._stateHistory.length > this._maxHistory) {
      this._stateHistory.shift();
    }

    this.onUpdate?.(snapshot);
    return snapshot;
  }

  // ------------------------------------------------------------------
  // Metrics access
  // ------------------------------------------------------------------

  /** Get current metrics without building a full snapshot. */
  getMetrics(): SwarmMetrics {
    return { ...this._metrics };
  }

  /** Get the event timeline. */
  getTimeline(limit = 50): TimelineEvent[] {
    return this._timeline.slice(-limit);
  }

  /** Get agent errors. */
  getAgentErrors(): Map<string, string[]> {
    return new Map(this._agentErrors);
  }

  /** Get task durations (ms). */
  getTaskDurations(): Map<string, number> {
    return new Map(this._taskDurations);
  }

  /** Get average task duration. */
  getAverageTaskDuration(): number {
    const durations = [...this._taskDurations.values()];
    if (durations.length === 0) return 0;
    return durations.reduce((s, d) => s + d, 0) / durations.length;
  }

  /** Get swarm efficiency ratio (busy time / total time). */
  getEfficiency(): number {
    const elapsed = this._metrics.elapsedMs;
    if (elapsed === 0) return 0;
    const totalBusy = [...this._taskDurations.values()].reduce((s, d) => s + d, 0);
    return Math.min(1, totalBusy / (elapsed * Math.max(1, this._metrics.activeAgents)));
  }

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  /**
   * Format a compact status line for the TUI status bar.
   */
  formatStatusLine(): string {
    const m = this._metrics;
    const elapsed = (m.elapsedMs / 1000).toFixed(0);
    return [
      `🐝 ${m.activeAgents} active`,
      `✓${m.tasksCompleted} ✗${m.tasksFailed}`,
      `${(m.totalTokens / 1000).toFixed(0)}K tok`,
      `${elapsed}s`,
    ].join(" | ");
  }

  /**
   * Format a detailed status panel for the TUI.
   */
  formatStatusPanel(): string {
    const parts: string[] = [
      "╔══════════════════════════════════╗",
      "║      SwarmFlow Status            ║",
      "╚══════════════════════════════════╝",
      "",
    ];

    const m = this._metrics;
    parts.push(`Duration: ${(m.elapsedMs / 1000).toFixed(1)}s`);
    parts.push(`Agents:   ${m.activeAgents} active`);
    parts.push(`Tasks:    ✓ ${m.tasksCompleted}  ✗ ${m.tasksFailed}  pending ${m.tasksPending}`);
    parts.push(`Tokens:   ${(m.totalTokens / 1000).toFixed(0)}K`);
    parts.push(`Efficiency: ${(this.getEfficiency() * 100).toFixed(0)}%`);

    // Recent timeline
    const recent = this.getTimeline(5);
    if (recent.length > 0) {
      parts.push("");
      parts.push("Recent events:");
      for (const ev of recent) {
        const ago = ((Date.now() - ev.timestamp) / 1000).toFixed(1);
        parts.push(`  [${ago}s ago] ${ev.detail ?? ev.type}`);
      }
    }

    return parts.join("\n");
  }

  /** Reset all monitoring data. */
  reset(): void {
    this._timeline = [];
    this._metrics = {
      totalTokens: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksPending: 0,
      activeAgents: 0,
      elapsedMs: 0,
    };
    this._startTime = Date.now();
    this._stateHistory = [];
    this._agentErrors.clear();
    this._taskDurations.clear();
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private _updateMetrics(agents?: SwarmAgentHandle[]): void {
    this._metrics.elapsedMs = Date.now() - this._startTime;
    if (agents) {
      this._metrics.activeAgents = agents.filter(
        (a) => ![AgentLifecycle.Completed, AgentLifecycle.Cancelled].includes(a.lifecycle as AgentLifecycle),
      ).length;
    }
  }

  private _pruneTimeline(): void {
    if (this._timeline.length > 10_000) {
      this._timeline = this._timeline.slice(-5_000);
    }
  }
}

/**
 * Format a swarm snapshot as a compact TUI-friendly summary.
 */
export function formatSwarmSnapshot(snapshot: SwarmSnapshot): string {
  const parts: string[] = [];

  // Header
  parts.push(`🐝 Swarm  |  ${snapshot.agents.length} agents  |  ${snapshot.metrics.activeAgents} active`);

  // Agent list
  for (const agent of snapshot.agents) {
    const icon = agent.lifecycle === AgentLifecycle.Completed ? "✅"
      : agent.lifecycle === AgentLifecycle.Error ? "❌"
      : agent.lifecycle === AgentLifecycle.Thinking ? "💭"
      : agent.lifecycle === AgentLifecycle.ToolCalling ? "🔧"
      : agent.lifecycle === AgentLifecycle.Blocked ? "⏸️"
      : agent.lifecycle === AgentLifecycle.Cancelled ? "🚫"
      : "⏳";

    parts.push(`  ${icon} ${agent.id} (${agent.role}) — ${agent.lifecycle}`);
    if (agent.error) parts.push(`       Error: ${agent.error}`);
  }

  // Metrics
  const m = snapshot.metrics;
  parts.push(`Tasks: ✓${m.tasksCompleted} ✗${m.tasksFailed} pending:${m.tasksPending}`);
  parts.push(`Tokens: ${(m.totalTokens / 1000).toFixed(0)}K  |  ${(m.elapsedMs / 1000).toFixed(1)}s`);

  return parts.join("\n");
}
