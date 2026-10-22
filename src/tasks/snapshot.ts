/**
 * 任务清单领域：内存为权威，`tasks.json` 为 write-through 持久副本。
 */

import { join } from "node:path";
import type { Task } from "./types.js";
import { readResumeHint } from "./resume.js";

// ------------------------------------------------------------------
// 压缩快照
// ------------------------------------------------------------------

/** 快照里最多保留多少条已完成任务（清单可能很长，但压缩上下文要省 token）。 */
export const TASK_SNAPSHOT_MAX_COMPLETED = 5;

/**
 * 把任务清单渲染成压缩上下文用的快照。
 *
 * 压缩会用一条 continuation prompt 替换旧对话，而任务清单在磁盘上、不在消息里；
 * 这条快照在压缩点重新注入，保证新实例仍能看到当前任务。
 * 限量：全部未完成项 + 最近完成的若干条。
 */
export function formatTaskSnapshot(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "";
  const open = tasks.filter((task) => task.status !== "completed");
  const completed = tasks.filter((task) => task.status === "completed");
  const shown = completed.slice(-TASK_SNAPSHOT_MAX_COMPLETED);

  const lines: string[] = [];
  for (const task of [...open, ...shown]) {
    let line = `- #${task.id} [${task.status}] ${task.subject}`;
    const agentId = typeof task.metadata["agentId"] === "string" ? (task.metadata["agentId"] as string) : undefined;
    if (agentId) line += ` (owner: ${agentId})`;
    const edges: string[] = [];
    if (task.blockedBy.length > 0) {
      edges.push(`blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
    }
    if (task.blocks.length > 0) {
      edges.push(`blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
    }
    if (edges.length > 0) line += ` (${edges.join("; ")})`;
    const hint = readResumeHint(task);
    if (hint && task.status !== "completed") {
      line += hint.resumable ? " (interrupted — resumable via task_resume)" : " (interrupted — needs re-dispatch)";
    }
    const childOpenTasks = task.metadata["childOpenTasks"];
    if (Array.isArray(childOpenTasks) && childOpenTasks.length > 0) {
      line += ` (${childOpenTasks.length} unfinished child-local tasks returned; inspect task_get)`;
    }
    lines.push(line);
  }

  const hidden = completed.length - shown.length;
  if (hidden > 0) lines.push(`- … and ${hidden} earlier completed task(s)`);
  return `[Current Tasks]\n${lines.join("\n")}`;
}
// ------------------------------------------------------------------
// 辅助
// ------------------------------------------------------------------

export function compareById(a: Task, b: Task): number {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.id.localeCompare(b.id);
}

/** 依赖边告警：自依赖 / 目标不存在 / 互相阻塞成环。 */
export function edgeWarning(
  id: string,
  targetId: string,
  target: Task | undefined,
  mutual: boolean,
): string | undefined {
  if (targetId === id) return `#${id} blocks itself`;
  if (!target) return `#${targetId} does not exist`;
  if (mutual) return `cycle: #${id} and #${targetId} block each other`;
  return undefined;
}

