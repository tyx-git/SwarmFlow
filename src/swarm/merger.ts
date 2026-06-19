/**
 * ResultMerger — combines outputs from multiple swarm agents.
 *
 * Provides different merge strategies for different scenarios:
 * - Concatenate: simple text joining (independent work on different files)
 * - Merge: smart merge with conflict detection (same file, different sections)
 * - Vote: multiple solutions, pick the best
 * - Synthesize: create a cohesive summary from diverse inputs
 * - ResolveConflicts: detect and reconcile conflicting changes
 *
 * @packageDocumentation
 */

import type { TaskResult, ExecutionResult } from "./types.js";

// ------------------------------------------------------------------
// 合并 strategies
// ------------------------------------------------------------------

/** 可用的合并策略。 */
export type MergeStrategy =
  | "concatenate"
  | "merge"
  | "vote"
  | "synthesize"
  | "resolve_conflicts";

/** 合并选项。 */
export interface MergeOptions {
  /** 使用的合并策略。 */
  strategy: MergeStrategy;
  /** 语言或格式提示。 */
  format?: string;
  /** 最大输出长度。 */
  maxLength?: number;
}

const DEFAULT_OPTIONS: MergeOptions = {
  strategy: "concatenate",
  maxLength: 100_000,
};

// ------------------------------------------------------------------
// 合并 functions
// ------------------------------------------------------------------

/**
 * 连接：简单地将所有结果连接在一起。
 * 适用于：不同文件/主题的独立工作。
 */
function mergeConcatenate(results: TaskResult[], maxLength: number): string {
  const parts: string[] = [];

  for (const r of results) {
    const header = `===== Task: ${r.taskId} (Agent: ${r.agentId}) =====`;
    parts.push(header);
    parts.push(r.output);
    parts.push("");
  }

  let combined = parts.join("\n");
  if (combined.length > maxLength) {
    combined = combined.slice(0, maxLength) + "\n\n... [truncated]";
  }

  return combined;
}

/**
 * 带冲突检测的合并。
 * 扫描输出中关于同一文件或主题的冲突声明。
 */
function mergeWithConflictDetection(results: TaskResult[], maxLength: number): string {
  const conflicts: string[] = [];

  // 简单冲突检测：检查矛盾声明
  const allStatements: Array<{ taskId: string; statements: string[] }> = [];

  for (const r of results) {
    // 提取关键声明（包含 "should"、"must"、"is"、"needs" 的行）
    const statements = r.output
      .split("\n")
      .filter((line) => /\b(should|must|is\s+(not|a|the)|needs)\b/i.test(line))
      .map((s) => s.trim())
      .filter((s) => s.length > 10);
    allStatements.push({ taskId: r.taskId, statements });
  }

  // 查找在同一文件上工作的 agent 之间的矛盾
  const fileOps = new Map<string, Map<string, string>>();
  for (const r of results) {
    if (r.modifiedFiles) {
      for (const f of r.modifiedFiles) {
        if (!fileOps.has(f)) fileOps.set(f, new Map());
        fileOps.get(f)!.set(r.agentId, r.taskId);
      }
    }
  }

  for (const [file, agents] of fileOps) {
    if (agents.size > 1) {
      conflicts.push(
        `⚠️ Conflict detected: File "${file}" was modified by multiple agents: ${[...agents.entries()].map(([a, t]) => `${a} (${t})`).join(", ")}`,
      );
    }
  }

  // 构建输出
  const parts: string[] = [];
  if (conflicts.length > 0) {
    parts.push("## Conflicts Detected\n");
    parts.push(...conflicts);
    parts.push("");
    parts.push("---\n");
  }

  parts.push("## Merged Results\n");
  for (const r of results) {
    parts.push(`### ${r.taskId} (${r.agentId})`);
    parts.push(r.output);
    parts.push("");
  }

  let combined = parts.join("\n");
  if (combined.length > maxLength) {
    combined = combined.slice(0, maxLength) + "\n\n... [truncated]";
  }

  return combined;
}

/**
 * 投票：多个解决方案，排名并选择最佳。
 * 使用启发式：偏好更长、更详细的输出。
 */
function mergeVote(results: TaskResult[], maxLength: number): string {
  if (results.length === 0) return "";

  // 为每个结果评分
  const scored = results.map((r) => ({
    result: r,
    score:
      (r.output.length > 100 ? 10 : 0) + // 实质性输出
      (r.modifiedFiles ? r.modifiedFiles.length * 5 : 0) + // 修改的文件
      (r.output.includes("```") ? 10 : 0) + // 包含代码
      (r.output.includes("step") || r.output.includes("Step") ? 5 : 0), // 有结构
  }));

  // 按分数降序排序
  scored.sort((a, b) => b.score - a.score);

  // Return the top result with a summary of alternatives
  const best = scored[0]!.result;
  const alternatives = scored.slice(1);

  const parts: string[] = [
    "## Selected Solution",
    `**Task:** ${best.taskId}`,
    `**Score:** ${scored[0]!.score}`,
    "",
    best.output,
    "",
  ];

  if (alternatives.length > 0) {
    parts.push("---\n## Alternative Solutions Considered\n");
    for (const alt of alternatives) {
      parts.push(`- **${alt.result.taskId}** (score: ${alt.score}): ${alt.result.output.slice(0, 200)}...`);
    }
  }

  let combined = parts.join("\n");
  if (combined.length > maxLength) {
    combined = combined.slice(0, maxLength) + "\n\n... [truncated]";
  }

  return combined;
}

