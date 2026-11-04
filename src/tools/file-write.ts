/** 文件写入基础设施：按路径串行化进程内写入并原子落盘，避免并发覆盖。 */

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

import path from "node:path";

import { osCapabilities } from "../platform/index.js";

import {
  getFileVersionSnapshot,
  FileVersionSnapshot,
  sameFileVersion,
  FileVersionConflictError,
} from "./file-version.js";

export const FILE_WRITE_LOCKS = new Map<string, Promise<void>>();

// ------------------------------------------------------------------
// 按路径串行化的写入锁
// ------------------------------------------------------------------

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
// 原子写
// ------------------------------------------------------------------

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
        // 尽力保留权限
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
        // 忽略清理失败
      }
    }
  }
}
