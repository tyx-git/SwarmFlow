/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

import fs from "node:fs/promises";

import path from "node:path";

import { coercePathString } from "./arg-repair.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

export class ToolArgValidationError extends Error {
  toolName: string;
  field: string;

  constructor(toolName: string, field: string, message: string) {
    super(message);
    this.name = "ToolArgValidationError";
    this.toolName = toolName;
    this.field = field;
  }
}

export function expectArgsObject(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolArgValidationError(toolName, "(root)", "arguments must be an object.");
  }
  return args;
}

export function requiredStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean; maxLen?: number },
): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  if (opts?.nonEmpty && !v.trim()) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a non-empty string.`);
  }
  if (opts?.maxLen !== undefined && v.length > opts.maxLen) {
    throw new ToolArgValidationError(
      toolName,
      key,
      `'${key}' exceeds max length (${opts.maxLen}).`,
    );
  }
  return v;
}

export function optionalStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = args[key];
  if (v == null) return fallback;
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  return v;
}

/**
 * 类似 `requiredStringArg`，但用于文件系统路径：在类型检查之后，
 * 解包一些模型发送到路径字段的退化 markdown 自动链接
 *（`"[notes.md](http://notes.md)"` → `"notes.md"`）。只触碰退化情况；
 * 真正的链接留给路径验证器拒绝。只能应用于 path/file 参数
 * — 永远不要用于 `content`，它可能合法地包含 markdown 链接。
 */
export function requiredPathArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean; maxLen?: number },
): string {
  return coercePathString(toolName, key, requiredStringArg(toolName, args, key, opts));
}

/** `requiredPathArg` 的可选路径变体（见其文档）。 */
export function optionalPathArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = optionalStringArg(toolName, args, key, fallback);
  return v === fallback ? v : coercePathString(toolName, key, v);
}

export function optionalIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be an integer.`);
  }
  return v;
}

/**
 * 类似 `optionalIntegerArg`，但用清晰的错误拒绝 < 1 的值，
 * 而不是静默地限制。用于任何 "limit / size / count" 参数，
 * 其中 0 或负数是无意义的 — 否则模型会得到令人惊讶的
 * 默认回退行为（例如 `limit: 0` 返回默认值 200）。
 */
export function optionalPositiveIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = optionalIntegerArg(toolName, args, key);
  if (v === undefined) return undefined;
  if (v < 1) {
    throw new ToolArgValidationError(
      toolName,
      key,
      `'${key}' must be >= 1 (got ${v}).`,
    );
  }
  return v;
}

export function requiredIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number {
  const v = args[key];
  if (v == null) {
    throw new ToolArgValidationError(toolName, key, `'${key}' is required.`);
  }
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be an integer.`);
  }
  return v;
}

export function requiredStringList(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string[] {
  const value = args[key];
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.filter((item): item is string => item.trim().length > 0);
  }
  throw new ToolArgValidationError(toolName, key, `'${key}' must be a string or an array of strings.`);
}
