/**
 * 工具执行器的共享参数验证辅助函数。
 *
 * 从 Session 中提取，以便独立管理类
 *（BackgroundShellManager 等）可以验证工具参数
 * 而不依赖 Session 实例。
 */

import { ToolResult } from "../providers/base.js";
import { coerceStringArray, coercePathString } from "./arg-repair.js";

export function toolArgError(toolName: string, message: string): ToolResult {
  return new ToolResult({ content: `Error: invalid arguments for ${toolName}: ${message}` });
}

export function argOptionalString(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string | undefined | ToolResult {
  const value = args[key];
  if (value == null) return undefined;
  if (typeof value !== "string") {
    return toolArgError(toolName, `'${key}' must be a string.`);
  }
  return value;
}

export function argRequiredString(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean },
): string | ToolResult {
  const value = args[key];
  if (typeof value !== "string") {
    return toolArgError(toolName, `'${key}' must be a string.`);
  }
  if (opts?.nonEmpty && !value.trim()) {
    return toolArgError(toolName, `'${key}' must be a non-empty string.`);
  }
  return value;
}

export function argRequiredStringArray(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): string[] | ToolResult {
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
      return toolArgError(toolName, `'${key}' must be an array of strings.`);
    }
    value = repaired;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      return toolArgError(toolName, `'${key}[${i}]' must be a string.`);
    }
  }
  return value as string[];
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
  const value = argOptionalString(toolName, args, key);
  if (typeof value !== "string") return value;
  return coercePathString(toolName, key, value);
}

export function argOptionalInteger(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined | ToolResult {
  const value = args[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return toolArgError(toolName, `'${key}' must be an integer.`);
  }
  return value;
}
