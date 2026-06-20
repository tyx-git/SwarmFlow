/**
 * ResultMerger — 合并来自多个 swarm 智能体的输出。
 *
 * 为不同场景提供不同的合并策略：
 * - Concatenate：简单文本连接（不同文件上的独立工作）
 * - Merge：带冲突检测的智能合并（同一文件，不同部分）
 * - Vote：多个解决方案，选择最佳
 * - Synthesize：从多样化输入中创建连贯的摘要
 * - ResolveConflicts：检测并协调冲突的更改
 *
 * @packageDocumentation
 */

import type { TaskResult, ExecutionResult } from "./types.js";

// ------------------------------------------------------------------
// 合并策略
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
// 合并函数
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
        `⚠️ 检测到冲突：文件 "${file}" 被多个 agent 修改：${[...agents.entries()].map(([a, t]) => `${a} (${t})`).join(", ")}`,
      );
    }
  }

  // 构建输出
  const parts: string[] = [];
  if (conflicts.length > 0) {
    parts.push("## 检测到的冲突\n");
    parts.push(...conflicts);
    parts.push("");
    parts.push("---\n");
  }

  parts.push("## 合并结果\n");
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

  // 返回最佳结果及备选方案摘要
  const best = scored[0]!.result;
  const alternatives = scored.slice(1);

  const parts: string[] = [
    "## 选定的解决方案",
    `**任务：** ${best.taskId}`,
    `**得分：** ${scored[0]!.score}`,
    "",
    best.output,
    "",
  ];

  if (alternatives.length > 0) {
    parts.push("---\n## 考虑的备选方案\n");
    for (const alt of alternatives) {
      parts.push(`- **${alt.result.taskId}** (得分：${alt.score})：${alt.result.output.slice(0, 200)}...`);
    }
  }

  let combined = parts.join("\n");
  if (combined.length > maxLength) {
    combined = combined.slice(0, maxLength) + "\n\n... [truncated]";
  }

  return combined;
}

/**
 * Synthesize：从多样化输入中创建连贯的摘要。
 * 从每个结果中提取关键信息并将其编织在一起。
 */
function mergeSynthesize(results: TaskResult[], maxLength: number): string {
  const parts: string[] = [
    "# 综合摘要\n",
  ];

  for (const r of results) {
    const lines = r.output.split("\n").filter((l) => l.trim());

    // 提取标题行和关键点
    const title = lines.find((l) => l.startsWith("#") || l.startsWith("##") || l.startsWith("###"));
    const keyPoints = lines.filter(
      (l) => l.startsWith("-") || l.startsWith("*") || l.match(/^\d+\./),
    );

    if (title) {
      parts.push(`## 来自 ${r.taskId} (${r.agentId})`);
    } else {
      parts.push(`## ${r.taskId}`);
    }

    parts.push("");

    if (keyPoints.length > 0) {
      parts.push(...keyPoints.slice(0, 10));
      parts.push("");
    }

    // 包含完整输出（裁剪）
    parts.push(r.output.slice(0, 2000));
    parts.push("");
  }

  parts.push("---\n*综合自多个 agent 的输出*");

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
  // 首先，使用冲突检测
  const conflictOutput = mergeWithConflictDetection(results, maxLength);

  // 添加解决指导
  const parts = [
    conflictOutput,
    "",
    "## 冲突解决",
    "",
    "### 自动解决",
    "- 应用了无冲突的更改",
    "- 合并了不同文件/主题的输出",
    "",
    "### 需要用户审查",
    "- 冲突的文件修改需要手动协调",
    "- 请检查上面的“检测到的冲突”部分",
    "",
    "### 建议",
    "- 逐个审查冲突文件",
    "- 每个文件接受或拒绝更改",
    "- 解决冲突后运行测试",
  ];

  return parts.join("\n");
}

// ------------------------------------------------------------------
// 主要合并 API
// ------------------------------------------------------------------

/**
 * 使用指定策略合并多个任务结果。
 *
 * @param results - 要合并的任务结果
 * @param options - 合并选项（策略、格式、最大长度）
 * @returns 合并后的输出字符串
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
    `# Swarm 执行完成`,
    ``,
    `**状态：** ${result.success ? "✅ 所有任务成功" : "⚠️ 部分任务失败"}`,
    `**耗时：** ${(result.totalDurationMs / 1000).toFixed(1)}s`,
    `**Token：** ${result.totalUsage.inputTokens.toLocaleString()} 输入 / ${result.totalUsage.outputTokens.toLocaleString()} 输出`,
    `**任务：** ${result.results.size} 个总计，${result.failedTaskIds.length} 个失败`,
    ``,
  ];

  // 每个任务摘要
  parts.push(`## 任务结果\n`);
  for (const [id, taskResult] of result.results) {
    const icon = taskResult.success ? "✅" : "❌";
    parts.push(`### ${icon} ${id}`);
    parts.push(`Agent：${taskResult.agentId} | 耗时：${(taskResult.durationMs / 1000).toFixed(1)}s | Token：${taskResult.usage.inputTokens + taskResult.usage.outputTokens}`);
    if (taskResult.error) parts.push(`错误：${taskResult.error}`);
    parts.push(``);
  }

  // 摘要文本
  parts.push(`## 摘要\n`);
  parts.push(result.summary);
  parts.push(``);

  return parts.join("\n");
}