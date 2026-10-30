/** 从用户输入中提取 @ 引用，并解析为可读取的绝对路径。 */

import path from "node:path";
import { AT_PATTERN } from "./file-kinds.js";

// ------------------------------------------------------------------
// 核心函数
// ------------------------------------------------------------------

/**
 * 提取 @path 引用，返回清理后的文本与路径列表。
 * 正则要求 @ 位于行首或空白之后，因此不会匹配 user@example.com。
 */
export function parseReferences(text: string): [string, string[]] {
  const paths: string[] = [];

  const cleaned = text.replace(AT_PATTERN, (_, g1, g2, g3) => {
    const raw = g1 ?? g2 ?? g3;
    paths.push(raw);
    return "";
  });

  // 折叠被删除的引用留下的空白
  const normalized = cleaned.replace(/ {2,}/g, " ").trim();
  return [normalized, paths];
}

/** 把原始路径解析为绝对路径。 */
export function resolvePath(raw: string, cwd?: string): string {
  if (path.isAbsolute(raw)) return raw;
  const base = cwd ?? process.cwd();
  return path.resolve(base, raw);
}
