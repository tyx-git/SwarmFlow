/**
 * 文件修改工具（edit_file / write_file）共享的 diff hunk 模型。
 *
 * 用于：
 *  - tool-loop.ts  (流式上下文探测 → 尽力生成 hunk)
 *  - basic.ts      (工具执行 → 权威 hunk)
 *  - presentation  (渲染 → FileModifyBody)
 */

import { extname } from "node:path";

// ------------------------------------------------------------------
// 类型定义
// ------------------------------------------------------------------

/** 单个 diff hunk——文件中一个连续的变更区域 */
export interface DiffHunk {
  /** 原始文件中第一个*删除*行所在的行号（1 基） */
  startLine: number;
  /** 变更前的上下文行。空数组 = 无上下文（如第 1 行编辑） */
  contextBefore: string[];
  /** 删除的行（旧内容） */
  deletions: string[];
  /** 插入的行（新内容） */
  additions: string[];
  /** 变更后的上下文行。空数组 = 无上下文（如最后一行编辑） */
  contextAfter: string[];
}

/** 完整的文件修改显示数据——流式和完成阶段共享 */
export interface FileModifyDisplayData {
  /** 文件路径 */
  filePath: string;
  /** 语言标识（用于语法高亮） */
  language?: string;
  /** 模式：replace / append / write */
  mode: "replace" | "append" | "write";
  /** 原始文件总行数（编辑前）。用于 鈰?决策。 */
  totalLineCount: number;
  /** 有序的 diff hunk 列表。单次编辑 = 1 个 hunk。多次编辑 = N 个 hunk。 */
  hunks: DiffHunk[];
  /** 仅 write 模式：完整文件内容行（无 hunk） */
  writeLines?: string[];
}

/** 流式过程中保存在 PendingToolCallState 中的每次编辑探测状态 */
export interface EditProbeState {
  /** 是否已解析 */
  resolved: boolean;
  /** 匹配偏移量 */
  matchOffset?: number;
  /** 起始行号 */
  startLine?: number;
  /** 变更前上下文 */
  contextBefore?: string[];
  /** 变更后上下文 */
  contextAfter?: string[];
}

// ------------------------------------------------------------------
// 语言推断
// ------------------------------------------------------------------

/** 文件扩展名到 highlight.js 语言标识的映射 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyw": "python",
  ".rs": "rust", ".go": "go", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala",
  ".rb": "ruby", ".lua": "lua", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".css": "css", ".scss": "scss", ".less": "less",
  ".html": "xml", ".htm": "xml", ".xml": "xml", ".svg": "xml",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "ini",
  ".md": "markdown", ".sql": "sql", ".swift": "swift", ".dart": "dart",
  ".php": "php", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".hs": "haskell", ".ml": "ocaml", ".fs": "fsharp", ".cs": "csharp",
  ".vim": "vim", ".dockerfile": "dockerfile",
};

/** 根据文件路径的扩展名推断 highlight.js 语言 */
export function inferLanguageByExt(filePath: string): string | undefined {
  return LANGUAGE_BY_EXT[extname(filePath).toLowerCase()];
}

// ------------------------------------------------------------------
// 上下文计算
// ------------------------------------------------------------------

/**
 * 提取 `content` 中 `offset` 之前紧邻的最多 `maxLines` 行上下文。
 * 按文档顺序返回行。如果 offset 在文件开头（上方无行），返回空数组。
 */
export function computeContextBefore(
  content: string,
  offset: number,
  maxLines: number,
): string[] {
  if (offset <= 0) return [];
  // 找到 offset 之前紧邻的换行符（前一行末尾）
  const precedingNewline = content.lastIndexOf("\n", offset - 1);
  if (precedingNewline < 0) return []; // offset 在第 1 行，上方无上下文

  // 反向遍历，逐行收集
  const lines: string[] = [];
  let lineEnd = precedingNewline;
  for (let i = 0; i < maxLines; i++) {
    const lineStart = content.lastIndexOf("\n", lineEnd - 1) + 1;
    lines.push(content.slice(lineStart, lineEnd));
    lineEnd = lineStart - 1;
    if (lineEnd < 0) break; // 已到达文件开头
  }
  lines.reverse();
  return lines;
}

/**
 * 提取 `content` 中 `offset` 结束的紧邻区域之后最多 `maxLines` 行上下文。
 * 按文档顺序返回行。如果 offset 在文件末尾或之后，返回空数组。
 */
export function computeContextAfter(
  content: string,
  offset: number,
  maxLines: number,
): string[] {
  if (offset >= content.length) return [];
  // 找到 offset 处或之后的换行符（offset 所在行的末尾）
  const firstNewline = content.indexOf("\n", offset);
  if (firstNewline < 0) return []; // 之后无换行 → offset 在最后一行

  const lines: string[] = [];
  let lineStart = firstNewline + 1;
  for (let i = 0; i < maxLines; i++) {
    if (lineStart >= content.length) break;
    const lineEnd = content.indexOf("\n", lineStart);
    if (lineEnd < 0) {
      lines.push(content.slice(lineStart));
      break;
    }
    lines.push(content.slice(lineStart, lineEnd));
    lineStart = lineEnd + 1;
  }
  return lines;
}

