/**
 * Tests for the TaskDecomposer.
 */

import { describe, expect, it } from "vitest";
import { TaskDecomposer } from "../../src/swarm/decomposer.js";
import { validateDAG } from "../../src/swarm/task-dag.js";
import { AgentRole } from "../../src/swarm/types.js";

describe("TaskDecomposer", () => {
  const decomposer = new TaskDecomposer();

  it("decomposes a feature request", async () => {
    const dag = await decomposer.decompose("Add a new user login endpoint");
    const validation = validateDAG(dag);
    expect(validation.valid).toBe(true);

    // Should include scout + worker
    const roles = [...dag.nodes.values()].map((n) => n.role);
    expect(roles).toContain(AgentRole.Scout);
    expect(roles).toContain(AgentRole.Worker);
  });

  it("decomposes a bug fix request", async () => {
    const dag = await decomposer.decompose("Fix the login button not working");
    const validation = validateDAG(dag);
    expect(validation.valid).toBe(true);
  });

  it("decomposes a refactor request", async () => {
    const dag = await decomposer.decompose("Refactor the auth module to use JWT");
    const validation = validateDAG(dag);
    expect(validation.valid).toBe(true);
    expect(dag.nodes.size).toBeGreaterThanOrEqual(4); // scout + 2 workers + reviewer
  });

  it("decomposes an exploration request", async () => {
    const dag = await decomposer.decompose("Explain how the payment system works");
    const validation = validateDAG(dag);
    expect(validation.valid).toBe(true);
  });

  it("decomposes a security request", async () => {
    const dag = await decomposer.decompose("Audit the API for security vulnerabilities");
    const validation = validateDAG(dag);
    expect(validation.valid).toBe(true);
    expect([...dag.nodes.values()].some((n) => n.role === AgentRole.Guard)).toBe(true);
  });

  it("respects maxTasks limit", async () => {
    const limited = new TaskDecomposer({ maxTasks: 2 });
    const dag = await limited.decompose("Refactor everything");
    expect(dag.nodes.size).toBeLessThanOrEqual(2);
  });
});
