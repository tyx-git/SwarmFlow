/** 任务字段的容错解析与载入修复：磁盘记录可能来自旧版本、被手改或写中断。 */

import type { Task } from "./types.js";

// ------------------------------------------------------------------
// 载入修复
// ------------------------------------------------------------------

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function asPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function compareIdStrings(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  return a.localeCompare(b);
}

export function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * 把磁盘记录修成可信形状。
 *
 * 任务文件可能来自旧版本、被手工编辑或写入中断，因此每个字段都要能独立回退，
 * 否则消费者（`task.blockedBy.length` 之类）会在载入后抛错。
 */
export function normalizeTask(raw: unknown): Task | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = asOptionalString(record["id"]);
  const subject = asOptionalString(record["subject"]);
  if (!id || !subject) return undefined;

  const now = Date.now();
  const status = record["status"];
  const normalized: Task = {
    id,
    subject,
    description: typeof record["description"] === "string" ? record["description"] : "",
    status: status === "in_progress" || status === "completed" || status === "pending" ? status : "pending",
    metadata: asPlainObject(record["metadata"]),
    blocks: asStringArray(record["blocks"]),
    blockedBy: asStringArray(record["blockedBy"]),
    createdAt: typeof record["createdAt"] === "number" ? record["createdAt"] : now,
    updatedAt: typeof record["updatedAt"] === "number" ? record["updatedAt"] : now,
  };

  const role = asOptionalString(record["role"]);
  if (role) normalized.role = role;

  const activeForm = asOptionalString(record["activeForm"]);
  if (activeForm) normalized.activeForm = activeForm;
  const owner = asOptionalString(record["owner"]);
  if (owner) normalized.owner = owner;
  return normalized;
}

// ------------------------------------------------------------------
// Store
// ------------------------------------------------------------------

