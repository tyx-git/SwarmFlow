/**
 * AgentHandoff — context transfer between swarm agents.
 *
 * When one agent completes its task and the next agent takes over,
 * the handoff protocol packages the current state (decisions, findings,
 * workspace changes) so the receiving agent can continue seamlessly.
 *
 * @packageDocumentation
 */

import type { HandoffContext, TaskResult } from "./types.js";

/** Options for creating a handoff context. */
export interface HandoffOptions {
  /** Source agent ID. */
  fromAgent: string;
  /** Target agent ID. */
  toAgent: string;
  /** Completed tasks. */
  completedTasks: TaskResult[];
  /** Decisions made so far. */
  decisions?: Array<{ subject: string; decision: string }>;
  /** Key findings. */
  findings?: string[];
  /** Remaining issues. */
  issues?: string[];
  /** Files read during the session. */
  filesRead?: string[];
  /** Pending to-do items. */
  todos?: Array<{ id: string; description: string }>;
}

/**
 * Create a handoff context from completed tasks and options.
 *
 * @param opts - Handoff options
 * @returns A ready-to-send HandoffContext
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
 * Compute workspace snapshot from task results.
 * Scans all task outputs for file modification references.
 */
export function computeWorkspaceSnapshot(tasks: TaskResult[]): HandoffContext["workspaceSnapshot"] {
  const modifiedFiles = new Set<string>();
  const createdFiles = new Set<string>();
  const deletedFiles = new Set<string>();

  for (const task of tasks) {
    if (task.modifiedFiles) {
      for (const f of task.modifiedFiles) {
        modifiedFiles.add(f);
        // Heuristic: "new" or "create" in the task name suggests a new file
        if (/\bnew\b|\bcreate\b/i.test(task.taskId)) {
          createdFiles.add(f);
        }
      }
    }

    // Scan output text for file paths
    const lines = task.output.split("\n");
    for (const line of lines) {
      // Match patterns like "+ new file: path/to/file.ts" or "Created: path"
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
 * Format a handoff context as a prompt fragment for the receiving agent.
 * This is injected into the receiving agent's system prompt or first user message.
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
 * Merge multiple handoff contexts into one (for fan-in scenarios).
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
