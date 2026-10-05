import { AgentRole, getAgentRoleLabel } from "./types.js";
import type { TaskDAG, TaskHandoff, TaskNode, TaskResult } from "./types.js";

const HANDOFF_BLOCK_PATTERN = /```swarmflow-handoff\s*\r?\n([\s\S]*?)\r?\n```/gi;
const HANDOFF_ARRAY_FIELDS = ["modified_files", "test_results", "risks", "open_questions"] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseHandoffPayload(value: unknown): TaskHandoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (typeof payload["conclusion"] !== "string" || !payload["conclusion"].trim()) return undefined;
  if (!HANDOFF_ARRAY_FIELDS.every((field) => isStringArray(payload[field]))) return undefined;

  return {
    conclusion: payload["conclusion"],
    modifiedFiles: payload["modified_files"] as string[],
    testResults: payload["test_results"] as string[],
    risks: payload["risks"] as string[],
    openQuestions: payload["open_questions"] as string[],
  };
}

/** 解析回复中最后一个有效的结构化交接区块。 */
export function parseTaskHandoff(output: string): TaskHandoff | undefined {
  const matches = output.matchAll(HANDOFF_BLOCK_PATTERN);
  let parsed: TaskHandoff | undefined;
  for (const match of matches) {
    try {
      parsed = parseHandoffPayload(JSON.parse(match[1]!)) ?? parsed;
    } catch {
      // 后续区块可能有效，因此继续检查。
    }
  }
  return parsed;
}

/** 向用户显示 Merger 输出时移除机器交接区块。 */
export function stripTaskHandoffBlock(output: string): string {
  return output.replace(HANDOFF_BLOCK_PATTERN, "").trim();
}

function appendList(parts: string[], label: string, values: readonly string[]): void {
  parts.push(`- ${label}:`);
  if (values.length === 0) {
    parts.push("  - None reported");
    return;
  }
  for (const value of values) parts.push(`  - ${value}`);
}

/** 只格式化当前节点的直接依赖，注入其任务提示。 */
export function formatDirectDependencyResults(
  node: TaskNode,
  dag: TaskDAG,
  results: ReadonlyMap<string, TaskResult>,
): string {
  if (node.dependencies.length === 0) return "";

  const parts = [
    "## Direct Dependency Results",
    "Use these direct dependency results as evidence. Do not assume work or validation that is not reported here.",
    "",
  ];

  for (const dependencyId of node.dependencies) {
    const dependency = dag.nodes.get(dependencyId);
    const result = results.get(dependencyId);
    const role = dependency ? getAgentRoleLabel(dependency.role) : "Unknown role";
    parts.push(`### ${role} · ${dependencyId}`);

    if (!result) {
      parts.push("Status: not run or result unavailable.");
      parts.push("Do not treat this dependency as completed.");
      parts.push("");
      continue;
    }

    parts.push(`Status: ${result.success ? "completed" : "failed"}.`);
    if (result.error) parts.push(`Error: ${result.error}`);

    if (result.handoff) {
      parts.push(`- Conclusion: ${result.handoff.conclusion}`);
      appendList(parts, "Modified files", result.handoff.modifiedFiles);
      appendList(parts, "Test results", result.handoff.testResults);
      appendList(parts, "Risks", result.handoff.risks);
      appendList(parts, "Open questions", result.handoff.openQuestions);
    } else {
      parts.push("No valid structured handoff was found. Preserve the source text below and do not invent structured facts.");
      parts.push("Original output:");
      parts.push(...(result.output ? result.output.split("\n").map((line) => `    ${line}`) : ["    (empty)"]));
    }
    parts.push("");
  }

  return parts.join("\n").trim();
}

/** 按 DAG 顺序查找成功完成且没有下游节点的 Merger。 */
export function getTerminalMergerResults(
  dag: TaskDAG,
  results: ReadonlyMap<string, TaskResult>,
): TaskResult[] {
  const hasDownstream = new Set<string>();
  for (const node of dag.nodes.values()) {
    for (const dependency of node.dependencies) hasDownstream.add(dependency);
  }

  const terminalMergers: TaskResult[] = [];
  for (const node of dag.nodes.values()) {
    if (node.role !== AgentRole.Merger || hasDownstream.has(node.id)) continue;
    const result = results.get(node.id);
    if (result?.success && result.output.trim()) terminalMergers.push(result);
  }
  return terminalMergers;
}
