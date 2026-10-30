/** @ 引用补全候选扫描：按前缀递归匹配文件，跳过隐藏与排除目录。 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { toPosixPath } from "../security/path.js";
import { SCAN_EXCLUDE_DIRS } from "./file-kinds.js";

// ------------------------------------------------------------------
// 文件扫描自动完成
// ------------------------------------------------------------------

/**
 * 扫描 `cwd` 下以 `prefix` 开头的文件，返回相对路径。
 *
 * 空前缀只列顶层条目；非空前缀递归到 `maxDepth`，跳过
 * `SCAN_EXCLUDE_DIRS` 中的目录。结果按路径长度升序，最多 `maxResults` 条。
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
    // 只列顶层条目
    try {
      const entries = readdirSync(base).sort();
      for (const name of entries) {
        if (name.startsWith(".") || SCAN_EXCLUDE_DIRS.has(name)) continue;
        const full = path.join(base, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // 跳过
        }
        matches.push(name + (isDir ? "/" : ""));
        if (matches.length >= maxResults) break;
      }
    } catch {
      // 忽略
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
      // path.relative 在 Windows 上返回反斜杠，而 @ 查询和目录补全
      // 使用正斜杠；不规范化会让 Windows 上的嵌套路径补全
      // 永远匹配不到用户输入的前缀。
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

