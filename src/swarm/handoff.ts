/**
 * AgentHandoff — swarm agent 之间的上下文转移。
 *
 * 当一个 agent 完成其任务并由下一个 agent 接管时，
 * 交接协议打包当前状态（决策、发现、
 * 工作区更改），以便接收的 agent 能够无缝继续。
 *
 * @packageDocumentation
 */

import type { HandoffContext, TaskResult } from "./types.js";

/** 创建交接上下文的选项。 */
export interface HandoffOptions {
  /** 源 agent ID。 */
  fromAgent: string;
  /** 目标 agent ID。 */
  toAgent: string;
  /** 已完成的任务。 */
  completedTasks: TaskResult[];
  /** 迄今做出的决策。 */
  decisions?: Array<{ subject: string; decision: string }>;
  /** 关键发现。 */
  findings?: string[];
  /** 剩余问题。 */
  issues?: string[];
  /** 会话期间读取的文件。 */
  filesRead?: string[];
  /** 待办事项。 */
  todos?: Array<{ id: string; description: string }>;
}

/**
 * 从已完成的任务和选项创建交接上下文。
 *
 * @param opts - 交接选项
 * @returns 准备发送的 HandoffContext
 */
export function createHandoffContext(opts: HandoffOptions): HandoffContext {
  return {
    fromAgent: opts.fromAgent,
    toAgent: opts.toAgent,
    completedTasks: opts.completedTasks,
    sharedContext: {
      filesRead: opts.filesRead ?? [],
      decisions: opts.decisions ?? [],
      keyFindings: opts.findings ?? [],
      remainingIssues: opts.issues ?? [],
    },
    pendingTodos: opts.todos ?? [],
    workspaceSnapshot: computeWorkspaceSnapshot(opts.completedTasks),
  };
}

/**
 * 从任务结果计算工作区快照。
 * 扫描所有任务输出以查找文件修改引用。
 */
export function computeWorkspaceSnapshot(tasks: TaskResult[]): HandoffContext["workspaceSnapshot"] {
  const modifiedFiles = new Set<string>();
  const createdFiles = new Set<string>();
  const deletedFiles = new Set<string>();

  for (const task of tasks) {
    if (task.modifiedFiles) {
      for (const f of task.modifiedFiles) {
        modifiedFiles.add(f);
        // 启发式：任务名中的 "new" 或 "create" 表示新文件
        if (/\bnew\b|\bcreate\b/i.test(task.taskId)) {
          createdFiles.add(f);
        }
      }
    }

    // 扫描输出文本中的文件路径
    const lines = task.output.split("\n");
    for (const line of lines) {
      // 匹配类似 "+ new file: path/to/file.ts" 或 "Created: path" 的模式
      const createdMatch = line.match(/created:\s*(\S+)/i);
      if (createdMatch) createdFiles.add(createdMatch[1]!);

      const deletedMatch = line.match(/deleted:\s*(\S+)/i);
      if (deletedMatch) deletedFiles.add(deletedMatch[1]!);

      const modifiedMatch = line.match(/modified:\s*(\S+)/i);
      if (modifiedMatch) modifiedFiles.add(modifiedMatch[1]!);
    }
  }

  return {
    modifiedFiles: [...modifiedFiles],
    createdFiles: [...createdFiles],
    deletedFiles: [...deletedFiles],
  };
}

/**
 * 将交接上下文格式化为接收 agent 的提示片段。
 * 这会被注入接收 agent 的系统提示或第一条用户消息。
 */
export function formatHandoffPrompt(context: HandoffContext): string {
  const parts: string[] = [
    "## Handoff Context",
    "",
    `You are continuing work from **${context.fromAgent}**.`,
    "",
  ];

  if (context.sharedContext.decisions.length > 0) {
    parts.push("### Decisions Made");
    for (const d of context.sharedContext.decisions) {
      parts.push(`- **${d.subject}**: ${d.decision}`);
    }
    parts.push("");
  }

  if (context.sharedContext.keyFindings.length > 0) {
    parts.push("### Key Findings");
    for (const f of context.sharedContext.keyFindings) {
      parts.push(`- ${f}`);
    }
    parts.push("");
  }

  if (context.sharedContext.remainingIssues.length > 0) {
    parts.push("### Remaining Issues");
    for (const issue of context.sharedContext.remainingIssues) {
      parts.push(`- ${issue}`);
    }
    parts.push("");
  }

  if (context.pendingTodos.length > 0) {
    parts.push("### Pending Tasks");
    for (const todo of context.pendingTodos) {
      parts.push(`- [ ] ${todo.description} (${todo.id})`);
    }
    parts.push("");
  }

  const ws = context.workspaceSnapshot;
  if (ws.modifiedFiles.length > 0 || ws.createdFiles.length > 0 || ws.deletedFiles.length > 0) {
    parts.push("### Workspace State");
    if (ws.createdFiles.length > 0) parts.push(`- Created: ${ws.createdFiles.join(", ")}`);
    if (ws.modifiedFiles.length > 0) parts.push(`- Modified: ${ws.modifiedFiles.join(", ")}`);
    if (ws.deletedFiles.length > 0) parts.push(`- Deleted: ${ws.deletedFiles.join(", ")}`);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * 将多个交接上下文合并为一个（用于扇入场景）。
 */
export function mergeHandoffContexts(contexts: HandoffContext[], into: string): HandoffContext {
  const allTasks = contexts.flatMap((c) => c.completedTasks);
  const allDecisions = contexts.flatMap((c) => c.sharedContext.decisions);
  const allFindings = contexts.flatMap((c) => c.sharedContext.keyFindings);
  const allIssues = contexts.flatMap((c) => c.sharedContext.remainingIssues);
  const allTodos = contexts.flatMap((c) => c.pendingTodos);
  const allFilesRead = [...new Set(contexts.flatMap((c) => c.sharedContext.filesRead))];

  return {
    fromAgent: contexts.map((c) => c.fromAgent).join(", "),
    toAgent: into,
    completedTasks: allTasks,
    sharedContext: {
      filesRead: allFilesRead,
      decisions: allDecisions,
      keyFindings: allFindings,
      remainingIssues: allIssues,
    },
    pendingTodos: allTodos,
    workspaceSnapshot: computeWorkspaceSnapshot(allTasks),
  };
}
