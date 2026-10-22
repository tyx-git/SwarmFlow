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

import { runBundledFd } from "./native-search.js";
import { GitIgnoreStack } from "./gitignore.js";

import { GLOB_MAX_LIMIT, GLOB_MAX_FILES_SCANNED, GLOB_MAX_DEPTH } from "./limits.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: `*` (any non-slash), `**` (any including slash), `?` (single char),
 * `{a,b}` (alternatives), and literal characters.
 */
export function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches anything including slashes
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?"; // **/ matches zero or more directories
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(",").map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${alts})`;
        i = close + 1;
      } else {
        re += "\\{";
        i++;
      }
    } else if (".+^$|()[]\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

/**
 * 自动为不包含斜杠的模式预加 `**\/`，以便 `*.ts`
 * 匹配树中任何位置的（匹配 Cursor 的 glob_file_search
 * 行为 — 模型通常表达的"按扩展名搜索"）。
 */
export function normalizeGlobPattern(pattern: string): string {
  if (pattern.includes("/")) return pattern;
  // Already covers anywhere via `**` prefix? Leave alone.
  if (pattern.startsWith("**")) return pattern;
  return "**/" + pattern;
}

export interface GlobOptions {
  limit: number;
  /** 测试注入：false 时强制 JS 回退；生产默认走随包二进制。 */
  useNative?: boolean;
  /** .gitignore 规则的根目录（通常是 projectRoot）。 */
  ignoreRoot?: string;
  andPatterns?: string[];
  excludes?: string[];
  type?: string[];
  extensions?: string[];
  regex?: boolean;
  fixedStrings?: boolean;
  caseInsensitive?: boolean;
  fullPath?: boolean;
  absolutePath?: boolean;
  includeHidden?: boolean;
  noIgnore?: boolean;
  follow?: boolean;
  maxDepth?: number;
  minDepth?: number;
  exactDepth?: number;
  signal?: AbortSignal;
}

export function matchesGlobEntry(
  pattern: string,
  relativePath: string,
  entryName: string,
  options: GlobOptions,
): boolean {
  const candidate = options.fullPath || pattern.includes("/") ? relativePath : entryName;
  const normalized = options.fullPath || pattern.includes("/") ? normalizeGlobPattern(pattern) : pattern;
  const caseInsensitive = options.caseInsensitive ?? pattern === pattern.toLocaleLowerCase();
  let matched: boolean;
  if (options.fixedStrings) {
    const haystack = caseInsensitive ? candidate.toLocaleLowerCase() : candidate;
    const needle = caseInsensitive ? pattern.toLocaleLowerCase() : pattern;
    matched = haystack.includes(needle);
  } else if (options.regex) {
    try {
      matched = new RegExp(pattern, caseInsensitive ? "i" : undefined).test(candidate);
    } catch {
      matched = false;
    }
  } else {
    const regex = globToRegex(caseInsensitive ? normalized.toLocaleLowerCase() : normalized);
    matched = regex.test(caseInsensitive ? candidate.toLocaleLowerCase() : candidate);
  }
  if (!matched) return false;
  if (options.extensions && options.extensions.length > 0) {
    const ext = path.extname(entryName).slice(1).toLocaleLowerCase();
    if (!options.extensions.some((item) => item.replace(/^\./, "").toLocaleLowerCase() === ext)) return false;
  }
  return true;
}

export function matchesGlobExclusion(
  relativePath: string,
  entryName: string,
  excludes: readonly string[] | undefined,
): boolean {
  if (!excludes || excludes.length === 0) return false;
  return excludes.some((exclude) => {
    const pattern = exclude.replace(/^!/, "");
    const regex = globToRegex(pattern.includes("/") ? pattern : `**/${pattern}`);
    return regex.test(relativePath) || regex.test(entryName);
  });
}

export function matchesGlobType(
  stat: import("node:fs").Stats,
  types: string[] | undefined,
  emptyDirectory = false,
): boolean {
  if (!types || types.length === 0) return stat.isFile();
  return types.some((raw) => {
    const type = raw.toLocaleLowerCase();
    if (type === "file" || type === "f") return stat.isFile();
    if (type === "directory" || type === "dir" || type === "d") return stat.isDirectory();
    if (type === "symlink" || type === "l") return stat.isSymbolicLink();
    if (type === "empty") return stat.isFile() ? stat.size === 0 : stat.isDirectory() && emptyDirectory;
    if (type === "executable" || type === "x") return stat.isFile() && (stat.mode & 0o111) !== 0;
    return false;
  });
}

export function bundledFdArgs(options: GlobOptions): string[] {
  const args: string[] = [];
  if (!options.regex) args.push("--glob");
  if (options.fixedStrings) args.push("--fixed-strings");
  if (options.caseInsensitive === true) args.push("--ignore-case");
  if (options.caseInsensitive === false) args.push("--case-sensitive");
  if (options.includeHidden) args.push("--hidden");
  if (options.noIgnore) args.push("--no-ignore");
  // 没有 .git 目录时也要读取 .gitignore；与 JS 回退语义保持一致。
  else args.push("--no-require-git");
  if (options.follow) args.push("--follow");
  if (options.fullPath) args.push("--full-path");
  if (options.type && options.type.length > 0) {
    for (const type of options.type) args.push("--type", type);
  } else {
    args.push("--type", "file");
  }
  for (const extension of options.extensions ?? []) args.push("--extension", extension.replace(/^\./, ""));
  for (const extra of options.andPatterns ?? []) args.push("--and", extra);
  for (const exclude of options.excludes ?? []) args.push("--exclude", exclude);
  if (options.maxDepth !== undefined) args.push("--max-depth", String(options.maxDepth));
  if (options.minDepth !== undefined) args.push("--min-depth", String(options.minDepth));
  if (options.exactDepth !== undefined) args.push("--exact-depth", String(options.exactDepth));
  return args;
}

export function normalizeNativeFdOutput(
  content: string,
  searchPath: string,
  options: GlobOptions,
): string {
  if (!content || content.startsWith("ERROR:")) return content;
  // fd 在 Windows 输出反斜杠路径；契约要求 glob 输出统一正斜杠，
  // 与 JS 回退（absolute 分支的 full.replace）保持输出等价。
  const rawLines = content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, "/"));
  // runSearch 的超时/截断/取消提示不是文件路径；单独保留，避免被当成匹配项。
  const notices = rawLines.filter((line) => /^\[(?:Output truncated|Search stopped|Search cancelled)/.test(line));
  const lines = rawLines.filter((line) => !notices.includes(line));
  const filtered = options.noIgnore
    ? lines
    : lines.filter((entry) => {
      const absolute = path.isAbsolute(entry) ? entry : path.resolve(searchPath, entry);
      const relative = path.relative(searchPath, absolute);
      const parts = relative.split(/[\\/]+/).filter(Boolean);
      return !parts.slice(0, -1).some((part) => isExcludedDirName(part));
    });
  // 与工具描述和 JS 回退一致：按 mtime 新到旧；fd 本身不排序。
  const sorted = filtered
    .map((entry) => {
      const absolute = path.isAbsolute(entry) ? entry : path.resolve(searchPath, entry);
      let mtime = 0;
      try {
        mtime = statSync(absolute).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { entry, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || a.entry.localeCompare(b.entry));
  const cap = Math.min(Math.max(1, options.limit), GLOB_MAX_LIMIT);
  const shown = sorted.slice(0, cap).map((item) => item.entry);
  let result = shown.join("\n");
  if (sorted.length > cap) {
    result += `\n\n[Showing ${cap} of ${sorted.length} matches. Pass limit=${Math.min(cap * 4, GLOB_MAX_LIMIT)} or narrow the pattern to see more.]`;
  }
  if (notices.length > 0) result += `\n\n${notices.join("\n")}`;
  return result || "No files found matching the pattern.";
}

export async function toolGlob(pattern: string, searchPath: string, options: GlobOptions): Promise<string> {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }
  const cap = Math.min(Math.max(1, options.limit), GLOB_MAX_LIMIT);

  const native = options.useNative !== false ? await runBundledFd({
    pattern,
    root: searchPath,
    args: bundledFdArgs(options),
    absolutePath: options.absolutePath,
    signal: options.signal,
  }) : { available: false, content: "" };
  if (native.available) {
    return normalizeNativeFdOutput(native.content, searchPath, options);
  }

  const results: Array<{ path: string; mtime: number }> = [];
  let filesScanned = 0;

  // JS 回退与二进制一致地尊重 .gitignore（含嵌套）；no_ignore 时禁用。
  const ignores = new GitIgnoreStack(!options.noIgnore);
  ignores.seedAncestors(options.ignoreRoot, searchPath);

  async function walk(dir: string, depth: number, relPrefix: string): Promise<void> {
    ignores.push(dir);
    try {
      await walkDirectory(dir, depth, relPrefix);
    } finally {
      ignores.pop(dir);
    }
  }

  async function walkDirectory(dir: string, depth: number, relPrefix: string): Promise<void> {
    if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;
    // Bounded recursion guard: protects against pathological / circular
    // symlink trees that would otherwise keep recursing on directory loops
    // without ever incrementing filesScanned.
    if (depth > Math.min(options.maxDepth ?? GLOB_MAX_DEPTH, GLOB_MAX_DEPTH)) return;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;
      // Hidden names skip universally (files + dirs). Directory-only
      // exclusions (node_modules, dist, target, — are checked AFTER stat
      // so a regular file with the same name is not silently hidden.
      if (!options.includeHidden && isHiddenName(name)) continue;

      const full = path.join(dir, name);
      const rel = relPrefix ? relPrefix + "/" + name : name;

      let stat;
      try {
        stat = options.follow ? await fs.stat(full) : await fs.lstat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!options.noIgnore && isExcludedDirName(name)) continue;
        if (ignores.ignores(full, true)) continue;
        const entryDepth = depth + 1;
        let emptyDirectory = false;
        if (options.type?.some((item) => item.toLocaleLowerCase() === "empty") === true) {
          try {
            emptyDirectory = (await fs.readdir(full)).length === 0;
          } catch {
            emptyDirectory = false;
          }
        }
        const wantsDirectories = options.type?.some((item) => {
          const type = item.toLocaleLowerCase();
          return type === "directory" || type === "dir" || type === "d" || type === "empty";
        }) === true;
        const withinDepth = options.exactDepth !== undefined
          ? entryDepth === options.exactDepth
          : entryDepth >= (options.minDepth ?? 0) && entryDepth <= Math.min(options.maxDepth ?? GLOB_MAX_DEPTH, GLOB_MAX_DEPTH);
        const matchesPattern = matchesGlobEntry(pattern, rel, name, options)
          && (options.andPatterns ?? []).every((extra) => matchesGlobEntry(extra, rel, name, options));
        if (wantsDirectories && withinDepth && !matchesGlobExclusion(rel, name, options.excludes) && matchesGlobType(stat, options.type, emptyDirectory) && matchesPattern) {
          results.push({ path: options.absolutePath === false ? (rel.startsWith(".") ? rel : `./${rel}`) : full.replace(/\\/g, "/"), mtime: stat.mtimeMs });
        }
        if (options.exactDepth === undefined || entryDepth <= options.exactDepth) {
          await walk(full, depth + 1, rel);
        } else if (entryDepth < (options.minDepth ?? 0)) {
          await walk(full, depth + 1, rel);
        }
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        if (ignores.ignores(full, false)) continue;
        filesScanned++;
        const entryDepth = depth + 1;
        const withinDepth = options.exactDepth !== undefined
          ? entryDepth === options.exactDepth
          : entryDepth >= (options.minDepth ?? 0) && entryDepth <= Math.min(options.maxDepth ?? GLOB_MAX_DEPTH, GLOB_MAX_DEPTH);
        const matchesPattern = matchesGlobEntry(pattern, rel, name, options)
          && (options.andPatterns ?? []).every((extra) => matchesGlobEntry(extra, rel, name, options));
        if (withinDepth && !matchesGlobExclusion(rel, name, options.excludes) && matchesGlobType(stat, options.type) && matchesPattern) {
          results.push({ path: options.absolutePath === false ? (rel.startsWith(".") ? rel : `./${rel}`) : full.replace(/\\/g, "/"), mtime: stat.mtimeMs });
        }
      }
    }
  }

  await walk(searchPath, 0, "");

  if (results.length === 0) {
    return "No files found matching the pattern.";
  }

  // Sort by mtime descending (most recently modified first); tie-break by path.
  results.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const truncated = results.length > cap;
  const shown = truncated ? results.slice(0, cap) : results;

  let output = shown.map((r) => r.path).join("\n");
  if (truncated) {
    output += `\n\n[Showing ${cap} of ${results.length} matches. Pass limit=${Math.min(cap * 4, GLOB_MAX_LIMIT)} or narrow the pattern to see more.]`;
  }
  if (filesScanned >= GLOB_MAX_FILES_SCANNED) {
    output += `\n\n[Stopped after scanning ${GLOB_MAX_FILES_SCANNED.toLocaleString()} files; results may be incomplete.]`;
  }
  return output;
}

// ------------------------------------------------------------------
// grep 执行器（增强搜索）
// ------------------------------------------------------------------
