/**
 * Shared argument-validation helpers for tool executors.
 *
 * Extracted from Session so that standalone manager classes
 * (BackgroundShellManager, etc.) can validate tool arguments
 * without depending on the Session instance.
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
  // validate-then-repair: only attempt coercion once the as-is value fails the
  // array check. Covers '["a","b"]' JSON strings, {} placeholders, and bare
  // strings 鈥?the recoverable shapes open models emit. See arg-repair.ts.
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
 * Optional path/file argument: like `argOptionalString` but unwraps the
 * degenerate markdown auto-link some models emit into a path field
 * (`"[notes.md](http://notes.md)"` 鈫?`"notes.md"`). Use for path arguments
 * only 鈥?never for free-text fields, which may contain genuine markdown links.
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
