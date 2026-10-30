/** list_dir 执行器：列出目录条目并标注类型与文件大小。 */

import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

import path from "node:path";

import { isExcludedDirName, isHiddenName } from "./scan-exclusions.js";

import {
  LIST_MAX_DEPTH_DEFAULT,
  LIST_MAX_DEPTH_CAP,
  LIST_MAX_ENTRIES_DEFAULT,
  LIST_MAX_ENTRIES_CAP,
} from "./limits.js";

export interface ListDirOptions {
  maxDepth: number;
  maxEntries: number;
  includeHidden: boolean;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function toolListDir(dirPath = ".", opts?: Partial<ListDirOptions>): Promise<string> {
  const options: ListDirOptions = {
    maxDepth: Math.min(Math.max(opts?.maxDepth ?? LIST_MAX_DEPTH_DEFAULT, 1), LIST_MAX_DEPTH_CAP),
    maxEntries: Math.min(Math.max(opts?.maxEntries ?? LIST_MAX_ENTRIES_DEFAULT, 1), LIST_MAX_ENTRIES_CAP),
    includeHidden: opts?.includeHidden ?? false,
  };

  if (!existsSync(dirPath)) {
    return `ERROR: Directory not found: ${dirPath}`;
  }
  const stat = statSync(dirPath);
  if (!stat.isDirectory()) {
    return `ERROR: Not a directory: ${dirPath}`;
  }

  const lines: string[] = [];
  let truncated = false;
  let skippedDirs = 0;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > options.maxDepth) return;
    if (lines.length >= options.maxEntries) { truncated = true; return; }

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    // 先 stat 再套「仅目录」排除。名为 "build" / "dist" 的普通文件
    // 仍应列出——只跳过同名的目录。
    const candidates: string[] = [];
    for (const name of entries) {
      if (!options.includeHidden && isHiddenName(name)) continue;
      candidates.push(name);
    }

    const withStats = (await Promise.all(
      candidates.map(async (name) => {
        const full = path.join(dir, name);
        let isDir = false;
        let size = 0;
        let statOk = false;
        try {
          const st = await fs.stat(full);
          isDir = st.isDirectory();
          size = st.size;
          statOk = true;
        } catch {
          // 无法访问
        }
        return { name, full, isDir, size, statOk };
      }),
    ))
      .filter((entry) => {
        // 确认确实是目录之后，才跳过被排除的目录。若 stat 失败但名字在
        // 排除表里，仍保守地跳过——那几乎肯定是访问不到的
        // node_modules / target 之类，而不是普通文件。
        const excludedByName = isExcludedDirName(entry.name);
        if (excludedByName && (entry.isDir || !entry.statOk)) {
          skippedDirs += 1;
          return false;
        }
        return true;
      })
      // 排序：目录在前，文件在后，各自按字母序
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of withStats) {
      if (lines.length >= options.maxEntries) { truncated = true; return; }
      if (entry.isDir) {
        lines.push(`${prefix}${entry.name}/`);
        await walk(entry.full, prefix + "  ", depth + 1);
      } else {
        lines.push(`${prefix}${entry.name}  [${formatFileSize(entry.size)}]`);
      }
    }
  }

  await walk(dirPath, "", 0);

  if (lines.length === 0) {
    return skippedDirs > 0
      ? `(empty after skipping ${skippedDirs} excluded director${skippedDirs === 1 ? "y" : "ies"})`
      : "(empty directory)";
  }

  let output = lines.join("\n");
  const notices: string[] = [];
  if (truncated) {
    const suggestion = Math.min(options.maxEntries * 4, LIST_MAX_ENTRIES_CAP);
    if (suggestion > options.maxEntries) {
      notices.push(`Output truncated at ${options.maxEntries} entries —pass max_entries=${suggestion} or narrow the path.`);
    } else {
      // 已到硬上限，再调大 max_entries 也没用。
      notices.push(`Output truncated at ${options.maxEntries} entries (cap reached) —narrow the path or use glob/grep instead.`);
    }
  }
  if (skippedDirs > 0) {
    notices.push(`Skipped ${skippedDirs} excluded director${skippedDirs === 1 ? "y" : "ies"} (node_modules, .git, dist, etc.).`);
  }
  if (notices.length > 0) {
    output += "\n\n" + notices.map((n) => `[${n}]`).join("\n");
  }
  return output;
}
