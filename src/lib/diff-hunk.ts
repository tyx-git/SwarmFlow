/**
 * Shared diff hunk model for file-modify tools (edit_file / write_file).
 *
 * Used by:
 *  - tool-loop.ts  (streaming context probing 鈫?best-effort hunks)
 *  - basic.ts      (tool execution 鈫?authoritative hunks)
 *  - presentation  (rendering 鈫?FileModifyBody)
 */

import { extname } from "node:path";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** A single diff hunk 鈥?one contiguous region of change in a file. */
export interface DiffHunk {
  /** 1-based line number where the first *deletion* line sits in the original file. */
  startLine: number;
  /** Context lines before the change. Empty array = no context (e.g. edit at line 1). */
  contextBefore: string[];
  /** Deleted lines (old content). */
  deletions: string[];
  /** Inserted lines (new content). */
  additions: string[];
  /** Context lines after the change. Empty array = no context (e.g. edit at last line). */
  contextAfter: string[];
}

/** Complete file-modify display data 鈥?shared by streaming and completion. */
export interface FileModifyDisplayData {
  filePath: string;
  language?: string;
  mode: "replace" | "append" | "write";
  /** Total line count of the original file (before edit). Used for 鈰?decisions. */
  totalLineCount: number;
  /** Ordered list of diff hunks. Single-edit = 1 hunk. Multi-edit = N hunks. */
  hunks: DiffHunk[];
  /** For write mode only: the full file content lines (no hunks). */
  writeLines?: string[];
}

/** Per-edit probing state kept in PendingToolCallState during streaming. */
export interface EditProbeState {
  resolved: boolean;
  matchOffset?: number;
  startLine?: number;
  contextBefore?: string[];
  contextAfter?: string[];
}

// ------------------------------------------------------------------
// Language inference
// ------------------------------------------------------------------

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

/** Infer highlight.js language from a file path's extension. */
export function inferLanguageByExt(filePath: string): string | undefined {
  return LANGUAGE_BY_EXT[extname(filePath).toLowerCase()];
}

// ------------------------------------------------------------------
// Context computation
// ------------------------------------------------------------------

/**
 * Extract up to `maxLines` context lines immediately before `offset` in `content`.
 * Returns lines in document order. Returns empty array if offset is at the start
 * of the file (no lines above).
 */
export function computeContextBefore(
  content: string,
  offset: number,
  maxLines: number,
): string[] {
  if (offset <= 0) return [];
  // Find the newline just before offset (the end of the preceding line)
  const precedingNewline = content.lastIndexOf("\n", offset - 1);
  if (precedingNewline < 0) return []; // offset is on line 1, no context above

  // Walk backwards collecting lines
  const lines: string[] = [];
  let lineEnd = precedingNewline;
  for (let i = 0; i < maxLines; i++) {
    const lineStart = content.lastIndexOf("\n", lineEnd - 1) + 1;
    lines.push(content.slice(lineStart, lineEnd));
    lineEnd = lineStart - 1;
    if (lineEnd < 0) break; // reached start of file
  }
  lines.reverse();
  return lines;
}

/**
 * Extract up to `maxLines` context lines immediately after the region ending
 * at `offset` in `content`. Returns lines in document order. Returns empty
 * array if offset is at or past the end of the file.
 */
export function computeContextAfter(
  content: string,
  offset: number,
  maxLines: number,
): string[] {
  if (offset >= content.length) return [];
  // Find the newline at or after offset (end of the line containing offset)
  const firstNewline = content.indexOf("\n", offset);
  if (firstNewline < 0) return []; // no newline after 鈫?offset is on the last line

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
 * Count lines in file content. A trailing newline does NOT count as an extra
 * empty line (matches editor convention: "a\nb\n" = 2 lines).
 */
export function countFileLines(content: string): number {
  if (content.length === 0) return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

// ------------------------------------------------------------------
// Hunk builders
// ------------------------------------------------------------------

const CONTEXT_LINES = 3;

/**
 * Build a single DiffHunk from a match in the original file content.
 * Used for single-edit and as a building block for multi-edit.
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

export interface MatchInfo {
  index: number;
  oldStr: string;
  newStr: string;
}

/**
 * Build DiffHunk[] from multiple sorted (by offset) matches.
 * Context lines are clamped so adjacent hunks don't overlap.
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

    // Clamp contextAfter of previous hunk and contextBefore of this hunk
    // so they don't overlap in the gap between matches.
    if (i > 0) {
      const prevMatch = matches[i - 1];
      const prevEnd = prevMatch.index + prevMatch.oldStr.length;
      const gap = content.slice(prevEnd, m.index);
      const gapNewlines = gap.split("\n").length - 1;
      // gapNewlines counts newline characters. Actual content lines between
      // the two edits = gapNewlines - 1 (the first newline is just the line
      // break ending the previous match's line).
      const actualContentLines = Math.max(0, gapNewlines - 1);
      const prevHunk = hunks[hunks.length - 1];

      if (actualContentLines === 0) {
        // Adjacent lines 鈥?no context between hunks, no 鈰?        prevHunk.contextAfter = [];
        hunk.contextBefore = [];
      } else if (actualContentLines <= contextLineCount * 2) {
        // Small gap 鈥?split content lines between the two hunks
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
 * Build FileModifyDisplayData for append mode.
 */
export function buildAppendDisplayData(
  filePath: string,
  appendStr: string,
  totalLineCount: number,
): FileModifyDisplayData {
  // Append starts at the line after the last existing line
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
 * Build FileModifyDisplayData for write mode.
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
