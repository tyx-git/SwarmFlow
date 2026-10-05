import { describe, expect, it, vi } from "vitest";

import type { Agent } from "../../src/agents/agent.js";
import { SwarmCoordinator } from "../../src/swarm/coordinator.js";
import { TaskDecomposer } from "../../src/swarm/decomposer.js";
import { SwarmExecutor } from "../../src/swarm/executor.js";
import { formatDirectDependencyResults } from "../../src/swarm/task-handoff.js";
import { createDAG } from "../../src/swarm/task-dag.js";
import { AgentRole } from "../../src/swarm/types.js";
import type { TaskDAG, TaskResult } from "../../src/swarm/types.js";

interface AgentCall {
  role: AgentRole;
  prompt: string;
}

interface FakeTemplateOptions {
  calls: AgentCall[];
  delayMs?: number;
  failRoles?: ReadonlySet<AgentRole>;
  waitForeverRoles?: ReadonlySet<AgentRole>;
  onStart?: (role: AgentRole) => void;
  onActivity?: (active: number) => void;
}

function handoffOutput(role: AgentRole): string {
  const changed = role === AgentRole.Worker ? ["src/feature.ts"] : [];
  return [
    `RAW_${role}`,
    "```swarmflow-handoff",
    JSON.stringify({
      conclusion: `${role.toUpperCase()}_CONCLUSION`,
      modified_files: changed,
      test_results: [`${role} validation passed`],
      risks: [],
      open_questions: [],
    }),
    "```",
  ].join("\n");
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectOnAbort = () => reject(new Error("aborted"));
    if (signal.aborted) {
      rejectOnAbort();
      return;
    }
    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
}

function makeTemplates(options: FakeTemplateOptions): Record<string, Agent> {
  const templates: Record<string, Agent> = {};
  let active = 0;

  for (const role of Object.values(AgentRole)) {
    templates[role] = {
      clone: () => ({
        asyncRun: async (
          prompt: string,
          _extraMessages?: unknown,
          _toolExecutors?: unknown,
          _onToolCall?: unknown,
          signal?: AbortSignal,
        ) => {
          options.calls.push({ role, prompt });
          options.onStart?.(role);
          active += 1;
          options.onActivity?.(active);
          try {
            if (options.failRoles?.has(role)) {
              throw new Error(`${role} failed`);
            }
            if (options.waitForeverRoles?.has(role)) {
              await waitForAbort(signal ?? new AbortController().signal);
            } else if ((options.delayMs ?? 0) > 0) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, options.delayMs);
                const rejectOnAbort = () => {
                  clearTimeout(timer);
                  reject(new Error("aborted"));
                };
                if (signal?.aborted) {
                  rejectOnAbort();
                } else {
                  signal?.addEventListener("abort", rejectOnAbort, { once: true });
                }
              });
            }
            return {
              text: handoffOutput(role),
              totalUsage: { inputTokens: 100, outputTokens: 50 },
            };
          } finally {
            active -= 1;
            options.onActivity?.(active);
          }
        },
      }),
    } as unknown as Agent;
  }

  return templates;
}

function fullRolePipelineDag(): TaskDAG {
  return createDAG([
    { id: "queen-plan", role: AgentRole.Queen, description: "PLAN_TASK", dependencies: [], priority: 1 },
    { id: "scout-explore", role: AgentRole.Scout, description: "SCOUT_TASK", dependencies: ["queen-plan"], priority: 1 },
    { id: "worker-implement", role: AgentRole.Worker, description: "WORKER_TASK", dependencies: ["scout-explore"], priority: 1 },
    { id: "reviewer-review", role: AgentRole.Reviewer, description: "REVIEWER_TASK", dependencies: ["worker-implement"], priority: 2 },
    { id: "guard-verify", role: AgentRole.Guard, description: "GUARD_TASK", dependencies: ["worker-implement"], priority: 2 },
    {
      id: "merger-summarize",
      role: AgentRole.Merger,
      description: "MERGER_TASK",
      dependencies: ["worker-implement", "reviewer-review", "guard-verify"],
      priority: 2,
    },
    { id: "queen-accept", role: AgentRole.Queen, description: "ACCEPT_TASK", dependencies: ["merger-summarize"], priority: 3 },
  ]);
}

function callFor(calls: readonly AgentCall[], marker: string): AgentCall {
  const call = calls.find((entry) => entry.prompt.includes(marker));
  if (!call) throw new Error(`No call found for ${marker}`);
  return call;
}

