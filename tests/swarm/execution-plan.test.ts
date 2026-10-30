import { describe, expect, it } from "vitest";

import { SwarmScheduler } from "../../src/swarm/scheduler.js";
import { buildExecutionPlan, createDAG } from "../../src/swarm/task-dag.js";
import { AgentRole } from "../../src/swarm/types.js";

const dag = createDAG([
  { id: "a", role: AgentRole.Scout, description: "A", dependencies: [], priority: 1 },
  { id: "b", role: AgentRole.Worker, description: "B", dependencies: ["a"], priority: 2 },
  { id: "c", role: AgentRole.Reviewer, description: "C", dependencies: ["b"], priority: 2 },
]);

describe("execution plan single source", () => {
  it("scheduler reuses the canonical plan builder", () => {
    const scheduler = new SwarmScheduler();
    const expected = buildExecutionPlan(dag);

    expect(scheduler.scheduleFast(dag)).toEqual(expected);
    expect(scheduler.schedule(dag).plan).toEqual(expected);
  });
});
