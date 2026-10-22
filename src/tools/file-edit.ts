/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

import fs from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";

import path from "node:path";

import { ToolResult } from "../providers/response.js";

import {
  type FileModifyDisplayData,
  type MatchInfo,
  inferLanguageByExt,
  countFileLines,
  buildMultiEditHunks,
  buildAppendDisplayData,
} from "../patches/hunk.js";
import { withFileWriteLock, atomicWriteTextFile } from "./file-write.js";
import {
  FileVersionSnapshot,
  getFileVersionSnapshot,
  validateExpectedMtime,
  existingFileTooLarge,
} from "./file-version.js";
import { buildUnifiedDiffPreview, simpleUnifiedDiff } from "./bash.js";
import { buildFileMutation } from "./mutations.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

export async function toolEditFileAppend(
  filePath: string,
  appendStr: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    if (!existsSync(filePath)) {
      return `ERROR: File not found: ${filePath}`;
    }

    let initialVersion: FileVersionSnapshot;
    try {
      initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    const tooLarge = existingFileTooLarge(initialVersion);
    if (tooLarge) return tooLarge;

    let before: string;
    try {
      before = readFileSync(filePath, { encoding: "utf-8" });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const totalLineCount = countFileLines(before);
    // Re-encode the appended text to the file's existing EOL so appending
    // model-authored LF text to a CRLF file doesn't seed mixed line
    // endings (the same churn write_file/edit_file guard against).
    const finalContent = before + reencodeEol(appendStr, detectFileEol(before));

    const beforeLines = before.length > 0 ? before.split("\n") : [];
    const afterLines = finalContent.length > 0 ? finalContent.split("\n") : [];
    const diffPreview = buildUnifiedDiffPreview(
      simpleUnifiedDiff(beforeLines, afterLines, filePath, filePath),
    );

    const fileModifyData = buildAppendDisplayData(filePath, appendStr, totalLineCount);

    try {
      await atomicWriteTextFile(filePath, finalContent, initialVersion.mode, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
    return new ToolResult({
      content: `OK: Appended ${appendStr.length} characters to ${filePath} [mtime_ms=${newMtimeMs}]`,
      metadata: {
        path: filePath,
        isAppend: true,
        lineCount: afterLines.length,
        tui_preview: {
          kind: "diff",
          text: diffPreview.text,
          truncated: diffPreview.truncated,
        },
        fileModifyData,
        fileMutation: buildFileMutation(filePath, before, finalContent, true),
      },
    });
  });
}

// ------------------------------------------------------------------
// edit_file multi-edit
// ------------------------------------------------------------------

/** 在 haystack 中查找 needle 的所有出现位置，以字符偏移量表示。 */
export function findAllOffsets(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/**
 * `content` 中每个换行符偏移量的排序列表。与
 * `offsetToLineWithIndex` 配对，将字符偏移量转换为
 * O(log n) 每查询的行号 — 由 edit_file 的歧义匹配错误路径使用，
 * 以避免每个重复匹配扫描文件一次。
 */
export function buildNewlineIndex(content: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") out.push(i);
  }
  return out;
}

/** 通过预建的换行符索引将字符偏移量转换为 1索引的行号。 */
export function offsetToLineWithIndex(newlineIndex: readonly number[], offset: number): number {
  // Count of newlines strictly before `offset` (binary search).
  let lo = 0;
  let hi = newlineIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (newlineIndex[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** 截断片段以包含在错误消息中。 */
export function snippetFor(s: string, maxLen = 60): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "—" : s;
}

/**
 * 文件内容的主要换行符，通过多数投票决定。
 * 只有当 CRLF 行超过单独的 LF 行时，文件才被视为 CRLF。
 * "任何 CRLF 存在" 太激进：一个单独的零散 CRLF 在本应是 LF 的文件中，
 * 会迫使模型的 LF old_str 变成 CRLF，然后什么都匹配不到 —
 * 编辑静默失败，而 read_file 显示纯 LF 内容，
 * 所以模型看不到 CR，也无法自我修正。
 */
export function detectFileEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const loneLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > loneLf ? "\r\n" : "\n";
}

/**
 * 将字符串的换行符重新编码为目标文件的约定。
 * read_file 将内容呈现为纯 LF（它会剥离 CR），所以从该输出复制的
 * 多行 old_str 即使磁盘上的文件是 CRLF 也是 LF — 这样就永远无法进行字面字节匹配。
 * 首先规范化 CRLF→LF 使其无论调用者传递什么都是幂等的。
 * 也应用于 new_str，所以替换会保留文件的现有 EOL，
 * 而不是将单独的 LF 行植入 CRLF 文件。
 */
export function reencodeEol(s: string, eol: "\r\n" | "\n"): string {
  const lf = s.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

export async function toolEditFileMulti(
  filePath: string,
  edits: Array<{ old_str: string; new_str: string; replace_all?: boolean }>,
  expectedMtimeMs?: number,
  appendStr?: string,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    if (!existsSync(filePath)) {
      return `ERROR: File not found: ${filePath}`;
    }

    let initialVersion: FileVersionSnapshot;
    try {
      initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    const tooLarge = existingFileTooLarge(initialVersion);
    if (tooLarge) return tooLarge;

    let content: string;
    try {
      content = readFileSync(filePath, { encoding: "utf-8" });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    // read_file shows LF-only content, so a multi-line old_str echoed
    // back by the model is LF even when the file is CRLF. Re-encode each
    // edit's strings to the file's actual EOL before matching/replacing,
    // so multi-line edits work on CRLF (Windows-authored) files and the
    // replacement keeps the file's line-ending convention.
    const fileEol = detectFileEol(content);

    // Find all matches; validate uniqueness unless replace_all is opted in.
    // No-op edits (old_str === new_str) are rejected so the model doesn't
    // confuse itself with diffs that don't change anything.
    // Lazily build a newline index —only when we actually need to format
    // an ambiguous-match error. Avoids scanning the file on the happy path.
    let newlineIndex: number[] | null = null;
    const lineOf = (offset: number): number => {
      if (!newlineIndex) newlineIndex = buildNewlineIndex(content);
      return offsetToLineWithIndex(newlineIndex, offset);
    };

    const matches: MatchInfo[] = [];
    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
      const edit = edits[editIdx];
      // Match and replace using the file's EOL; report errors with the
      // model's original (LF) strings so messages stay readable.
      const oldStr = reencodeEol(edit.old_str, fileEol);
      const newStr = reencodeEol(edit.new_str, fileEol);
      if (oldStr === newStr) {
        return (
          `ERROR: edit #${editIdx + 1} has identical old_str and new_str —` +
          `this is a no-op. Adjust new_str or remove the edit.`
        );
      }
      const offsets = findAllOffsets(content, oldStr);
      if (offsets.length === 0) {
        return `ERROR: edit #${editIdx + 1}: old_str not found in file: ${JSON.stringify(snippetFor(edit.old_str))}`;
      }
      if (offsets.length > 1 && !edit.replace_all) {
        const lines = offsets.map(lineOf);
        const lineList = lines.length > 6
          ? lines.slice(0, 6).join(", ") + `, —(${lines.length} total)`
          : lines.join(", ");
        return (
          `ERROR: edit #${editIdx + 1}: old_str appears ${offsets.length} times ` +
          `(at lines ${lineList}). ` +
          `Either add more surrounding context to make the match unique, ` +
          `or pass replace_all: true on this edit to replace every occurrence. ` +
          `old_str: ${JSON.stringify(snippetFor(edit.old_str))}`
        );
      }
      // Push every occurrence (single match by default, all matches when replace_all).
      for (const off of offsets) {
        matches.push({
          index: off,
          oldStr,
          newStr,
        });
      }
    }

    // Sort by offset ascending for overlap check
    matches.sort((a, b) => a.index - b.index);

    // Check overlaps
    for (let i = 1; i < matches.length; i++) {
      const prev = matches[i - 1];
      if (prev.index + prev.oldStr.length > matches[i].index) {
        return `ERROR: edits overlap at offset ${matches[i].index}`;
      }
    }

    // Apply replacements from bottom to top (reverse offset order)
    let newContent = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      newContent = newContent.slice(0, m.index) + m.newStr + newContent.slice(m.index + m.oldStr.length);
    }

    // Append always executes last, after all replacements. Re-encode to
    // the file's EOL so an LF append doesn't seed mixed endings in a CRLF
    // file (consistent with the old_str/new_str re-encoding above).
    if (appendStr) {
      newContent += reencodeEol(appendStr, fileEol);
    }

    const totalLineCount = countFileLines(content);
    const hunks = buildMultiEditHunks(content, matches);

    // If append, add an append hunk at the end
    if (appendStr) {
      const appendStartLine = countFileLines(newContent) - countFileLines(appendStr) + 1;
      hunks.push({
        startLine: appendStartLine,
        contextBefore: [],
        deletions: [],
        additions: appendStr.split("\n"),
        contextAfter: [],
      });
    }

    const diffPreview = buildUnifiedDiffPreview(
      simpleUnifiedDiff(
        content.split("\n"),
        newContent.split("\n"),
        filePath,
        filePath,
      ),
    );

    const fileModifyData: FileModifyDisplayData = {
      filePath,
      language: inferLanguageByExt(filePath),
      mode: "replace",
      totalLineCount,
      hunks,
    };

    try {
      await atomicWriteTextFile(filePath, newContent, initialVersion.mode, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const parts = [`${edits.length} edits applied`];
    if (appendStr) parts.push(`${appendStr.length} chars appended`);
    const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
    return new ToolResult({
      content: `OK: ${parts.join(", ")}. [mtime_ms=${newMtimeMs}]`,
      metadata: {
        path: filePath,
        tui_preview: {
          kind: "diff",
          text: diffPreview.text,
          truncated: diffPreview.truncated,
        },
        fileModifyData,
        fileMutation: buildFileMutation(filePath, content, newContent, true),
      },
    });
  });
}

// ------------------------------------------------------------------
// write_file
// ------------------------------------------------------------------
