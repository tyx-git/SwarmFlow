/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";

import path from "node:path";

import { isExcludedDirName, isHiddenName } from "./scan-exclusions.js";

import { GitIgnoreStack } from "./gitignore.js";

import { GLOB_MAX_LIMIT, GLOB_MAX_FILES_SCANNED, GLOB_MAX_DEPTH, SEARCH_BUDGET_MS } from "./limits.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

/** 正则字面量转义（用于 glob 的字面量片段）。 */
function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** 找到与 `open` 处 `{` 配对的 `}`（支持嵌套）；未闭合返回 -1。 */
function findClosingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === "{") depth += 1;
    else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切分花括号内容；`[...]` 内的逗号不切分。 */
function splitBraceAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (!inClass && ch === "{") depth += 1;
    else if (!inClass && ch === "}") depth -= 1;
    else if (!inClass && depth === 0 && ch === ",") {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** 把 `[...]` 转成 JS 正则字符类；未闭合返回 null（按字面量处理）。 */
function convertCharClass(pattern: string, open: number): { source: string; next: number } | null {
  let i = open + 1;
  let negated = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negated = true;
    i += 1;
  }
  const start = i;
  while (i < pattern.length && pattern[i] !== "]") i += 1;
  if (i >= pattern.length) return null;
  const body = pattern.slice(start, i);
  if (!body) return null;
  let cls = "";
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (ch === "\\" || ch === "]" || ch === "[" || ch === "^") cls += `\\${ch}`;
    // 首尾的 `-` 是字面量；取反时注入的 `/` 会把它变成区间起点。
    else if (ch === "-" && (index === 0 || index === body.length - 1)) cls += "\\-";
    else cls += ch;
  }
  // glob 的字符类不跨路径段：取反时显式排除 `/`。
  return { source: `[${negated ? "^/" : ""}${cls}]`, next: i + 1 };
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: `*` (any non-slash), `**` (any including slash), `?` (single char),
 * `[abc]` / `[a-z]` / `[!a]` (character classes), `{a,b}` (alternatives，可嵌套、
 * 内部可含通配符), and literal characters.
 */
