/** grep 执行器：文件/内容匹配、glob 与类型过滤；rg 优先、JS 回退，统一排序与截断。 */

import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

import path from "node:path";

import { shell } from "../platform/index.js";

import { getSensitiveFileReadReason } from "../security/sensitive-files.js";

import { isExcludedDirName, isHiddenName } from "./scan-exclusions.js";
import { SEARCH_BUDGET_MS } from "./limits.js";
import { truncateLine, truncateMiddle } from "./output-truncation.js";

import { runBundledRg } from "./native-search.js";
import { GitIgnoreStack } from "./gitignore.js";

import {
  SEARCH_MAX_DEPTH,
  SEARCH_MAX_FILE_SIZE,
  SEARCH_LINE_MAX_CHARS,
  SEARCH_DEFAULT_HEAD_LIMIT,
  SEARCH_OUTPUT_CHAR_CAP,
  SEARCH_MAX_PATTERNS,
  SEARCH_MAX_PATTERN_LENGTH,
  SEARCH_NATIVE_JSON_RAW_CAP,
  SEARCH_MAX_FILES,
  SEARCH_MAX_TOTAL_BYTES,
} from "./limits.js";
import { globToRegex } from "./glob.js";

export interface GrepOptions {
  /** 测试注入：false 时强制 JS 回退；生产默认走随包二进制。 */
  useNative?: boolean;
  /** .gitignore 规则的根目录（通常是 projectRoot）。 */
  ignoreRoot?: string;
  glob?: string[];
  fileType?: string[];
  outputMode: "content" | "files_with_matches" | "count";
  afterContext: number;
  beforeContext: number;
  /** undefined = smart-case（自动），true = 强制 -i，false = 强制区分大小写 */
  caseInsensitive: boolean | undefined;
  showLineNumbers: boolean;
  headLimit: number;
  perFileLimit: number;
  fixedStrings: boolean;
  wordRegexp: boolean;
  lineRegexp: boolean;
  multiline: boolean;
  hidden: boolean;
  noIgnore: boolean;
  follow: boolean;
  maxDepth: number;
  maxCount: number;
  invertMatch: boolean;
  onlyMatching: boolean;
  countMatches: boolean;
  includeZero: boolean;
  text: boolean;
  sort: "path" | "modified" | "none";
  signal?: AbortSignal;
}

/** 判断文件名是否匹配简单 glob 模式（如 "*.ts"、"*.{ts,tsx}"）。 */
export function matchFileGlob(filename: string, globPatterns: readonly string[]): boolean {
  if (globPatterns.length === 0) return true;
  let included = false;
  let hasPositive = false;
  for (const globPattern of globPatterns) {
    const negated = globPattern.startsWith("!");
    if (!negated) hasPositive = true;
    const pattern = negated ? globPattern.slice(1) : globPattern;
    const regex = globToRegex(pattern.includes("/") ? pattern : `**/${pattern}`);
    if (!regex.test(filename) && !regex.test(path.basename(filename))) continue;
    if (negated) return false;
    included = true;
  }
  return hasPositive ? included : true;
}

/** 判断文件扩展名是否匹配类型过滤。 */
export function matchFileType(filename: string, typeFilters: readonly string[]): boolean {
  if (typeFilters.length === 0) return true;
  const ext = path.extname(filename).slice(1).toLowerCase();
  const aliases: Record<string, readonly string[]> = {
    javascript: ["js", "jsx", "mjs", "cjs"],
    typescript: ["ts", "tsx", "mts", "cts"],
    python: ["py", "pyi"],
    shell: ["sh", "bash", "zsh"],
    rust: ["rs"],
    go: ["go"],
    java: ["java"],
    csharp: ["cs"],
    cpp: ["cc", "cpp", "cxx", "hpp", "hh", "hxx"],
  };
  return typeFilters.some((typeFilter) => {
    const normalized = typeFilter.replace(/^\./, "").toLowerCase();
    return (aliases[normalized] ?? [normalized]).includes(ext);
  });
}

