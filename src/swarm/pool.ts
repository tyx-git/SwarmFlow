/**
 * AgentPool — 管理 swarm 的 agent 实例。
 *
 * 从模板定义按角色获取 agent，处理生命周期追踪、资源配额和清理。
 *
 * @packageDocumentation
 */

import { Agent } from "../agents/agent.js";
import type { AgentRole, SwarmAgentHandle } from "./types.js";
import { AgentLifecycle, AgentRole as AgentRoleValue } from "./types.js";

/** AgentPool 的配置。 */
export interface AgentPoolConfig {
  /** 最大并发 agent 数量。 */
  maxConcurrency: number;
  /** 所有 agent 的最大总 token 预算。 */
  maxTokenBudget: number;
  /** 按角色映射的模板名称（后备）。 */
  roleTemplates: Partial<Record<AgentRole, string>>;
}

/** 默认池配置。 */
export const DEFAULT_POOL_CONFIG: AgentPoolConfig = {
  maxConcurrency: 5,
  maxTokenBudget: 2_000_000,
  roleTemplates: {
    [AgentRoleValue.Queen]: AgentRoleValue.Queen,
    [AgentRoleValue.Scout]: AgentRoleValue.Scout,
    [AgentRoleValue.Worker]: AgentRoleValue.Worker,
    [AgentRoleValue.Reviewer]: AgentRoleValue.Reviewer,
    [AgentRoleValue.Guard]: AgentRoleValue.Guard,
    [AgentRoleValue.Merger]: AgentRoleValue.Merger,
  },
};

/**
 * 管理 agent 实例池。
 *
 * 职责：
 * - 按角色获取 agent（从模板创建或复用）
 * - 追踪生命周期状态
 * - 强制执行并发和 token 预算
 * - 释放和清理 agent
 */
export class AgentPool {
  private _handles: Map<string, SwarmAgentHandle> = new Map();
  private _agents: Map<string, Agent> = new Map();
  private _config: AgentPoolConfig;

  /** agent 生命周期变化时触发。 */
  onLifecycleChange?: (handle: SwarmAgentHandle) => void;

  constructor(config?: Partial<AgentPoolConfig>) {
    this._config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  /** 当前池配置。 */
  get config(): AgentPoolConfig {
    return this._config;
  }

  /** 当前活跃（未完成、未取消）的 agent 数量。 */
  get activeCount(): number {
    let count = 0;
    for (const h of this._handles.values()) {
      if (![AgentLifecycle.Completed, AgentLifecycle.Cancelled].includes(h.lifecycle as AgentLifecycle)) {
        count++;
      }
    }
    return count;
  }

  /** 所有 agent 句柄。 */
  get handles(): SwarmAgentHandle[] {
    return [...this._handles.values()];
  }

  /** 所有 agent 的 token 总用量。 */
  get totalTokenUsage(): { inputTokens: number; outputTokens: number } {
    const totals = { inputTokens: 0, outputTokens: 0 };
    for (const h of this._handles.values()) {
      totals.inputTokens += h.tokenUsage.inputTokens;
      totals.outputTokens += h.tokenUsage.outputTokens;
    }
    return totals;
  }

  /**
   * 检查池是否还能接纳新 agent。
   */
  canAcquire(): boolean {
    if (this.activeCount >= this._config.maxConcurrency) return false;
    const usage = this.totalTokenUsage;
    if (usage.inputTokens + usage.outputTokens >= this._config.maxTokenBudget) return false;
    return true;
  }

  /**
   * 向池中注册新的 agent 实例。
   * 返回用于追踪的句柄。
   */
  register(id: string, role: AgentRole, agent: Agent): SwarmAgentHandle {
    const handle: SwarmAgentHandle = {
      id,
      role,
      lifecycle: AgentLifecycle.Idle,
      taskIds: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    };
    this._handles.set(id, handle);
    this._agents.set(id, agent);
    this._emitChange(handle);
    return handle;
  }

  /**
   * 按句柄 ID 获取 agent 实例。
   */
  getAgent(id: string): Agent | undefined {
    return this._agents.get(id);
  }

  /**
   * 按 ID 获取句柄。
   */
  getHandle(id: string): SwarmAgentHandle | undefined {
    return this._handles.get(id);
  }

  /**
   * 更新 agent 的生命周期状态。
   */
  setLifecycle(id: string, lifecycle: AgentLifecycle, error?: string): void {
    const handle = this._handles.get(id);
    if (!handle) return;
    handle.lifecycle = lifecycle;
    handle.lastActiveAt = Date.now();
    if (error) handle.error = error;
    this._emitChange(handle);
  }

  /**
   * 记录 agent 的 token 用量。
   */
  recordUsage(id: string, inputTokens: number, outputTokens: number): void {
    const handle = this._handles.get(id);
    if (!handle) return;
    handle.tokenUsage.inputTokens += inputTokens;
    handle.tokenUsage.outputTokens += outputTokens;
    handle.lastActiveAt = Date.now();
  }

  /**
   * 给 agent 分配任务。
   */
  assignTask(id: string, taskId: string): void {
    const handle = this._handles.get(id);
    if (!handle) return;
    if (!handle.taskIds.includes(taskId)) {
      handle.taskIds.push(taskId);
    }
    this._emitChange(handle);
  }

  /**
   * 从 agent 的任务列表中移除已完成的任务。
   */
  unassignTask(id: string, taskId: string): void {
    const handle = this._handles.get(id);
    if (!handle) return;
    handle.taskIds = handle.taskIds.filter((t) => t !== taskId);
    this._emitChange(handle);
  }

  /**
   * 从池中释放 agent。
   */
  release(id: string): void {
    this._handles.delete(id);
    this._agents.delete(id);
  }

  /**
   * 释放所有 agent。
   */
  releaseAll(): void {
    this._handles.clear();
    this._agents.clear();
  }

  private _emitChange(handle: SwarmAgentHandle): void {
    this.onLifecycleChange?.(handle);
  }
}
