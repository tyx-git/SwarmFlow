/**
 * 工具参数校验：单一实现，两种错误通道。
 *
 * 核心校验器抛 `ToolArgValidationError`（供 tools/dispatch.ts 统一格式化）；
 * 底部的 `arg*` 适配器把同一核心的错误转成 `ToolResult`（供 Session 与
 * 后台 shell 等直接返回工具结果的执行器使用）。两者共享同一份判定逻辑
 * 与错误文案。
 */

import { ToolResult } from "../providers/response.js";
import { coercePathString, coerceStringArray } from "./arg-repair.js";

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

export function toolArgError(toolName: string, message: string): ToolResult {
  return new ToolResult({ content: `Error: invalid arguments for ${toolName}: ${message}` });
}

function asToolResult<T>(toolName: string, run: () => T): T | ToolResult {
  try {
    return run();
  } catch (error) {
    if (error instanceof ToolArgValidationError) return toolArgError(toolName, error.message);
    throw error;
  }
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

function optionalStringValue(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  if (v == null) return undefined;
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  return v;
}

export function optionalStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return optionalStringValue(toolName, args, key) ?? fallback;
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

function requiredStringArrayArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string[] {
  const raw = args[key];
  // 验证后修复：只有当原值未通过数组检查时才尝试强制转换。
  // 覆盖 '["a","b"]' JSON 字符串、{} 占位符和裸字符串
  // —— 这些是开放模型产生的可恢复形状。参见 arg-repair.ts。
  let value: unknown[];
  if (Array.isArray(raw)) {
    value = raw;
  } else {
    const repaired = coerceStringArray(toolName, key, raw);
    if (repaired === null) {
      throw new ToolArgValidationError(toolName, key, `'${key}' must be an array of strings.`);
    }
    value = repaired;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new ToolArgValidationError(toolName, key, `'${key}[${i}]' must be a string.`);
    }
  }
  return value as string[];
}

export function argOptionalString(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string | undefined | ToolResult {
  return asToolResult(toolName, () => optionalStringValue(toolName, args, key));
}

export function argRequiredString(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean },
): string | ToolResult {
  return asToolResult(toolName, () => requiredStringArg(toolName, args, key, opts));
}

export function argRequiredStringArray(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string[] | ToolResult {
  return asToolResult(toolName, () => requiredStringArrayArg(toolName, args, key));
}

/**
 * 可选路径/文件参数：类似 `argOptionalString`，但会解包
 * 某些模型发送到路径字段的退化 markdown 自动链接
 *（`"[notes.md](http://notes.md)"` → `"notes.md"`）。仅用于路径参数
 * — 永远不要用于自由文本字段，其中可能包含真正的 markdown 链接。
 */
export function argOptionalPath(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string | undefined | ToolResult {
  return asToolResult(toolName, () => {
    const value = optionalStringValue(toolName, args, key);
    return value === undefined ? undefined : coercePathString(toolName, key, value);
  });
}

export function argOptionalInteger(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined | ToolResult {
  return asToolResult(toolName, () => optionalIntegerArg(toolName, args, key));
}
