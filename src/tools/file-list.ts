/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

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

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

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

    // Stat entries first, then apply directory-only exclusion. A regular
    // file named "build" or "dist" should still be shown —only same-named
    // *directories* are skipped.
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
          // inaccessible
        }
        return { name, full, isDir, size, statOk };
      }),
    ))
      .filter((entry) => {
        // Skip excluded directories only after we confirm it IS a directory.
        // If stat failed but the name matches the exclude list, keep the
        // conservative "skip" behaviour —almost certainly an inaccessible
        // node_modules / target / etc. rather than a regular file.
        const excludedByName = isExcludedDirName(entry.name);
        if (excludedByName && (entry.isDir || !entry.statOk)) {
          skippedDirs += 1;
          return false;
        }
        return true;
      })
      // Sort: directories first, then files, alphabetical
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
      // Already at the cap; raising max_entries won't help.
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