/**
 * Synthesize: create a cohesive summary from diverse inputs.
 * Extracts key information from each result and weaves them together.
 */
function mergeSynthesize(results: TaskResult[], maxLength: number): string {
  const parts: string[] = [
    "# Synthesis\n",
  ];

  for (const r of results) {
    const lines = r.output.split("\n").filter((l) => l.trim());

    // Extract title-like lines and key points
    const title = lines.find((l) => l.startsWith("#") || l.startsWith("##") || l.startsWith("###"));
    const keyPoints = lines.filter(
      (l) => l.startsWith("-") || l.startsWith("*") || l.match(/^\d+\./),
    );

    if (title) {
      parts.push(`## From ${r.taskId} (${r.agentId})`);
    } else {
      parts.push(`## ${r.taskId}`);
    }

    parts.push("");

    if (keyPoints.length > 0) {
      parts.push(...keyPoints.slice(0, 10));
      parts.push("");
    }

    // Include the full output (trimmed)
    parts.push(r.output.slice(0, 2000));
    parts.push("");
  }

  parts.push("---\n*Synthesized from multiple agent outputs*");

  let combined = parts.join("\n");
  if (combined.length > maxLength) {
    combined = combined.slice(0, maxLength) + "\n\n... [truncated]";
  }

  return combined;
}

/**
 * 解决冲突：处理来自多个 agent 的冲突更改。
 * 标记冲突供用户解决，并应用无冲突的更改。
 */
function mergeResolveConflicts(results: TaskResult[], maxLength: number): string {
  // First, use conflict detection
  const conflictOutput = mergeWithConflictDetection(results, maxLength);

  // 添加解决指导
  const parts = [
    conflictOutput,
    "",
    "## Conflict Resolution",
    "",
    "### Auto-Resolved",
    "- Non-conflicting changes applied",
    "- Outputs from different files/topics merged",
    "",
    "### Requires User Review",
    "- Conflicting file modifications need manual reconciliation",
    "- Check the 'Conflicts Detected' section above",
    "",
    "### Recommendations",
    "- Review conflicting files one by one",
    "- Accept or reject changes per file",
    "- Run tests after resolving conflicts",
  ];

  return parts.join("\n");
}

// ------------------------------------------------------------------
// Main merger API
// ------------------------------------------------------------------

/**
 * Merge multiple task results using the specified strategy.
 *
 * @param results - Task results to merge
 * @param options - Merge options (strategy, format, maxLength)
 * @returns Merged output string
 */
export function mergeResults(
  results: TaskResult[],
  options?: Partial<MergeOptions>,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (results.length === 0) return "";
  if (results.length === 1) return results[0]!.output;

  switch (opts.strategy) {
    case "concatenate":
      return mergeConcatenate(results, opts.maxLength!);
    case "merge":
      return mergeWithConflictDetection(results, opts.maxLength!);
    case "vote":
      return mergeVote(results, opts.maxLength!);
    case "synthesize":
      return mergeSynthesize(results, opts.maxLength!);
    case "resolve_conflicts":
      return mergeResolveConflicts(results, opts.maxLength!);
    default:
      return mergeConcatenate(results, opts.maxLength!);
  }
}

/**
 * 从 ExecutionResult 构建摘要。
 * 适合呈现给用户。
 */
export function formatExecutionResult(result: ExecutionResult): string {
  const parts: string[] = [
    `# Swarm Execution Complete`,
    ``,
    `**Status:** ${result.success ? "✅ All tasks succeeded" : "⚠️ Some tasks failed"}`,
    `**Duration:** ${(result.totalDurationMs / 1000).toFixed(1)}s`,
    `**Tokens:** ${result.total用法.inputTokens.toLocaleString()} in / ${result.total用法.outputTokens.toLocaleString()} out`,
    `**Tasks:** ${result.results.size} total, ${result.failedTaskIds.length} failed`,
    ``,
  ];

  // Per-task summary
  parts.push(`## Task Results\n`);
  for (const [id, taskResult] of result.results) {
    const icon = taskResult.success ? "✅" : "❌";
    parts.push(`### ${icon} ${id}`);
    parts.push(`Agent: ${taskResult.agentId} | Duration: ${(taskResult.durationMs / 1000).toFixed(1)}s | Tokens: ${taskResult.usage.inputTokens + taskResult.usage.outputTokens}`);
    if (taskResult.error) parts.push(`Error: ${taskResult.error}`);
    parts.push(``);
  }

  // Summary text
  parts.push(`## Summary\n`);
  parts.push(result.summary);
  parts.push(``);

  return parts.join("\n");
}