export function bundledRgArgs(options: GrepOptions): string[] {
  const args: string[] = [];
  const isContent = options.outputMode === "content";
  // content 使用 JSON 事件流，才能可靠处理 context / 无行号 / multiline
  // 以及敏感文件边界；files/count 继续使用原生文本输出。
  if (isContent) args.push("--json");
  if (options.outputMode === "files_with_matches") args.push("--files-with-matches");
  if (options.outputMode === "count") args.push(options.countMatches ? "--count-matches" : "--count");
  if (isContent && options.afterContext === options.beforeContext && options.afterContext > 0) {
    args.push("--context", String(options.afterContext));
  } else if (isContent) {
    if (options.afterContext > 0) args.push("--after-context", String(options.afterContext));
    if (options.beforeContext > 0) args.push("--before-context", String(options.beforeContext));
  }
  if (options.caseInsensitive === true) args.push("--ignore-case");
  else if (options.caseInsensitive === false) args.push("--case-sensitive");
  // rg 15 默认区分大小写，而 JS 实现用 smart-case（全小写 pattern 忽略大小写）。
  // 不显式传 --smart-case 会让 `grep foobar` 漏掉 `FooBar`。
  else args.push("--smart-case");
  if (options.fixedStrings) args.push("--fixed-strings");
  if (options.wordRegexp) args.push("--word-regexp");
  if (options.lineRegexp) args.push("--line-regexp");
  if (options.multiline) args.push("--multiline");
  if (options.hidden) args.push("--hidden");
  if (options.noIgnore) args.push("--no-ignore");
  // 没有 .git 目录时也要读取 .gitignore；与 JS 回退语义保持一致。
  else args.push("--no-require-git");
  if (options.follow) args.push("--follow");
  if (options.maxDepth >= 0) args.push("--max-depth", String(Math.min(options.maxDepth, SEARCH_MAX_DEPTH)));
  // 与 JS 实现对齐：超过 1 MB 的文件跳过，避免把巨大文件读进内存。
  args.push("--max-filesize", `${Math.round(SEARCH_MAX_FILE_SIZE / 1024)}K`);
  // rg 的 -m/--max-count 按文件生效；limit_per_file 只约束 content 模式。
  // count/files 模式不能把 limit_per_file 混进 --max-count，否则计数会被截断。
  const caps: number[] = [];
  if (options.maxCount > 0) caps.push(options.maxCount);
  if (options.outputMode === "content" && options.perFileLimit > 0) caps.push(options.perFileLimit + 1);
  if (caps.length > 0) args.push("--max-count", String(Math.min(...caps)));
  if (options.invertMatch) args.push("--invert-match");
  if (options.includeZero && options.outputMode === "count") args.push("--include-zero");
  if (options.text) args.push("--text");
  for (const glob of options.glob ?? []) args.push("--glob", glob);
  for (const type of options.fileType ?? []) args.push("--type", type);
  // 排序统一在 formatGrepContent / formatGrepSummaries 中完成，避免
  // rg 的 --sort=modified（旧到新）与 JS 的降序语义分叉。
  return args;
}
// ------------------------------------------------------------------
// grep 输出统一层
// ------------------------------------------------------------------
//
// native 与 JS 回退都必须落到同一套 canonical 文本格式：
//   content:  path:line:text（match）/ path-line-text（context）
//   only:     每个匹配一行
//   files:    path
//   count:    path:count
// 排序、每文件上限、行长截断都在这里统一处理，避免两条路径各写一套。

export interface GrepOutputLine {
  line: number;
  text: string;
  kind: "match" | "context";
}

export interface GrepOutputFile {
  file: string;
  lines: GrepOutputLine[];
  matchLines: number;
  hidden?: number;
}

export interface GrepFileSummary {
  file: string;
  count: number;
}

export interface GrepMatchLine {
  line: number;
  text: string;
  lineCount: number;
  matchTexts?: string[];
}

export interface GrepFileMatches {
  file: string;
  matches: GrepMatchLine[];
  count: number;
  truncatedAt?: number;
}

