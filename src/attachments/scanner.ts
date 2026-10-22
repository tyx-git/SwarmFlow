/**
 * @file 附件领域：引用解析、扫描、读取摘要与上下文块渲染。
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { toPosixPath } from "../security/path.js";
import { SCAN_EXCLUDE_DIRS } from "./file-kinds.js";

// ------------------------------------------------------------------
// 文件扫描自动完成
// ------------------------------------------------------------------

/**
 * 扫描‘ cwd ’查找匹配‘ prefix ’的文件，
 * 返回相对路径字符串。
 * —空前缀：只列出顶层文件（不递归）。
 * -非空前缀：递归扫描到‘ maxDepth ’，
 * 匹配以前缀开头的路径。—跳过‘ SCAN_EXCLUDE_DIRS ’中的目录。
 * -结果排序的路径长度（最短的第一），上限为‘ maxResults ’。
 */
export function scanCandidates(
  prefix: string,
  cwd?: string,
  maxResults = 20,
  maxDepth = 3,
): string[] {
  const base = cwd ?? process.cwd();
  const matches: string[] = [];

  if (!prefix) {
    // Top-level entries only
    try {
      const entries = readdirSync(base).sort();
      for (const name of entries) {
        if (name.startsWith(".") || SCAN_EXCLUDE_DIRS.has(name)) continue;
        const full = path.join(base, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // skip
        }
        matches.push(name + (isDir ? "/" : ""));
        if (matches.length >= maxResults) break;
      }
    } catch {
      // ignore
    }
    return matches;
  }

  const prefixLower = prefix.toLowerCase();

  function walk(directory: string, depth: number): void {
    if (depth > maxDepth || matches.length >= maxResults) return;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      return;
    }

    for (const name of entries) {
      if (SCAN_EXCLUDE_DIRS.has(name) || name.startsWith(".")) continue;
      const full = path.join(directory, name);
      // 路径。相对返回操作系统本地分隔符（反斜杠）
      //  Windows);用户的@-query和下面使用的目录后缀
      // 正斜杠，因此规范化或嵌套路径完成中断
      // 在Windows上（候选人从不以键入的前缀开始）。
      const rel = toPosixPath(path.relative(base, full));
      const relLower = rel.toLowerCase();

      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        const relDir = rel + "/";
        const relDirLower = relLower + "/";
        if (
          relDirLower.startsWith(prefixLower) ||
          prefixLower.startsWith(relDirLower)
        ) {
          if (relDirLower.startsWith(prefixLower)) {
            matches.push(relDir);
          }
          walk(full, depth + 1);
        }
      } else {
        if (relLower.startsWith(prefixLower)) {
          matches.push(rel);
        }
      }
      if (matches.length >= maxResults) return;
    }
  }

  walk(base, 1);
  matches.sort((a, b) => a.length - b.length);
  return matches.slice(0, maxResults);
}

