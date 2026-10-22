/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

import fs from "node:fs/promises";
import { statSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

import path from "node:path";

import { osCapabilities } from "../platform/index.js";

import { ToolResult } from "../providers/response.js";

import { countFileLines, buildWriteDisplayData } from "../patches/hunk.js";
import {
  getFileVersionSnapshot,
  validateExpectedMtime,
  existingFileTooLarge,
  FileVersionSnapshot,
  sameFileVersion,
  FileVersionConflictError,
} from "./file-version.js";
import { reencodeEol, detectFileEol } from "./file-edit.js";
import { buildUnifiedDiffPreview, simpleUnifiedDiff } from "./bash.js";
import { buildFileMutation } from "./mutations.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

export const FILE_WRITE_LOCKS = new Map<string, Promise<void>>();

// ======================================================================
// 工具定义（provider-agnostic JSON Schema）
// ======================================================================

export function fileWriteLockKey(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export async function withFileWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = fileWriteLockKey(filePath);
  const previous = FILE_WRITE_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  FILE_WRITE_LOCKS.set(key, chain);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (FILE_WRITE_LOCKS.get(key) === chain) {
      FILE_WRITE_LOCKS.delete(key);
    }
  }
}

// ------------------------------------------------------------------
// edit_file
// ------------------------------------------------------------------

export async function toolWriteFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
      const tooLarge = existingFileTooLarge(initialVersion);
      if (tooLarge) return tooLarge;
      const mode = initialVersion.mode;
      const before = initialVersion.exists
        ? readFileSync(filePath, { encoding: "utf-8" })
        : "";

      // Preserve the existing file's line-ending convention. The model
      // composes content with LF (read_file only ever shows LF), so
      // writing it verbatim would silently rewrite a CRLF file to LF —      // spurious git churn, broken CRLF-expecting toolchains, and a diff
      // that shows every line as changed (before's lines keep `\r`,
      // after's don't, so nothing aligns). Re-encode to the file's
      // native EOL; new files keep the content exactly as authored.
      const finalContent = initialVersion.exists
        ? reencodeEol(content, detectFileEol(before))
        : content;

      const beforeLines = before.length > 0 ? before.split("\n") : [];
      const afterLines = finalContent.length > 0 ? finalContent.split("\n") : [];
      const diffPreview = buildUnifiedDiffPreview(
        simpleUnifiedDiff(
          beforeLines,
          afterLines,
          filePath,
          filePath,
        ),
      );

      const originalTotalLineCount = countFileLines(before);
      const fileModifyData = buildWriteDisplayData(filePath, finalContent, originalTotalLineCount);

      await atomicWriteTextFile(filePath, finalContent, mode, initialVersion);

      const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
      const tuiPreview: Record<string, unknown> = {
        kind: "diff",
        text: diffPreview.text,
        truncated: diffPreview.truncated,
        newContent: finalContent,
      };
      return new ToolResult({
        content: `OK: Wrote ${finalContent.length} characters to ${filePath} [mtime_ms=${newMtimeMs}]`,
        metadata: {
          path: filePath,
          isNewFile: !initialVersion.exists,
          lineCount: afterLines.length,
          tui_preview: tuiPreview,
          fileModifyData,
          fileMutation: buildFileMutation(filePath, before, finalContent, initialVersion.exists),
        },
      });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}

export async function atomicWriteTextFile(
  filePath: string,
  content: string,
  mode?: number,
  expectedVersion?: FileVersionSnapshot,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${randomUUID()}`,
  );

  let tmpExists = false;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf-8" });
    tmpExists = true;

    if (mode !== undefined && osCapabilities.supportsPosixPermissions) {
      try {
        await fs.chmod(tmpPath, mode);
      } catch {
        // Best-effort permission preservation
      }
    }

    if (expectedVersion) {
      const currentVersion = getFileVersionSnapshot(filePath);
      if (!sameFileVersion(expectedVersion, currentVersion)) {
        throw new FileVersionConflictError(
          `File changed during write (mtime conflict): ${filePath}. Please re-read and retry.`,
        );
      }
    }

    await fs.rename(tmpPath, filePath);
    tmpExists = false;
  } finally {
    if (tmpExists) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

// ------------------------------------------------------------------
// bash
// ------------------------------------------------------------------
