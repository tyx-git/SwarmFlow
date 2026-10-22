/**
 * @file 附件领域：引用解析、扫描、读取摘要与上下文块渲染。
 */

import path from "node:path";
import { AT_PATTERN } from "./file-kinds.js";

// ------------------------------------------------------------------
// Core functions
// ------------------------------------------------------------------

/**
 * 提取@path引用并返回[cleanedText， paths]。
 * 不匹配类似电子邮件的模式（user@example.com），
 * 因为regex要求@前面有空格或行开始。
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

/**
 *  将原始路径字符串解析为绝对路径。
 */
export function resolvePath(raw: string, cwd?: string): string {
  if (path.isAbsolute(raw)) return raw;
  const base = cwd ?? process.cwd();
  return path.resolve(base, raw);
}

/**
 * 按扩展名对文件进行分类。
 * 返回‘ [isImage, isBinary, projectedDocumentType] ’。
 */