export function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const cls = convertCharClass(pattern, i);
      if (cls) {
        re += cls.source;
        i = cls.next;
      } else {
        re += "\\[";
        i += 1;
      }
    } else if (ch === "{") {
      const close = findClosingBrace(pattern, i);
      if (close > i) {
        const alternatives = splitBraceAlternatives(pattern.slice(i + 1, close));
        const converted = alternatives
          .map((alt) => globToRegex(alt).source.slice(1, -1))
          .join("|");
        re += `(?:${converted})`;
        i = close + 1;
      } else {
        re += "\\{";
        i += 1;
      }
    } else {
      re += escapeRegexChar(ch);
      i += 1;
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
  /** 测试注入：覆盖 15s 搜索预算（0 可确定性触发超时分支）。 */
  timeBudgetMs?: number;
  /** 测试注入：覆盖全局 gitignore 文件列表。 */
  globalIgnoreFiles?: readonly string[];
  /** .gitignore/.ignore 规则的根目录（通常是 projectRoot）。 */
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
    // 后缀匹配而不是 path.extname：支持 d.ts / tar.gz 这类多段扩展名。
    const lowered = entryName.toLocaleLowerCase();
    const matchedExtension = options.extensions.some((item) => {
      const ext = item.replace(/^\./, "").toLocaleLowerCase();
      return ext.length > 0 && lowered.endsWith(`.${ext}`);
    });
    if (!matchedExtension) return false;
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

/**
 * Windows 上按扩展名判定：exe/bat/cmd/com 与无扩展名视为 executable，
 * 且大小写敏感；其他平台用权限位。
 */
function isExecutableEntry(entryName: string, stat: import("node:fs").Stats): boolean {
  if (!stat.isFile()) return false;
  if (process.platform === "win32") {
    const ext = path.extname(entryName).slice(1);
    return ext === "" || ext === "exe" || ext === "bat" || ext === "cmd" || ext === "com";
  }
  return (stat.mode & 0o111) !== 0;
}

export function matchesGlobType(
  stat: import("node:fs").Stats,
  types: string[] | undefined,
  entryName: string,
  emptyDirectory = false,
): boolean {
  if (!types || types.length === 0) return stat.isFile();
  return types.some((raw) => {
    const type = raw.toLocaleLowerCase();
    if (type === "file" || type === "f") return stat.isFile();
    if (type === "directory" || type === "dir" || type === "d") return stat.isDirectory();
    if (type === "symlink" || type === "l") return stat.isSymbolicLink();
    if (type === "empty") return stat.isFile() ? stat.size === 0 : stat.isDirectory() && emptyDirectory;
    if (type === "executable" || type === "x") return isExecutableEntry(entryName, stat);
    return false;
  });
}

export async function toolGlob(pattern: string, searchPath: string, options: GlobOptions): Promise<string> {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }
  const cap = Math.min(Math.max(1, options.limit), GLOB_MAX_LIMIT);

  const results: Array<{ path: string; mtime: number }> = [];
  let filesScanned = 0;
  const budgetMs = options.timeBudgetMs ?? SEARCH_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let timedOut = false;

  // 与 rg 一致：全局 gitignore（最低优先级）→ .gitignore/.ignore（含嵌套）；no_ignore 时禁用。
  const ignores = new GitIgnoreStack(!options.noIgnore, [".gitignore", ".ignore"], options.globalIgnoreFiles);
  ignores.seedGlobal(searchPath);
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
    // 与 native 的 SEARCH_BUDGET_MS 对齐：超时后返回已收集的部分结果。
    if (Date.now() >= deadline) {
      timedOut = true;
      return;
    }
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
      if (Date.now() >= deadline) {
        timedOut = true;
        return;
      }
      // Hidden names skip universally (files + dirs). Directory-only
      // exclusions (node_modules, dist, target, — are checked AFTER stat
      // so a regular file with the same name is not silently hidden.
      if (!options.includeHidden && isHiddenName(name)) continue;

      const full = path.join(dir, name);
      const rel = relPrefix ? relPrefix + "/" + name : name;
      // exclude 对目录/文件都生效，且目录会直接剪枝；
      // 必须在 stat/递归之前判断，否则被排除目录下的文件仍会返回。
      if (matchesGlobExclusion(rel, name, options.excludes)) continue;

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
        if (wantsDirectories && withinDepth && matchesGlobType(stat, options.type, name, emptyDirectory) && matchesPattern) {
          const shownPath = options.absolutePath === false ? (rel.startsWith(".") ? rel : `./${rel}`) : full.replace(/\\/g, "/");
          // 目录结果带尾斜杠，保持与历史输出一致。
          results.push({ path: `${shownPath}/`, mtime: stat.mtimeMs });
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
        if (withinDepth && matchesGlobType(stat, options.type, name) && matchesPattern) {
          results.push({ path: options.absolutePath === false ? (rel.startsWith(".") ? rel : `./${rel}`) : full.replace(/\\/g, "/"), mtime: stat.mtimeMs });
        }
      }
    }
  }

  await walk(searchPath, 0, "");

  // Sort by mtime descending (most recently modified first); tie-break by path.
  results.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const truncated = results.length > cap;
  const shown = truncated ? results.slice(0, cap) : results;

  // 提示与 native 对齐：即使没有匹配也要保留“停止/超时”说明。
  const notices: string[] = [];
  if (truncated) {
    notices.push(`[Showing ${cap} of ${results.length} matches. Pass limit=${Math.min(cap * 4, GLOB_MAX_LIMIT)} or narrow the pattern to see more.]`);
  }
  if (filesScanned >= GLOB_MAX_FILES_SCANNED) {
    notices.push(`[Stopped after scanning ${GLOB_MAX_FILES_SCANNED.toLocaleString()} files; results may be incomplete.]`);
  }
  if (timedOut) {
    notices.push(`[Search stopped after ${budgetMs}ms.]`);
  }
  let output = shown.map((r) => r.path).join("\n");
  if (notices.length > 0) output += (output ? "\n\n" : "") + notices.join("\n");
  return output || "No files found matching the pattern.";
}

// ------------------------------------------------------------------
// grep 执行器（增强搜索）
// ------------------------------------------------------------------
