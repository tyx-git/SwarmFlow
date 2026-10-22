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

import { FILE_CONTENT_MAX_BYTES } from "./limits.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

export interface FileVersionSnapshot {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
  ino?: number;
  dev?: number;
  mode?: number;
}

export class FileVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileVersionConflictError";
  }
}

export function getFileVersionSnapshot(filePath: string): FileVersionSnapshot {
  if (!existsSync(filePath)) return { exists: false };
  const st = statSync(filePath);
  return {
    exists: true,
    mtimeMs: Math.trunc(st.mtimeMs),
    size: st.size,
    ino: typeof st.ino === "number" ? st.ino : undefined,
    dev: typeof st.dev === "number" ? st.dev : undefined,
    mode: st.mode,
  };
}

export function fileTooLargeMessage(sizeBytes: number): string {
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  return `ERROR: File too large (${sizeMB} MB, limit ${FILE_CONTENT_MAX_BYTES / 1024 / 1024} MB).`;
}

/** edit_file/write_file 在整文件读取前使用同一 50MB 上限。 */
export function existingFileTooLarge(snapshot: FileVersionSnapshot): string | null {
  if (snapshot.exists && snapshot.size !== undefined && snapshot.size > FILE_CONTENT_MAX_BYTES) {
    return fileTooLargeMessage(snapshot.size);
  }
  return null;
}

export function sameFileVersion(a: FileVersionSnapshot, b: FileVersionSnapshot): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists && !b.exists) return true;
  return (
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

export function validateExpectedMtime(
  filePath: string,
  expectedMtimeMs: number | undefined,
  current: FileVersionSnapshot,
): void {
  if (expectedMtimeMs == null) return;
  if (!current.exists) return; // new file —mtime guard is meaningless
  if (current.size === 0) return; // empty file —nothing to protect
  if (current.mtimeMs !== expectedMtimeMs) {
    throw new FileVersionConflictError(
      `File changed since last read (mtime conflict): ${filePath} ` +
      `(expected ${expectedMtimeMs}, current ${current.mtimeMs}).`,
    );
  }
}
