/**
 * `edit` 工具结果的文件修改展示模型。
 *
 * 结果侧构建 FileModifyDisplayData（replace / write），presentation 用
 * FileModifyBody 渲染；不再承载旧工具的流式探测数据。
 */

import { extname } from "node:path";

import { splitDisplayLines } from "../lib/line-window.js";

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

/** 完整的文件修改展示数据——由 edit 结果构建，FileModifyBody 渲染。 */
export interface FileModifyDisplayData {
  /** 文件路径 */
  filePath: string;
  /** 语言标识（用于语法高亮） */
  language?: string;
  /** 模式：replace / write */
  mode: "replace" | "write";
  /** 原始文件总行数（编辑前），供展示行号使用。 */
  totalLineCount: number;
  /** 有序的 diff hunk 列表。单次编辑 = 1 个 hunk。多次编辑 = N 个 hunk。 */
  hunks: DiffHunk[];
  /** 仅 write 模式：完整文件内容行（无 hunk） */
  writeLines?: string[];
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

/**
 * 计算文件内容的行数。尾随换行符不计为额外的空行
 * （匹配编辑器约定："a\nb\n" = 2 行）。
 */
export function countFileLines(content: string): number {
  if (content.length === 0) return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
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
    writeLines: splitDisplayLines(newContent),
  };
}
