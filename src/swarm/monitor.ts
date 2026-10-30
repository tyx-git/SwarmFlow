/**
 * SwarmMonitor — swarm 的实时监控和可观测性。
 *
 * 从协调器、消息总线和执行器收集事件；
 * 聚合指标；为 TUI/GUI 提供快照。
 *
 * @packageDocumentation
 */

import type { SwarmSnapshot, SwarmMetrics, TaskResult, SwarmMessage, SwarmAgentHandle, TaskDAG } from "./types.js";
import { AgentLifecycle, getAgentRoleLabel, MessageType } from "./types.js";

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
  // 事件记录
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

  /** 记录 agent 生命周期变化。 */
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

  /** 记录任务开始。 */
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

  /** 记录任务成功完成。 */
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

  /** 记录任务失败。 */
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

  /** 记录总线上发出的消息。 */
  recordMessage(message: SwarmMessage): void {
    // 心跳不逐条记录，避免噪声
    if (message.type === MessageType.Heartbeat) return;

    this._timeline.push({
      timestamp: Date.now(),
      type: "message_sent",
      agentId: message.sender,
      detail: `${message.type}: ${message.sender} → ${message.recipient ?? "broadcast"}`,
    });
    this._pruneTimeline();
  }

  /** 记录执行层级开始。 */
  recordLevelStart(levelIndex: number, taskCount: number): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "level_start",
      detail: `Level ${levelIndex}: ${taskCount} tasks`,
    });
    this._pruneTimeline();
  }

  /** 记录执行层级完成。 */
  recordLevelComplete(levelIndex: number): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "level_complete",
      detail: `Level ${levelIndex} done`,
    });
    this._pruneTimeline();
  }

  /** 记录错误。 */
  recordError(error: string): void {
    this._timeline.push({
      timestamp: Date.now(),
      type: "error",
      detail: error.slice(0, 200),
    });
    this._pruneTimeline();
  }

  // ------------------------------------------------------------------
  // 快照
  // ------------------------------------------------------------------

  /**
   * 构建 swarm 的即时快照。
   * 由 TUI 周期性调用（例如每 500ms 一次）。
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
  // 指标访问
  // ------------------------------------------------------------------

  /** 只读取当前指标，不构建完整快照。 */
  getMetrics(): SwarmMetrics {
    return { ...this._metrics };
  }

  /** 获取事件时间线。 */
  getTimeline(limit = 50): TimelineEvent[] {
    return this._timeline.slice(-limit);
  }

  /** 获取 agent 错误。 */
  getAgentErrors(): Map<string, string[]> {
    return new Map(this._agentErrors);
  }

  /** 获取任务耗时（毫秒）。 */
  getTaskDurations(): Map<string, number> {
    return new Map(this._taskDurations);
  }

  /** 获取任务平均耗时。 */
  getAverageTaskDuration(): number {
    const durations = [...this._taskDurations.values()];
    if (durations.length === 0) return 0;
    return durations.reduce((s, d) => s + d, 0) / durations.length;
  }

  /** 获取 swarm 效率比（忙碌时间 / 总时间）。 */
  getEfficiency(): number {
    const elapsed = this._metrics.elapsedMs;
    if (elapsed === 0) return 0;
    const totalBusy = [...this._taskDurations.values()].reduce((s, d) => s + d, 0);
    return Math.min(1, totalBusy / (elapsed * Math.max(1, this._metrics.activeAgents)));
  }

  // ------------------------------------------------------------------
  // 格式化
  // ------------------------------------------------------------------

  /**
   * 格式化 TUI 状态栏用的紧凑状态行。
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
   * 格式化 TUI 用的详细状态面板。
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

    // 最近事件
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

  /** 重置所有监控数据。 */
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
  // 私有
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
 * 将 swarm 快照格式化为简洁的、适合 TUI 的摘要。
 */
export function formatSwarmSnapshot(snapshot: SwarmSnapshot): string {
  const parts: string[] = [];

  // 头部
  parts.push(`🐝 Swarm  |  ${snapshot.agents.length} agents  |  ${snapshot.metrics.activeAgents} active`);

  // Agent 列表
  for (const agent of snapshot.agents) {
    const icon = agent.lifecycle === AgentLifecycle.Completed ? "✅"
      : agent.lifecycle === AgentLifecycle.Error ? "❌"
      : agent.lifecycle === AgentLifecycle.Thinking ? "💭"
      : agent.lifecycle === AgentLifecycle.ToolCalling ? "🔧"
      : agent.lifecycle === AgentLifecycle.Blocked ? "⏸️"
      : agent.lifecycle === AgentLifecycle.Cancelled ? "🚫"
      : "⏳";

    parts.push(`  ${icon} ${agent.id} (${getAgentRoleLabel(agent.role)}) — ${agent.lifecycle}`);
    if (agent.error) parts.push(`       Error: ${agent.error}`);
  }

  // 指标
  const m = snapshot.metrics;
  parts.push(`Tasks: ✓${m.tasksCompleted} ✗${m.tasksFailed} pending:${m.tasksPending}`);
  parts.push(`Tokens: ${(m.totalTokens / 1000).toFixed(0)}K  |  ${(m.elapsedMs / 1000).toFixed(1)}s`);

  return parts.join("\n");
}