export function isNativeSearchNotice(line: string): boolean {
  return /^\[(?:Output truncated|Search stopped|Search cancelled)/.test(line);
}

export function sortGrepFiles<T extends { file: string }>(files: T[], sort: GrepOptions["sort"]): T[] {
  if (sort === "path") {
    return [...files].sort((a, b) => a.file.localeCompare(b.file));
  }
  if (sort === "modified") {
    const mtime = (file: string): number => {
      try {
        return statSync(file).mtimeMs;
      } catch {
        return 0;
      }
    };
    // 统一方向：新 -> 旧；mtime 相同按路径稳定排序。
    return [...files].sort((a, b) => mtime(b.file) - mtime(a.file) || a.file.localeCompare(b.file));
  }
  return [...files];
}

export function formatGrepContent(
  files: GrepOutputFile[],
  options: GrepOptions,
  extraNotices: string[] = [],
): { body: string; notices: string[] } {
  const sorted = sortGrepFiles(files, options.sort);
  const withContext = (options.beforeContext > 0 || options.afterContext > 0) && !options.onlyMatching;
  const out: string[] = [];
  for (const file of sorted) {
    let previousLine = 0;
    if (withContext && out.length > 0) out.push("--");
    for (const line of file.lines) {
      if (withContext && previousLine > 0 && line.line > previousLine + 1) out.push("--");
      const separator = line.kind === "match" ? ":" : "-";
      const prefix = options.showLineNumbers
        ? `${file.file}${separator}${line.line}${separator}`
        : `${file.file}${separator}`;
      out.push(prefix + truncateLine(line.text.replace(/\r$/, ""), SEARCH_LINE_MAX_CHARS));
      previousLine = line.line;
    }
    if ((file.hidden ?? 0) > 0) {
      out.push(`${file.file}: —(${file.hidden} more matches in this file; raise limit_per_file to see them)`);
    }
  }

  const cap = options.headLimit > 0 ? options.headLimit : SEARCH_DEFAULT_HEAD_LIMIT;
  const truncated = out.length > cap;
  if (truncated) out.length = cap;
  const notices = [...extraNotices];
  if (truncated) {
    notices.push(`Reached results cap (${cap}). Narrow the pattern, restrict path/glob, or raise head_limit.`);
  }
  return { body: out.join("\n") || "No matches found.", notices };
}

export function formatGrepSummaries(
  files: GrepFileSummary[],
  options: GrepOptions,
  extraNotices: string[] = [],
): { body: string; notices: string[] } {
  const sorted = sortGrepFiles(files, options.sort);
  const cap = options.headLimit > 0 ? options.headLimit : SEARCH_DEFAULT_HEAD_LIMIT;
  const truncated = sorted.length > cap;
  const shown = truncated ? sorted.slice(0, cap) : sorted;
  const notices = [...extraNotices];
  if (truncated) {
    notices.push(`Reached results cap (${cap}). Narrow the pattern, restrict path/glob, or raise head_limit.`);
  }
  return {
    body: shown
      .map((item) => options.outputMode === "count" ? `${item.file}:${item.count}` : item.file)
      .join("\n") || "No matches found.",
    notices,
  };
}

/**
 * 最终字符预算。
 * 第 8 点暂不统一策略：JS 保留头尾中段截断，native 保留头部截断。
 */
export function finalizeGrepOutput(result: { body: string; notices: string[] }, headOnly: boolean): string {
  let body = result.body;
  const notices = [...result.notices];
  if (body.length > SEARCH_OUTPUT_CHAR_CAP) {
    if (headOnly) {
      body = body.slice(0, SEARCH_OUTPUT_CHAR_CAP);
      notices.push(`Output truncated at ${SEARCH_OUTPUT_CHAR_CAP} characters.`);
    } else {
      body = truncateMiddle(body, SEARCH_OUTPUT_CHAR_CAP);
      notices.push(`Output exceeded ${SEARCH_OUTPUT_CHAR_CAP.toLocaleString()} chars; head+tail kept, middle dropped.`);
    }
  }
  return notices.length > 0
    ? `${body}\n\n[Search notices]\n${notices.map((notice) => `- ${notice}`).join("\n")}`
    : body;
}

/** 把 rg --json 的 match/context 事件还原成统一格式。 */
export function parseNativeGrepJson(
  content: string,
  options: GrepOptions,
): { files: GrepOutputFile[]; notices: string[] } {
  const files = new Map<string, GrepOutputFile>();
  const notices: string[] = [];
  const perFileLimit = options.perFileLimit > 0 ? options.perFileLimit : Number.POSITIVE_INFINITY;
  const sensitiveFiles = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (isNativeSearchNotice(rawLine)) {
      notices.push(rawLine);
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event["type"];
    if (type !== "begin" && type !== "match" && type !== "context") continue;
    const data = (event["data"] ?? {}) as Record<string, unknown>;
    const pathText = ((data["path"] ?? {}) as Record<string, unknown>)["text"];
    if (typeof pathText !== "string") continue;
    const file = path.normalize(pathText);
    if (getSensitiveFileReadReason(file)) {
      sensitiveFiles.add(file);
      continue;
    }
    let entry = files.get(file);
    if (!entry) {
      entry = { file, lines: [], matchLines: 0 };
      files.set(file, entry);
    }
    if (type === "begin") continue;

    const lineNumber = typeof data["line_number"] === "number" ? data["line_number"] : 1;
    const rawText = typeof ((data["lines"] ?? {}) as Record<string, unknown>)["text"] === "string"
      ? String(((data["lines"] as Record<string, unknown>)["text"]))
      : "";
    const segments = rawText.split("\n");
    if (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();

    if (type === "match") {
      if ((entry.hidden ?? 0) > 0) continue;
      const submatches = Array.isArray(data["submatches"]) ? data["submatches"] as Array<Record<string, unknown>> : [];
      if (options.onlyMatching && submatches.length > 0) {
        for (const submatch of submatches) {
          const match = (submatch["match"] ?? {}) as Record<string, unknown>;
          const matchText = typeof match["text"] === "string" ? match["text"] : "";
          const parts = matchText.split("\n");
          for (let index = 0; index < parts.length; index += 1) {
            if (entry.matchLines >= perFileLimit) {
              entry.hidden = (entry.hidden ?? 0) + 1;
              continue;
            }
            entry.lines.push({ line: lineNumber + index, text: parts[index]!, kind: "match" });
            entry.matchLines += 1;
          }
        }
      } else {
        for (let index = 0; index < segments.length; index += 1) {
          if (entry.matchLines >= perFileLimit) {
            entry.hidden = (entry.hidden ?? 0) + 1;
            continue;
          }
          entry.lines.push({ line: lineNumber + index, text: segments[index]!, kind: "match" });
          entry.matchLines += 1;
        }
      }
    } else {
      // only-matching 不输出上下文；跳过 context 事件，避免产生无主的 `-` 行。
      if (options.onlyMatching) continue;
      // 已超上限时，额外匹配周围的 context 一并丢弃，避免出现无主的上下文行。
      if ((entry.hidden ?? 0) > 0) continue;
      for (let index = 0; index < segments.length; index += 1) {
        entry.lines.push({ line: lineNumber + index, text: segments[index]!, kind: "context" });
      }
    }
  }

  if (sensitiveFiles.size > 0) notices.push(`Skipped ${sensitiveFiles.size} sensitive file(s).`);
  return { files: [...files.values()].filter((file) => file.lines.length > 0), notices };
}

/** files_with_matches / count 的 native 文本输出转成统一结构。 */
export function parseNativeGrepSummaries(
  content: string,
  options: GrepOptions,
): { files: GrepFileSummary[]; notices: string[] } {
  const files: GrepFileSummary[] = [];
  const notices: string[] = [];
  const sensitiveFiles = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isNativeSearchNotice(line)) {
      notices.push(line);
      continue;
    }
    if (line.startsWith("ERROR:") || line === "No matches found.") continue;
    if (options.outputMode === "count") {
      const match = /^(.*):(\d+)$/.exec(line);
      if (!match) continue;
      const file = path.normalize(match[1]!);
      if (getSensitiveFileReadReason(file)) {
        sensitiveFiles.add(file);
        continue;
      }
      files.push({ file, count: Number(match[2]) });
    } else {
      const file = path.normalize(line);
      if (getSensitiveFileReadReason(file)) {
        sensitiveFiles.add(file);
        continue;
      }
      files.push({ file, count: 0 });
    }
  }
  if (sensitiveFiles.size > 0) notices.push(`Skipped ${sensitiveFiles.size} sensitive file(s).`);
  return { files, notices };
}