/**
 * 计算文件内容的行数。尾随换行符不计为额外的空行
 * （匹配编辑器约定："a\nb\n" = 2 行）。
 */
export function countFileLines(content: string): number {
  if (content.length === 0) return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

// ------------------------------------------------------------------
// Hunk 构建器
// ------------------------------------------------------------------

/** 默认上下文行数 */
const CONTEXT_LINES = 3;

/**
 * 从原始文件内容的匹配位置构建单个 DiffHunk。
 * 用于单次编辑，也作为多次编辑的构建块。
 */
export function buildHunkFromMatch(
  content: string,
  matchOffset: number,
  oldStr: string,
  newStr: string,
  contextLineCount: number = CONTEXT_LINES,
): DiffHunk {
  const startLine = content.substring(0, matchOffset).split("\n").length;
  const contextBefore = computeContextBefore(content, matchOffset, contextLineCount);
  const matchEnd = matchOffset + oldStr.length;
  const contextAfter = computeContextAfter(content, matchEnd, contextLineCount);

  return {
    startLine,
    contextBefore,
    deletions: oldStr.split("\n"),
    additions: newStr.split("\n"),
    contextAfter,
  };
}

/** 匹配信息——描述单次编辑的位置和内容 */
export interface MatchInfo {
  /** 在原文中的字符偏移量 */
  index: number;
  /** 被替换的旧字符串 */
  oldStr: string;
  /** 替换后的新字符串 */
  newStr: string;
}

/**
 * 从多个已排序（按偏移量）的匹配构建 DiffHunk[]。
 * 上下文行被裁剪以使相邻 hunk 不重叠。
 */
export function buildMultiEditHunks(
  content: string,
  matches: MatchInfo[],
  contextLineCount: number = CONTEXT_LINES,
): DiffHunk[] {
  if (matches.length === 0) return [];

  const hunks: DiffHunk[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const hunk = buildHunkFromMatch(content, m.index, m.oldStr, m.newStr, contextLineCount);

    // 裁剪前一个 hunk 的 contextAfter 与当前 hunk 的 contextBefore，
    // 使它们不会在两次匹配之间的间隔中重叠。
    if (i > 0) {
      const prevMatch = matches[i - 1];
      const prevEnd = prevMatch.index + prevMatch.oldStr.length;
      const gap = content.slice(prevEnd, m.index);
      const gapNewlines = gap.split("\n").length - 1;
      // gapNewlines 统计换行符个数。两次编辑之间的实际内容行数
      // = gapNewlines - 1（第一个换行符只是前一个匹配行的行尾）。
      const actualContentLines = Math.max(0, gapNewlines - 1);
      const prevHunk = hunks[hunks.length - 1];

      if (actualContentLines === 0) {
        // 相邻的行 —— hunk 之间无上下文，无 ⋮
        prevHunk.contextAfter = [];
        hunk.contextBefore = [];
      } else if (actualContentLines <= contextLineCount * 2) {
        // 间隔较小 —— 在两个 hunk 之间平分内容行
        const prevAfterCount = Math.min(contextLineCount, Math.floor(actualContentLines / 2));
        const currBeforeCount = Math.min(contextLineCount, actualContentLines - prevAfterCount);
        prevHunk.contextAfter = prevHunk.contextAfter.slice(0, prevAfterCount);
        hunk.contextBefore = hunk.contextBefore.slice(
          hunk.contextBefore.length - currBeforeCount,
        );
      }
    }

    hunks.push(hunk);
  }

  return hunks;
}

/**
 * 为 append 模式构建 FileModifyDisplayData。
 */
export function buildAppendDisplayData(
  filePath: string,
  appendStr: string,
  totalLineCount: number,
): FileModifyDisplayData {
  // append 从最后一行的下一行开始
  const appendStartLine = totalLineCount + 1;
  return {
    filePath,
    language: inferLanguageByExt(filePath),
    mode: "append",
    totalLineCount,
    hunks: [{
      startLine: appendStartLine,
      contextBefore: [],
      deletions: [],
      additions: appendStr.split("\n"),
      contextAfter: [],
    }],
  };
}

/**
 * 为 write 模式构建 FileModifyDisplayData。
 */
export function buildWriteDisplayData(
  filePath: string,
  newContent: string,
  originalTotalLineCount: number,
): FileModifyDisplayData {
  return {
    filePath,
    language: inferLanguageByExt(filePath),
    mode: "write",
    totalLineCount: originalTotalLineCount,
    hunks: [],
    writeLines: newContent.split("\n"),
  };
}
