import { describe, expect, it, vi } from "vitest";

import { SwarmCoordinator } from "../../src/swarm/coordinator.js";
import {
  getTerminalMergerResults,
  formatDirectDependencyResults,
  splitTaskHandoffForDisplay,
} from "../../src/swarm/task-handoff.js";
import { AgentRole } from "../../src/swarm/types.js";
import type { TaskDAG, TaskResult } from "../../src/swarm/types.js";

function handoff(conclusion: string): string {
  return [
    "report",
    "```swarmflow-handoff",
    JSON.stringify({
      conclusion,
      modified_files: ["src/example.ts"],
      test_results: ["typecheck passed"],
      risks: [],
      open_questions: [],
    }),
    "```",
  ].join("\n");
}

function result(taskId: string, output: string, success = true): TaskResult {
  return {
    taskId,
    agentId: `${taskId}-agent`,
    success,
    output,
    handoff: success ? undefined : undefined,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    ...(success ? {} : { error: "failed" }),
  };
}

describe("handoff display splitter", () => {
  const block = (payload: string): string => [
    "```swarmflow-handoff",
    payload,
    "```",
  ].join("\n");

  it("strips a complete block and returns its conclusion", () => {
    const result = splitTaskHandoffForDisplay(`report\n\n${block(JSON.stringify({
      conclusion: "done",
      modified_files: [],
      test_results: [],
      risks: [],
      open_questions: [],
    }))}`);
    expect(result.displayText).toBe("report");
    expect(result.conclusion).toBe("done");
    expect(result.hadBlock).toBe(true);
  });

  it("removes every block and uses the last valid conclusion", () => {
    const first = block(JSON.stringify({ conclusion: "first" }));
    const second = block(JSON.stringify({ conclusion: "second" }));
    const result = splitTaskHandoffForDisplay(`a\n\n${first}\n\nmiddle\n\n${second}\n\ntail`);
    expect(result.displayText).toBe("a\n\nmiddle\n\ntail");
    expect(result.conclusion).toBe("second");
  });

  it("hides invalid and incomplete blocks without inventing a conclusion", () => {
    const invalid = block("{not-json");
    expect(splitTaskHandoffForDisplay(`report\n${invalid}`)).toMatchObject({
      displayText: "report",
      conclusion: undefined,
      hadBlock: true,
    });

    const unclosed = "report\n```swarmflow-handoff\n{\"conclusion\":\"partial\"}";
    expect(splitTaskHandoffForDisplay(unclosed)).toMatchObject({
      displayText: "report",
      conclusion: undefined,
      hadBlock: true,
    });
  });

  it("accepts a conclusion-only root block", () => {
    const result = splitTaskHandoffForDisplay(block(JSON.stringify({ conclusion: "root summary" })));
    expect(result.displayText).toBe("");
    expect(result.conclusion).toBe("root summary");
  });

  it("strips BOM and normalizes conclusion whitespace", () => {
    const result = splitTaskHandoffForDisplay(`\uFEFF${block(JSON.stringify({
      conclusion: "line one\n  line two",
    }))}`);
    expect(result.displayText).toBe("");
    expect(result.conclusion).toBe("line one line two");
  });
});

describe("DAG handoff and failure boundaries", () => {
  it("passes only direct structured dependency conclusions to downstream context", () => {
    const dag: TaskDAG = {
      nodes: new Map([
        ["scout", { id: "scout", role: AgentRole.Scout, description: "Explore", dependencies: [], priority: 1 }],
        ["worker", { id: "worker", role: AgentRole.Worker, description: "Implement", dependencies: ["scout"], priority: 1 }],
      ]),
      entryPoints: ["scout"],
    };
    const scoutResult = result("scout", handoff("Scout found the target function."));
    const context = formatDirectDependencyResults(dag.nodes.get("worker")!, dag, new Map([["scout", { ...scoutResult, handoff: {
      conclusion: "Scout found the target function.",
      modifiedFiles: ["src/example.ts"],
      testResults: ["read only"],
      risks: [],
      openQuestions: [],
    } }]]));

    expect(context).toContain("Scout found the target function.");
    expect(context).toContain("Modified files");
    expect(context).not.toContain("## Direct Dependency Results\n##");
  });

  it("blocks downstream tasks after a failed direct dependency", async () => {
    const calls: string[] = [];
    const makeTemplate = (role: string) => ({
      clone: () => ({
        asyncRun: vi.fn(async () => {
          calls.push(role);
          if (role === AgentRole.Scout) throw new Error("scout failed");
          return { text: "unexpected", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        }),
      }),
    });
    const coordinator = new SwarmCoordinator({
      templates: {
        [AgentRole.Scout]: makeTemplate(AgentRole.Scout) as any,
        [AgentRole.Worker]: makeTemplate(AgentRole.Worker) as any,
      },
    });
    const dag: TaskDAG = {
      nodes: new Map([
        ["scout", { id: "scout", role: AgentRole.Scout, description: "Explore", dependencies: [], priority: 1 }],
        ["worker", { id: "worker", role: AgentRole.Worker, description: "Implement", dependencies: ["scout"], priority: 1 }],
      ]),
      entryPoints: ["scout"],
    };

    const execution = await coordinator.executeDag(dag);
    expect(calls).toEqual([AgentRole.Scout]);
    expect(execution.results.get("worker")?.success).toBe(false);
    expect(execution.results.get("worker")?.error).toContain("Blocked by failed dependencies");
  });

  it("selects a successful terminal Merger result", () => {
    const dag: TaskDAG = {
      nodes: new Map([
        ["worker", { id: "worker", role: AgentRole.Worker, description: "Work", dependencies: [], priority: 1 }],
        ["merger", { id: "merger", role: AgentRole.Merger, description: "Merge", dependencies: ["worker"], priority: 1 }],
      ]),
      entryPoints: ["worker"],
    };
    const merger = result("merger", handoff("Merged Worker result."));
    const terminal = getTerminalMergerResults(dag, new Map([
      ["worker", result("worker", "worker output")],
      ["merger", { ...merger, success: true }],
    ]));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.taskId).toBe("merger");
  });
});