/** 把 JS 回退的命中记录展开成与 native 相同的行结构。 */
export async function buildJsGrepOutputFiles(
  fileMatches: GrepFileMatches[],
  options: GrepOptions,
): Promise<GrepOutputFile[]> {
  const result: GrepOutputFile[] = [];
  const withContext = (options.beforeContext > 0 || options.afterContext > 0) && !options.onlyMatching;

  for (const matches of fileMatches) {
    const lines: GrepOutputLine[] = [];
    if (withContext) {
      let fileLines: string[];
      try {
        fileLines = (await fs.readFile(matches.file, "utf-8")).split(/\r?\n/);
        // 末尾换行产生的空元素不是真实上下文行；native rg 不会输出它。
        if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") fileLines.pop();
      } catch {
        continue;
      }
      const ranges = matches.matches.map((match) => ({
        start: match.line,
        end: match.line + match.lineCount - 1,
      }));
      const selected = new Map<number, GrepOutputLine>();
      for (const match of matches.matches) {
        const start = Math.max(1, match.line - options.beforeContext);
        const end = Math.min(fileLines.length, match.line + match.lineCount - 1 + options.afterContext);
        for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
          const kind: GrepOutputLine["kind"] = ranges.some(
            (range) => lineNumber >= range.start && lineNumber <= range.end,
          ) ? "match" : "context";
          const existing = selected.get(lineNumber);
          if (!existing || kind === "match") {
            selected.set(lineNumber, { line: lineNumber, text: fileLines[lineNumber - 1] ?? "", kind });
          }
        }
      }
      for (const line of [...selected.values()].sort((a, b) => a.line - b.line)) lines.push(line);
    } else {
      for (const match of matches.matches) {
        const parts = match.matchTexts ?? [match.text];
        for (const part of parts) {
          const segments = part.split("\n");
          for (let index = 0; index < segments.length; index += 1) {
            lines.push({ line: match.line + index, text: segments[index]!, kind: "match" });
          }
        }
      }
    }

    const matchLines = lines.filter((line) => line.kind === "match").length;
    result.push({
      file: matches.file,
      lines,
      matchLines,
      hidden: matches.truncatedAt !== undefined ? Math.max(1, matches.count - matchLines) : undefined,
    });
  }
  return result;
}

