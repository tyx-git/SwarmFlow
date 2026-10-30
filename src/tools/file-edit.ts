/** edit_file 执行器：精确匹配替换与多处编辑，保留文件原有 EOL。 */

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
    // 把追加文本重编码成文件既有的 EOL，免得向 CRLF 文件追加模型写的
    // LF 文本时留下混合换行（write_file / edit_file 都在防这种噪音）。
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
// edit_file 多处编辑
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
  // 严格位于 `offset` 之前的换行符数量（二分查找）。
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

    // read_file 只呈现 LF，所以模型回传的多行 old_str 都是 LF，即使文件是 CRLF。
    // 匹配/替换前先把每次编辑的字符串重编码成文件实际的 EOL，
    // 多行编辑才在 CRLF（Windows 写出）文件上也能生效，
    // 替换结果也沿用文件原有的换行约定。
    const fileEol = detectFileEol(content);

    // 找出所有匹配；未显式 replace_all 时校验唯一性。
    // old_str === new_str 的空编辑直接拒绝，免得模型被没有变化的 diff 绕晕。
    // 换行符索引按需构建——只在确实要格式化「匹配不唯一」的错误时创建，
    // 正常路径上不扫全文件。
    let newlineIndex: number[] | null = null;
    const lineOf = (offset: number): number => {
      if (!newlineIndex) newlineIndex = buildNewlineIndex(content);
      return offsetToLineWithIndex(newlineIndex, offset);
    };

    const matches: MatchInfo[] = [];
    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
      const edit = edits[editIdx];
      // 按文件的 EOL 匹配与替换；报错时用模型原始的（LF）字符串，
      // 保证提示好读。
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
      // 收集每一处出现（默认单处，replace_all 时全部）。
      for (const off of offsets) {
        matches.push({
          index: off,
          oldStr,
          newStr,
        });
      }
    }

    // 按偏移升序排序，便于检查重叠
    matches.sort((a, b) => a.index - b.index);

    // 检查重叠
    for (let i = 1; i < matches.length; i++) {
      const prev = matches[i - 1];
      if (prev.index + prev.oldStr.length > matches[i].index) {
        return `ERROR: edits overlap at offset ${matches[i].index}`;
      }
    }

    // 从后往前替换（偏移倒序），避免前面的改动移动后面的位置
    let newContent = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      newContent = newContent.slice(0, m.index) + m.newStr + newContent.slice(m.index + m.oldStr.length);
    }

    // append 总在所有替换之后执行。同样重编码成文件的 EOL，
    // 免得 LF 追加在 CRLF 文件里留下混合换行
    //（与上面的 old_str/new_str 重编码保持一致）。
    if (appendStr) {
      newContent += reencodeEol(appendStr, fileEol);
    }

    const totalLineCount = countFileLines(content);
    const hunks = buildMultiEditHunks(content, matches);

    // 有追加时，在末尾补一个 append hunk
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
