/**
 * TaskDAG — 用于 swarm 任务分解的有向无环图操作。
 *
 * 提供了用于创建、验证和操作任务 DAG 的工具：
 * 环检测、拓扑排序、层级分配和依赖检查。
 *
 * @packageDocumentation
 */

import type { TaskNode, TaskDAG } from "./types.js";

// ------------------------------------------------------------------
// DAG 创建
// ------------------------------------------------------------------

/** 创建 TaskDAG 的选项。 */
export interface TaskDAGOptions {
  /** 任务节点。 */
  nodes?: TaskNode[];
}

/**
 * 从节点数组创建新的 TaskDAG。
 * 自动计算 entryPoints（无依赖的节点）。
 */
export function createDAG(nodes: TaskNode[]): TaskDAG {
  const nodeMap = new Map<string, TaskNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  return {
    nodes: nodeMap,
    entryPoints: nodes.filter((n) => n.dependencies.length === 0).map((n) => n.id),
  };
}

/**
 * 创建单节点 DAG（最简单的情况：一个任务，无依赖）。
 */
export function singleTaskDAG(id: string, role: string, description: string): TaskDAG {
  return createDAG([
    { id, role: role as any, description, dependencies: [], priority: 1 },
  ]);
}

// ------------------------------------------------------------------
// 验证
// ------------------------------------------------------------------

/** DAG 验证结果。 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 验证 TaskDAG：
 * - 所有依赖 ID 存在
 * - 无环
 * - 无重复 ID
 * - 所有入口点无依赖
 */
export function validateDAG(dag: TaskDAG): ValidationResult {
  const errors: string[] = [];

  // 检查空 DAG
  if (dag.nodes.size === 0) {
    return { valid: false, errors: ["DAG 为空"] };
  }

  // 检查所有依赖是否存在
  for (const [id, node] of dag.nodes) {
    for (const depId of node.dependencies) {
      if (!dag.nodes.has(depId)) {
        errors.push(`任务 "${id}" 依赖于未知任务 "${depId}"`);
      }
    }
  }

  // 检查重复 ID
  const ids = new Set<string>();
  for (const id of dag.nodes.keys()) {
    if (ids.has(id)) {
      errors.push(`重复的任务 ID："${id}"`);
    }
    ids.add(id);
  }

  // 使用 DFS 进行环检测
  if (hasCycle(dag)) {
    errors.push("DAG 包含环");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 检查 DAG 是否包含环。
 * 使用带访问集合和递归栈的 DFS。
 */
export function hasCycle(dag: TaskDAG): boolean {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    inStack.add(nodeId);

    const node = dag.nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        if (dfs(depId)) return true;
      }
    }

    inStack.delete(nodeId);
    return false;
  }

  for (const nodeId of dag.nodes.keys()) {
    if (dfs(nodeId)) return true;
  }

  return false;
}

// ------------------------------------------------------------------
// 拓扑操作
// ------------------------------------------------------------------

/**
 * 拓扑排序 — 按执行顺序返回任务 ID。
 * 无依赖的任务优先；有依赖的任务排在后面。
 * 如果检测到环则抛出异常。
 */
export function topologicalSort(dag: TaskDAG): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = dag.nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        visit(depId);
      }
    }
    result.push(nodeId);
  }

  for (const nodeId of dag.nodes.keys()) {
    visit(nodeId);
  }

  return result;
}

/**
 * 获取执行级别：同一级别的任务可以并行运行。
 * Level 0 = 入口点，Level N = 依赖于 Level N-1 中的至少一个任务。
 */
export function getLevels(dag: TaskDAG): Array<{ index: number; taskIds: string[] }> {
  const taskLevels = new Map<string, number>();

  function assignLevel(taskId: string): number {
    if (taskLevels.has(taskId)) return taskLevels.get(taskId)!;
    const node = dag.nodes.get(taskId);
    if (!node || node.dependencies.length === 0) {
      taskLevels.set(taskId, 0);
      return 0;
    }
    let maxDepLevel = 0;
    for (const depId of node.dependencies) {
      maxDepLevel = Math.max(maxDepLevel, assignLevel(depId));
    }
    const level = maxDepLevel + 1;
    taskLevels.set(taskId, level);
    return level;
  }

  for (const nodeId of dag.nodes.keys()) {
    assignLevel(nodeId);
  }

  const levelGroups = new Map<number, string[]>();
  for (const [taskId, level] of taskLevels) {
    if (!levelGroups.has(level)) levelGroups.set(level, []);
    levelGroups.get(level)!.push(taskId);
  }

  return [...levelGroups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, taskIds]) => ({ index, taskIds }));
}

// ------------------------------------------------------------------
// 操作
// ------------------------------------------------------------------

/**
 * 向 DAG 添加节点。返回新 DAG（不可变的）。
 */
export function addNode(dag: TaskDAG, node: TaskNode): TaskDAG {
  const newNodes = new Map(dag.nodes);
  newNodes.set(node.id, node);

  return {
    nodes: newNodes,
    entryPoints: [...newNodes.values()]
      .filter((n) => n.dependencies.length === 0)
      .map((n) => n.id),
  };
}

/**
 * 从 DAG 中移除节点。同时从其他节点的依赖中移除它。
 * 返回新 DAG（不可变的）。
 */
export function removeNode(dag: TaskDAG, nodeId: string): TaskDAG {
  const newNodes = new Map(dag.nodes);
  newNodes.delete(nodeId);

  // 从依赖列表中移除
  for (const [id, node] of newNodes) {
    const newDeps = node.dependencies.filter((d) => d !== nodeId);
    if (newDeps.length !== node.dependencies.length) {
      newNodes.set(id, { ...node, dependencies: newDeps });
    }
  }

  return {
    nodes: newNodes,
    entryPoints: [...newNodes.values()]
      .filter((n) => n.dependencies.length === 0)
      .map((n) => n.id),
  };
}

/**
 * 获取给定任务的所有祖先任务 ID（直接或传递依赖的任务）。
 */
export function getAncestors(dag: TaskDAG, taskId: string): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = dag.nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        ancestors.push(depId);
        visit(depId);
      }
    }
  }

  visit(taskId);
  return ancestors;
}

/**
 * 获取给定任务的所有后代任务 ID（直接或传递依赖于它的任务）。
 */
export function getDescendants(dag: TaskDAG, taskId: string): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>();

  for (const [id, node] of dag.nodes) {
    if (id === taskId) continue;
    if (node.dependencies.includes(taskId) || getAncestors(dag, id).includes(taskId)) {
      descendants.push(id);
    }
  }

  return descendants;
}

/**
 * 将 DAG 序列化为普通 JSON 对象（供 LLM 消费）。
 */
export function serializeDAG(dag: TaskDAG): object {
  return {
    tasks: [...dag.nodes.values()].map((n) => ({
      id: n.id,
      role: n.role,
      description: n.description,
      dependsOn: n.dependencies.length > 0 ? n.dependencies : undefined,
      priority: n.priority,
    })),
    executionOrder: getLevels(dag).map((l) => ({
      level: l.index,
      parallel: l.taskIds,
    })),
  };
}

/**
 * 估算 DAG 的总执行轮数。
 * 每个级别计为 1 轮，无论它包含多少任务。
 */
export function estimateRounds(dag: TaskDAG): number {
  return getLevels(dag).length;
}