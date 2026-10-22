/** 工具调用参数的收口解析与中断流式 JSON 修复。 */

import { type ToolCall } from "./types.js";

export function finalizeToolCall(
  id: string,
  name: string,
  rawArguments: string,
  sourceLabel?: string,
): ToolCall {
  const normalizedRaw = rawArguments || "";
  try {
    return {
      id,
      name,
      rawArguments: normalizedRaw,
      arguments: normalizedRaw ? JSON.parse(normalizedRaw) as Record<string, unknown> : {},
      parseError: null,
    };
  } catch {
    const label = sourceLabel ?? (name || "tool");
    return {
      id,
      name,
      rawArguments: normalizedRaw,
      arguments: {},
      parseError: `Failed to parse ${label} tool arguments as JSON (${normalizedRaw.length} chars).`,
    };
  }
}

/**
 * 从截断的 JSON 对象字符串中恢复完整键值对。
 * 用于流式传输在参数中途被中断时。
 *
 * 策略：
 * 1. 尝试普通 JSON.parse（如果 JSON 实际完整则可用）
 * 2. 尝试追加常见闭合符（"}", ""}" 等）以闭合截断值
 * 3. 在最后一个顶层逗号处截断并用 "}" 闭合
 * 4. 回退到 {}
 */
export function recoverPartialArgs(partial: string): Record<string, unknown> {
  if (!partial) return {};

  // 1. 尝试普通解析
  try {
    const r = JSON.parse(partial);
    if (r && typeof r === "object" && !Array.isArray(r)) return r;
  } catch {}

  // 2. 尝试追加常见闭合符
  for (const closer of ['"}', "}", '"]}'  , "null}"]) {
    try {
      const r = JSON.parse(partial + closer);
      if (r && typeof r === "object" && !Array.isArray(r)) return r;
    } catch {}
  }

  // 3. 在最后一个逗号处截断并闭合
  for (let i = partial.length - 1; i >= 0; i--) {
    if (partial[i] === ",") {
      try {
        const r = JSON.parse(partial.slice(0, i) + "}");
        if (r && typeof r === "object" && !Array.isArray(r)) return r;
      } catch {}
    }
  }

  return {};
}

// ------------------------------------------------------------------
// 抽象基础提供者
// ------------------------------------------------------------------