describe("DAG role pipeline", () => {
  it("runs Queen -> Scout -> Worker -> parallel Reviewer/Guard -> Merger -> Queen acceptance", async () => {
    const calls: AgentCall[] = [];
    let maxActive = 0;
    const templates = makeTemplates({
      calls,
      delayMs: 5,
      onActivity: (active) => { maxActive = Math.max(maxActive, active); },
    });

    const executor = new SwarmExecutor({ templates });
    const result = await executor.run({ task: "implement the feature", dag: fullRolePipelineDag() });

    expect(result.success).toBe(true);
    expect(result.failedTaskIds).toEqual([]);
    expect(result.results.size).toBe(7);
    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(calls.slice(0, 3).map((call) => call.role)).toEqual([
      AgentRole.Queen,
      AgentRole.Scout,
      AgentRole.Worker,
    ]);
    expect(calls.slice(3, 5).map((call) => call.role)).toEqual(
      expect.arrayContaining([AgentRole.Reviewer, AgentRole.Guard]),
    );
    expect(calls[5]?.role).toBe(AgentRole.Merger);
    expect(calls[6]?.role).toBe(AgentRole.Queen);

    const scout = callFor(calls, "SCOUT_TASK");
    const worker = callFor(calls, "WORKER_TASK");
    const reviewer = callFor(calls, "REVIEWER_TASK");
    const guard = callFor(calls, "GUARD_TASK");
    const merger = callFor(calls, "MERGER_TASK");
    const acceptance = callFor(calls, "ACCEPT_TASK");

    expect(scout.prompt).toContain("QUEEN_CONCLUSION");
    expect(worker.prompt).toContain("SCOUT_CONCLUSION");
    expect(worker.prompt).not.toContain("QUEEN_CONCLUSION");
    expect(reviewer.prompt).toContain("WORKER_CONCLUSION");
    expect(reviewer.prompt).not.toContain("SCOUT_CONCLUSION");
    expect(guard.prompt).toContain("WORKER_CONCLUSION");
    expect(guard.prompt).not.toContain("SCOUT_CONCLUSION");
    expect(merger.prompt).toContain("WORKER_CONCLUSION");
    expect(merger.prompt).toContain("REVIEWER_CONCLUSION");
    expect(merger.prompt).toContain("GUARD_CONCLUSION");
    expect(merger.prompt).not.toContain("SCOUT_CONCLUSION");
    expect(merger.prompt).not.toContain("RAW_");
    expect(acceptance.prompt).toContain("MERGER_CONCLUSION");
    expect(acceptance.prompt).not.toContain("WORKER_CONCLUSION");
    expect(acceptance.prompt).not.toContain("RAW_");
    for (const call of calls) expect(call.prompt).not.toMatch(/RAW_/);

    expect(result.results.get("worker-implement")?.modifiedFiles).toEqual(["src/feature.ts"]);
    expect(result.results.get("merger-summarize")?.handoff?.conclusion).toBe("MERGER_CONCLUSION");
    expect(result.results.get("queen-accept")?.handoff?.conclusion).toBe("QUEEN_CONCLUSION");
  });

  it("blocks every downstream node after a failed dependency and reports failures", async () => {
    const calls: AgentCall[] = [];
    const onTaskFailed = vi.fn();
    const coordinator = new SwarmCoordinator({
      templates: makeTemplates({ calls, failRoles: new Set([AgentRole.Scout]) }),
      events: { onTaskFailed },
    });
    const dag = createDAG([
      { id: "scout", role: AgentRole.Scout, description: "SCOUT", dependencies: [], priority: 1 },
      { id: "worker", role: AgentRole.Worker, description: "WORKER", dependencies: ["scout"], priority: 1 },
      { id: "reviewer", role: AgentRole.Reviewer, description: "REVIEWER", dependencies: ["worker"], priority: 2 },
    ]);

    const result = await coordinator.executeDag(dag);

    expect(calls.map((call) => call.role)).toEqual([AgentRole.Scout]);
    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(["scout", "worker", "reviewer"]);
    expect(result.results.get("worker")?.error).toContain("Blocked by failed dependencies: scout");
    expect(result.results.get("reviewer")?.error).toContain("Blocked by failed dependencies: worker");
    expect(onTaskFailed).toHaveBeenCalledTimes(3);
  });

  it("marks not-started tasks as failed when execution is cancelled", async () => {
    const calls: AgentCall[] = [];
    let started = false;
    const coordinator = new SwarmCoordinator({
      templates: makeTemplates({
        calls,
        waitForeverRoles: new Set([AgentRole.Scout]),
        onStart: (role) => { if (role === AgentRole.Scout) started = true; },
      }),
    });
    const dag = createDAG([
      { id: "scout", role: AgentRole.Scout, description: "SCOUT", dependencies: [], priority: 1 },
      { id: "worker", role: AgentRole.Worker, description: "WORKER", dependencies: ["scout"], priority: 1 },
    ]);

    const execution = coordinator.executeDag(dag);
    for (let attempt = 0; attempt < 100 && !started; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(started).toBe(true);
    coordinator.cancel();
    const result = await execution;

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(["scout", "worker"]);
    expect(result.results.get("scout")?.error).toBe("aborted");
    expect(result.results.get("worker")?.error).toBe("Execution cancelled before task started");
    expect(calls.map((call) => call.role)).toEqual([AgentRole.Scout]);
  });

  it("rejects invalid DAGs before any role can consume tokens", async () => {
    const calls: AgentCall[] = [];
    const coordinator = new SwarmCoordinator({ templates: makeTemplates({ calls }) });
    const invalid = createDAG([
      { id: "a", role: AgentRole.Scout, description: "A", dependencies: ["b"], priority: 1 },
      { id: "b", role: AgentRole.Worker, description: "B", dependencies: ["a"], priority: 1 },
    ]);

    const result = await coordinator.executeDag(invalid);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Cannot execute invalid DAG");
    expect(result.summary).toMatch(/DAG (contains a cycle|包含环)/);
    expect(calls).toEqual([]);
  });

  it("stops dispatching after the pool token budget is exhausted", async () => {
    const calls: AgentCall[] = [];
    const coordinator = new SwarmCoordinator({
      templates: makeTemplates({ calls }),
      poolConfig: { maxTokenBudget: 100 },
    });
    const dag = createDAG([
      { id: "first", role: AgentRole.Scout, description: "FIRST", dependencies: [], priority: 1 },
      { id: "second", role: AgentRole.Worker, description: "SECOND", dependencies: ["first"], priority: 1 },
    ]);

    const result = await coordinator.executeDag(dag);

    expect(calls.map((call) => call.role)).toEqual([AgentRole.Scout]);
    expect(result.results.get("first")?.success).toBe(true);
    expect(result.results.get("second")?.success).toBe(false);
    expect(result.results.get("second")?.error).toContain("pool at capacity");
  });
});

describe("DAG context budget", () => {
  it("clips unstructured dependency evidence and excludes transitive results", () => {
    const dag = createDAG([
      { id: "queen", role: AgentRole.Queen, description: "Plan", dependencies: [], priority: 1 },
      { id: "scout", role: AgentRole.Scout, description: "Explore", dependencies: ["queen"], priority: 1 },
      { id: "worker", role: AgentRole.Worker, description: "Implement", dependencies: ["scout"], priority: 1 },
    ]);
    const largeOutput = "UNTRUSTED_OUTPUT ".repeat(10_000);
    const results = new Map<string, TaskResult>([
      ["queen", {
        taskId: "queen",
        agentId: "queen-agent",
        success: true,
        output: "QUEEN_RAW_PLAN",
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 1,
      }],
      ["scout", {
        taskId: "scout",
        agentId: "scout-agent",
        success: true,
        output: largeOutput,
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 1,
      }],
    ]);

    const context = formatDirectDependencyResults(dag.nodes.get("worker")!, dag, results);

    expect(context.length).toBeLessThanOrEqual(24_000);
    expect(context).toContain("untrusted");
    expect(context).toContain("UNTRUSTED_OUTPUT");
    expect(context).not.toContain("QUEEN_RAW_PLAN");
    expect(context).not.toContain("## Direct Dependency Results\n## Direct Dependency Results");
  });
});

describe("TaskDecomposer planning contract", () => {
  it("creates a dependency plan before implementation and review", async () => {
    const dag = await new TaskDecomposer().decompose("Refactor the auth module");
    const scout = [...dag.nodes.values()].find((node) => node.role === AgentRole.Scout);
    const workers = [...dag.nodes.values()].filter((node) => node.role === AgentRole.Worker);
    const reviewer = [...dag.nodes.values()].find((node) => node.role === AgentRole.Reviewer);

    expect(scout).toBeTruthy();
    expect(workers.length).toBe(2);
    expect(workers.every((node) => node.dependencies.includes(scout!.id))).toBe(true);
    expect(reviewer?.dependencies).toEqual(workers.map((node) => node.id));
  });
});
