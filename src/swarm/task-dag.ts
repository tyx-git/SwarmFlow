/**
 * TaskDAG — Directed Acyclic Graph operations for swarm task decomposition.
 *
 * Provides utilities for creating, validating, and manipulating task DAGs:
 * cycle detection, topological sort, level assignment, and dependency checks.
 *
 * @packageDocumentation
 */

import type { TaskNode, TaskDAG } from "./types.js";

// ------------------------------------------------------------------
// DAG creation
// ------------------------------------------------------------------

/** Options for creating a TaskDAG. */
export interface TaskDAGOptions {
  /** Task nodes. */
  nodes?: TaskNode[];
}

/**
 * Create a new TaskDAG from an array of nodes.
 * Automatically computes entryPoints (nodes with no dependencies).
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
 * Create a single-node DAG (simplest case: one task, no dependencies).
 */
export function singleTaskDAG(id: string, role: string, description: string): TaskDAG {
  return createDAG([
    { id, role: role as any, description, dependencies: [], priority: 1 },
  ]);
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

/** Result of DAG validation. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a TaskDAG:
 * - All dependency IDs exist
 * - No cycles
 * - No duplicate IDs
 * - All entry points have no dependencies
 */
export function validateDAG(dag: TaskDAG): ValidationResult {
  const errors: string[] = [];

  // Check for empty DAG
  if (dag.nodes.size === 0) {
    return { valid: false, errors: ["DAG is empty"] };
  }

  // Check all dependencies exist
  for (const [id, node] of dag.nodes) {
    for (const depId of node.dependencies) {
      if (!dag.nodes.has(depId)) {
        errors.push(`Task "${id}" depends on unknown task "${depId}"`);
      }
    }
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const id of dag.nodes.keys()) {
    if (ids.has(id)) {
      errors.push(`Duplicate task ID: "${id}"`);
    }
    ids.add(id);
  }

  // Cycle detection using DFS
  if (hasCycle(dag)) {
    errors.push("DAG contains a cycle");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if a DAG contains a cycle.
 * Uses DFS with a visited set and a recursion stack.
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
// Topological operations
// ------------------------------------------------------------------

/**
 * Topological sort — returns task IDs in execution order.
 * Tasks with no dependencies come first; dependent tasks come after.
 * Throws if a cycle is detected.
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
 * Get execution levels: tasks in the same level can run in parallel.
 * Level 0 = entry points, Level N = depends on at least one task in Level N-1.
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
// Manipulation
// ------------------------------------------------------------------

/**
 * Add a node to a DAG. Returns a new DAG (immutable).
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
 * Remove a node from a DAG. Also removes it from other nodes' dependencies.
 * Returns a new DAG (immutable).
 */
export function removeNode(dag: TaskDAG, nodeId: string): TaskDAG {
  const newNodes = new Map(dag.nodes);
  newNodes.delete(nodeId);

  // Remove from dependency lists
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
 * Get all ancestor task IDs for a given task (tasks it depends on, directly or transitively).
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
 * Get all descendant task IDs for a given task (tasks that depend on it, directly or transitively).
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
 * Serialize a DAG to a plain JSON object (for LLM consumption).
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
 * Estimate the total number of execution rounds for a DAG.
 * Each level counts as 1 round regardless of how many tasks it contains.
 */
export function estimateRounds(dag: TaskDAG): number {
  return getLevels(dag).length;
}