export async function toolGrep(
  patterns: string[],
  searchPath: string,
  options: GrepOptions,
): Promise<string> {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }

  if (patterns.length === 0) {
    return "ERROR: pattern must be a non-empty string or array of strings.";
  }
  if (patterns.length > SEARCH_MAX_PATTERNS) {
    return `ERROR: Too many patterns (${patterns.length}; max ${SEARCH_MAX_PATTERNS}).`;
  }
  for (const pat of patterns) {
    if (!pat) {
      return "ERROR: Invalid arguments for grep: pattern entries must be non-empty strings.";
    }
    if (pat.length > SEARCH_MAX_PATTERN_LENGTH) {
      return (
        `ERROR: Invalid arguments for grep: 'pattern' exceeds max length ` +
        `(${pat.length} chars, limit ${SEARCH_MAX_PATTERN_LENGTH}).`
      );
    }
    if (!options.fixedStrings && /(^|[^\\])\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pat)) {
      return "ERROR: Regex appears too complex/risky (nested quantified group).";
    }
  }

  // 显式路径优先于 rg 的 glob 规则：这里必须在 native/JS 分支之前拦截，
  // 否则直接 grep 一个敏感文件会绕过目录遍历时的过滤。
  const searchStat = statSync(searchPath);
  if (searchStat.isFile()) {
    const sensitiveReason = getSensitiveFileReadReason(searchPath);
    if (sensitiveReason) {
      return `ERROR: Access to sensitive file is blocked by default: ${searchPath} (${sensitiveReason}).`;
    }
  }

  const native = options.useNative !== false ? await runBundledRg({
    patterns,
    root: searchPath,
    args: bundledRgArgs(options),
    signal: options.signal,
    outputCap: options.outputMode === "content" ? SEARCH_NATIVE_JSON_RAW_CAP : undefined,
  }) : { available: false, content: "" };
  if (native.available) {
    if (native.content.startsWith("ERROR:")) return native.content;
    if (options.outputMode === "content") {
      const { files, notices } = parseNativeGrepJson(native.content, options);
      return finalizeGrepOutput(formatGrepContent(files, options, notices), true);
    }
    const { files, notices } = parseNativeGrepSummaries(native.content, options);
    return finalizeGrepOutput(formatGrepSummaries(files, options, notices), true);
  }

  // Smart case（ripgrep 风格）：pattern 里没有 ASCII 大写时 → -i。
  // 注意这也包括 `[a-z]+` 这类区间（当前同样带上 -i）和
  // `\d+` 这类不含字母的 pattern（此时 -i 无意义）。
  let effectiveCaseInsensitive: boolean;
  if (options.caseInsensitive === undefined) {
    effectiveCaseInsensitive = patterns.every((p) => p === p.toLowerCase());
  } else {
    effectiveCaseInsensitive = options.caseInsensitive;
  }

  const preparedPatterns = options.fixedStrings
    ? patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    : patterns;
  const patternRegexes = preparedPatterns.map((pattern) => {
    let source = pattern;
    if (options.wordRegexp) source = `\\b(?:${source})\\b`;
    if (options.lineRegexp) source = `^(?:${source})$`;
    if (options.multiline) source = source.replace(/\\n/g, "\n");
    return source;
  });

  // 多个 pattern 合成一个 OR 正则。只有一个时直接用它，保持原有
  // 正则语义（捕获组、锚点等）不变；多个时各自套一层非捕获组，
  // 保证选择分支的优先级正确。
  let regex: RegExp;
  try {
    const flags = effectiveCaseInsensitive ? "i" : "";
    // 对齐 rg --multiline：`.` 不跨行；显式 \n 仍可跨行。
    // 不使用 s 标志，否则 `foo.*bar` 会在 JS 与二进制之间产生不同结果。
    if (patterns.length === 1) {
      regex = new RegExp(patternRegexes[0]!, flags);
    } else {
      regex = new RegExp(patternRegexes.map((p) => `(?:${p})`).join("|"), flags);
    }
  } catch (e) {
    return `ERROR: Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }

  const startedAt = Date.now();
  const stats = {
    filesScanned: 0,
    bytesScanned: 0,
    skippedLargeFiles: 0,
    skippedSensitiveFiles: 0,
    depthLimitHits: 0,
    maxFilesHit: false,
    maxBytesHit: false,
    timeoutHit: false,
  };

  // 结果的存储方式取决于输出模式
  const fileMatches: GrepFileMatches[] = [];
  let totalEntries = 0;

  function shouldStop(): boolean {
    // 多读取一个条目，才能让 formatter 判断“确实还有更多”并给出 cap 提示；
    // 恰好等于上限时停止会丢失 native/JS 都必须出现的 truncation notice。
    if (options.headLimit > 0 && totalEntries > options.headLimit) return true;
    if (stats.maxFilesHit || stats.maxBytesHit || stats.timeoutHit) return true;
    if (Date.now() - startedAt > SEARCH_BUDGET_MS) {
      stats.timeoutHit = true;
      return true;
    }
    return false;
  }

  function shouldIncludeFile(filename: string, relativePath = filename): boolean {
    if (options.glob && !matchFileGlob(relativePath, options.glob)) return false;
    if (options.fileType && !matchFileType(filename, options.fileType)) return false;
    return true;
  }

  async function processFile(filePath: string): Promise<void> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch {
      return;
    }
    // 除非请求了 rg 的文本模式，否则跳过二进制文件。
    const header = raw.subarray(0, 8192);
    if (!options.text && header.includes(0)) return;

    const text = raw.toString("utf-8");
    const matchingLines: GrepMatchLine[] = [];    // content：limit_per_file 决定展示行数，max_count 也按文件截断。
    // count：只受 max_count 约束；files：命中一次即可。
    const perFileStoreCap = options.outputMode === "content"
      ? Math.max(1, Math.min(
        options.perFileLimit > 0 ? options.perFileLimit : Number.POSITIVE_INFINITY,
        options.maxCount > 0 ? options.maxCount : Number.POSITIVE_INFINITY,
      ))
      : 1;
    const scanCap = options.outputMode === "count"
      ? (options.maxCount > 0 ? options.maxCount : Number.POSITIVE_INFINITY)
      : options.outputMode === "files_with_matches"
        ? 1
        : Math.min(
          options.perFileLimit > 0 ? options.perFileLimit + 1 : Number.POSITIVE_INFINITY,
          options.maxCount > 0 ? options.maxCount : Number.POSITIVE_INFINITY,
        );
    let totalMatchesInFile = 0;
    let totalIndividualMatches = 0;
    let truncatedAt: number | undefined;

    const pushMatch = (line: number, matchedText: string, lineCount: number, matchTexts?: string[]): void => {
      // files/count 只需要知道文件命中；不保存匹配内容，避免无上限内存。
      if (options.outputMode !== "content") {
        if (matchingLines.length === 0) {
          matchingLines.push({ line, text: matchedText.trimEnd(), lineCount, matchTexts });
        }
        return;
      }
      if (totalMatchesInFile <= perFileStoreCap) {
        matchingLines.push({ line, text: matchedText.trimEnd(), lineCount, matchTexts });
      } else if (truncatedAt === undefined) {
        truncatedAt = totalMatchesInFile;
      }
    };

    if (options.multiline) {
      const globalRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
      if (options.invertMatch) {
        // 反选 + multiline 不是常用组合：按整文件是否匹配处理。
        if (!regex.test(text)) {
          const lineCount = text.split("\n").length;
          totalMatchesInFile = lineCount;
          pushMatch(1, text, lineCount);
        }
      } else {
        for (const match of text.matchAll(globalRegex)) {
          const matchedText = match[0] ?? "";
          if (!matchedText) continue;
          const startLine = text.slice(0, match.index ?? 0).split("\n").length;
          const lineCount = matchedText.split("\n").length;
          totalMatchesInFile += lineCount;
          if (options.countMatches) totalIndividualMatches += 1;
          if (totalMatchesInFile > scanCap) {
            if (options.outputMode === "content" && truncatedAt === undefined) truncatedAt = totalMatchesInFile;
            break;
          }
          pushMatch(startLine, matchedText, lineCount, options.onlyMatching ? [matchedText] : undefined);
        }
      }
    } else {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.global || regex.sticky) regex.lastIndex = 0;
        const lineText = lines[i]!;
        const match = regex.exec(lineText);
        const isMatch = match !== null;
        if (options.invertMatch ? !isMatch : isMatch) {
          totalMatchesInFile += 1;
          if (options.countMatches && !options.invertMatch) {
            const countRegex = new RegExp(regex.source, regex.flags.replace("g", "") + "g");
            totalIndividualMatches += [...lineText.matchAll(countRegex)].length;
          }
          const matchTexts = options.onlyMatching && !options.invertMatch && match
            ? [...lineText.matchAll(new RegExp(regex.source, regex.flags.replace("g", "") + "g"))].map((item) => item[0])
            : undefined;
          pushMatch(i + 1, lineText, 1, matchTexts);
          if (totalMatchesInFile >= scanCap) break;
        }
      }
    }

    if (matchingLines.length > 0 || (options.outputMode === "count" && options.includeZero)) {
      fileMatches.push({
        file: filePath,
        matches: matchingLines,
        count: options.countMatches ? totalIndividualMatches : totalMatchesInFile,
        truncatedAt,
      });
      // headLimit 按最终输出行数计（content），其他模式按文件数计。
      totalEntries += options.outputMode === "content"
        ? matchingLines.reduce((sum, match) => sum + match.lineCount, 0)
        : 1;
    }
  }

  // JS 回退与二进制一致地尊重 .gitignore（含嵌套）；no_ignore 时禁用。
  const ignores = new GitIgnoreStack(!options.noIgnore);
  ignores.seedGlobal(searchPath);
  ignores.seedAncestors(options.ignoreRoot, searchPath);

  async function walkForGrep(dir: string, depth: number): Promise<void> {
    ignores.push(dir);
    try {
      await walkGrepDirectory(dir, depth);
    } finally {
      ignores.pop(dir);
    }
  }

  async function walkGrepDirectory(dir: string, depth: number): Promise<void> {
    if (shouldStop()) return;
    if (depth > Math.min(options.maxDepth, SEARCH_MAX_DEPTH)) {
      stats.depthLimitHits += 1;
      return;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    entries.sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (shouldStop()) return;
      // 点开头的隐藏名一律跳过。排除目录名只在 stat 之后过滤，
      // 免得把恰好叫 `build` / `dist` / `target` 之类的普通文件
      // 也一并藏起来。
      if (!options.hidden && isHiddenName(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = options.follow ? await fs.stat(full) : await fs.lstat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!options.noIgnore && isExcludedDirName(name)) continue;
        if (ignores.ignores(full, true)) continue;
        await walkForGrep(full, depth + 1);
      } else if (stat.isFile()) {
        if (ignores.ignores(full, false)) continue;
        const relativePath = path.relative(searchPath, full).replace(/\\/g, "/");
        if (!shouldIncludeFile(name, relativePath)) continue;
        if (getSensitiveFileReadReason(full)) {
          stats.skippedSensitiveFiles += 1;
          continue;
        }
        if (stats.filesScanned >= SEARCH_MAX_FILES) {
          stats.maxFilesHit = true;
          return;
        }
        stats.filesScanned += 1;

        if (stat.size > SEARCH_MAX_FILE_SIZE) {
          stats.skippedLargeFiles += 1;
          continue;
        }
        if (stats.bytesScanned + stat.size > SEARCH_MAX_TOTAL_BYTES) {
          stats.maxBytesHit = true;
          return;
        }
        stats.bytesScanned += stat.size;

        await processFile(full);
      }
    }
  }

  // 处理单个文件路径
  const pathStat = searchStat;
  if (pathStat.isFile()) {
    if (shouldIncludeFile(path.basename(searchPath), path.basename(searchPath))) {
      await processFile(searchPath);
    }
  } else {
    if (options.sort === "path") {
      // 目录遍历本身已按字典序排序。
    }
    await walkForGrep(searchPath, 0);
  }

  const notices: string[] = [];
  if (stats.skippedLargeFiles > 0) {
    notices.push(`Skipped ${stats.skippedLargeFiles} large file(s) over ${Math.round(SEARCH_MAX_FILE_SIZE / 1024)} KB.`);
  }
  if (stats.skippedSensitiveFiles > 0) {
    notices.push(`Skipped ${stats.skippedSensitiveFiles} sensitive file(s).`);
  }
  if (stats.depthLimitHits > 0) {
    notices.push(`Depth limit reached in ${stats.depthLimitHits} director${stats.depthLimitHits === 1 ? "y" : "ies"} (max depth ${SEARCH_MAX_DEPTH}).`);
  }
  if (stats.maxFilesHit) {
    notices.push(`Stopped after scanning ${SEARCH_MAX_FILES} files.`);
  }
  if (stats.maxBytesHit) {
    notices.push(`Stopped after scanning ${Math.round(SEARCH_MAX_TOTAL_BYTES / 1024 / 1024)} MB.`);
  }
  if (stats.timeoutHit) {
    notices.push(`Stopped after ${SEARCH_BUDGET_MS}ms time limit.`);
  }

  if (options.outputMode === "content") {
    const files = await buildJsGrepOutputFiles(fileMatches, options);
    return finalizeGrepOutput(formatGrepContent(files, options, notices), false);
  }
  const summaries = fileMatches.map((match) => ({ file: match.file, count: match.count }));
  return finalizeGrepOutput(formatGrepSummaries(summaries, options, notices), false);
}
