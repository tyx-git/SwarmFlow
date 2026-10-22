/**
 * 任务清单领域：内存为权威，`tasks.json` 为 write-through 持久副本。
 */

import type { Task, TaskResumeHint } from "./types.js";
import { RESUME_MIN_TOKENS_IN, RESUME_MIN_TOOL_CALLS } from "./types.js";
import { asOptionalString } from "./normalize.js";

export function isWorthResuming(toolCalls: number, tokensIn: number): boolean {
  return toolCalls >= RESUME_MIN_TOOL_CALLS || tokensIn >= RESUME_MIN_TOKENS_IN;
}

/** 读取任务上的续跑提示（对账产物）。 */
export function readResumeHint(task: Task): TaskResumeHint | undefined {
  return asResumeHint(task.metadata["resumeHint"]);
}

export function asResumeHint(raw: unknown): TaskResumeHint | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const childId = asOptionalString(record["childId"]);
  if (!childId) return undefined;
  return {
    childId,
    toolCalls: asNonNegativeInt(record["toolCalls"]),
    tokensIn: asNonNegativeInt(record["tokensIn"]),
    resumable: record["resumable"] === true,
    reason: typeof record["reason"] === "string" ? record["reason"] : "",
  };
}

export function asNonNegativeInt(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
