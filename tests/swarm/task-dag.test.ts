/**
 * Tests for TaskDAG operations.
 */

import { describe, expect, it } from "bun:test";
import { createDAG, validateDAG, hasCycle, getLevels, topologicalSort, addNode, removeNode, serializeDAG } from "../../src/swarm/task-dag.js";
import { AgentRole } from "../../src/swarm/types.js";

describe("TaskDAG", () => {
  it("creates a valid DAG from nodes", () => {
    const dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "Explore", dependencies: [], priority: 1 },
      { id: "b", role: AgentRole.Worker, description: "Implement", dependencies: ["a"], priority: 1 },
    ]);

    expect(dag.nodes.size).toBe(2);
    expect(dag.entryPoints).toEqual(["a"]);
  });

  it("validates a valid DAG", () => {
    const dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "Explore", dependencies: [], priority: 1 },
      { id: "b", role: AgentRole.Worker, description: "Work", dependencies: ["a"], priority: 1 },
    ]);
    const result = validateDAG(dag);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("detects missing dependencies", () => {
    const dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "A", dependencies: ["nonexistent"], priority: 1 },
    ]);
    const result = validateDAG(dag);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("detects cycles", () => {
    const dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "A", dependencies: ["b"], priority: 1 },
      { id: "b", role: AgentRole.Worker, description: "B", dependencies: ["a"], priority: 1 },
    ]);
    expect(hasCycle(dag)).toBe(true);
  });

  it("computes execution levels correctly", () => {
    const dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "A", dependencies: [], priority: 1 },
      { id: "b", role: AgentRole.Scout, description: "B", dependencies: [], priority: 1 },
      { id: "c", role: AgentRole.Worker, description: "C", dependencies: ["a", "b"], priority: 1 },
      { id: "d", role: AgentRole.Reviewer, description: "D", dependencies: ["c"], priority: 2 },
    ]);

    const levels = getLevels(dag);
    expect(levels.length).toBe(3);
    expect(levels[0]!.taskIds.sort()).toEqual(["a", "b"]);
    expect(levels[1]!.taskIds).toEqual(["c"]);
    expect(levels[2]!.taskIds).toEqual(["d"]);
  });

  it("topologically sorts correctly", () => {
    const dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "A", dependencies: [], priority: 1 },
      { id: "b", role: AgentRole.Worker, description: "B", dependencies: ["a"], priority: 1 },
      { id: "c", role: AgentRole.Worker, description: "C", dependencies: ["a"], priority: 1 },
    ]);

    const sorted = topologicalSort(dag);
    expect(sorted[0]).toBe("a");
    expect(sorted.slice(1).sort()).toEqual(["b", "c"]);
  });

  it("supports addNode and removeNode", () => {
    let dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "A", dependencies: [], priority: 1 },
    ]);

    // Add node
    dag = addNode(dag, { id: "b", role: AgentRole.Worker, description: "B", dependencies: ["a"], priority: 1 });
    expect(dag.nodes.size).toBe(2);

    // Remove node
    dag = removeNode(dag, "b");
    expect(dag.nodes.size).toBe(1);
  });

  it("serializes to JSON", () => {
    const dag = createDAG([
      { id: "a", role: AgentRole.Scout, description: "Test", dependencies: [], priority: 1 },
    ]);
    const serialized = serializeDAG(dag);
    expect(serialized).toHaveProperty("tasks");
    expect(serialized).toHaveProperty("executionOrder");
  });
});
