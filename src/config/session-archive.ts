/**
 * 冷会话归档：显式命令把整个会话目录搬到 `archived_sessions/`，并把活动日志 gzip；
 * restore 时逐字还原。不做 zstd、不按时间自动搬迁（任务 §6 的边界）。
 *
 * 目录布局（与 projects/ 同级，保证 rename 不跨卷）：
 *   <base>/archived_sessions/<project_slug>/<session_id>/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { acquireSessionLock, releaseSessionLock } from "./session-lock.js";

export const COLD_ARCHIVE_DIR = "archived_sessions";

/** 活动日志的候选名；legacy 会话只有 log.json。 */
const ACTIVE_LOG_FILES = ["log.jsonl", "log.json"] as const;
export type ActiveLogName = (typeof ACTIVE_LOG_FILES)[number];

export interface ColdArchiveMove {
  from: string;
  to: string;
  logFile: ActiveLogName;
  logBytes: number;
  compressedBytes: number;
}

export interface ColdRestoreMove {
  from: string;
  to: string;
  logFile: ActiveLogName;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findActiveLog(dir: string): ActiveLogName | undefined {
  for (const name of ACTIVE_LOG_FILES) {
    if (existsSync(join(dir, name))) return name;
  }
  return undefined;
}

/** 写/清 meta.json 的 archived 标志；保留其余字段。 */
function writeArchivedFlag(dir: string, archived: boolean): void {
  const file = join(dir, "meta.json");
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch { /* 缺失或损坏时只写标志 */ }
  if (archived) raw["archived"] = true;
  else delete raw["archived"];
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(raw));
  renameSync(tmp, file);
}

/**
 * 归档一个会话目录。先整体搬迁（同卷 rename），再压缩活动日志并置 archived 标志。
 * 压缩顺序是“写 .gz → rename → 删明文”，中途崩溃最多留下明文与 .gz 并存，restore 可处理。
 */
export function archiveSessionDir(sessionDir: string): ColdArchiveMove {
  if (!isDirectory(sessionDir)) throw new Error(`不是会话目录：${sessionDir}`);

  const projectDir = dirname(sessionDir);
  const projectsRoot = dirname(projectDir);
  if (basename(projectsRoot) !== "projects") {
    throw new Error(`会话不在 projects/ 下：${sessionDir}`);
  }
  const baseDir = dirname(projectsRoot);
  const archiveDir = join(baseDir, COLD_ARCHIVE_DIR, basename(projectDir), basename(sessionDir));
  const lockToken = `cold-archive-${randomUUID()}`;
  const lock = acquireSessionLock(sessionDir, lockToken);
  if (!lock.ok) throw new Error(`会话正在被其他写者使用：${sessionDir}`);

  let lockDir = sessionDir;
  try {
    if (existsSync(archiveDir)) throw new Error(`已存在归档：${archiveDir}`);

    const logFile = findActiveLog(sessionDir);
    if (!logFile) throw new Error(`会话缺少活动日志：${sessionDir}`);

    // 压缩放在搬迁之前：失败时目录原地不动，不需要回滚。
    const before = readFileSync(join(sessionDir, logFile));
    const compressed = gzipSync(before);

    mkdirSync(dirname(archiveDir), { recursive: true });
    renameSync(sessionDir, archiveDir);
    lockDir = archiveDir;

    const logPath = join(archiveDir, logFile);
    try {
      const gzPath = `${logPath}.gz`;
      const tmp = `${gzPath}.tmp-${process.pid}`;
      writeFileSync(tmp, compressed);
      renameSync(tmp, gzPath);
      // 先置标志、再删明文：任何一步失败时明文仍在，可以整体回滚。
      writeArchivedFlag(archiveDir, true);
      unlinkSync(logPath);
    } catch (error) {
      if (existsSync(logPath)) {
        try {
          renameSync(archiveDir, sessionDir);
          lockDir = sessionDir;
        } catch {
          // 回滚失败：至少保留归档目录（明文仍在），restore 仍可还原。
        }
      }
      throw error;
    }

    return {
      from: sessionDir,
      to: archiveDir,
      logFile,
      logBytes: before.length,
      compressedBytes: compressed.length,
    };
  } finally {
    releaseSessionLock(lockDir, lockToken);
  }
}

/**
 * 从一个 archived_sessions 目录还原会话：先物化明文并清标志，再搬回 projects/。
 * 目标已存在时在动任何文件之前拒绝。
 */
export function restoreSessionDir(archiveDir: string): ColdRestoreMove {
  if (!isDirectory(archiveDir)) throw new Error(`不是归档目录：${archiveDir}`);

  const archiveRoot = dirname(dirname(archiveDir));
  if (basename(archiveRoot) !== COLD_ARCHIVE_DIR) {
    throw new Error(`目录不在 ${COLD_ARCHIVE_DIR}/ 下：${archiveDir}`);
  }
  const projectSlug = basename(dirname(archiveDir));
  const sessionId = basename(archiveDir);
  const baseDir = dirname(archiveRoot);
  const target = join(baseDir, "projects", projectSlug, sessionId);
  if (existsSync(target)) throw new Error(`恢复目标已存在：${target}`);

  const logFile = expandActiveLog(archiveDir);
  writeArchivedFlag(archiveDir, false);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(archiveDir, target);
  return { from: archiveDir, to: target, logFile };
}

/** 解压活动日志；明文与 .gz 并存时以明文为准（上次归档在中途崩溃）。 */
function expandActiveLog(dir: string): ActiveLogName {
  for (const name of ACTIVE_LOG_FILES) {
    const gzPath = join(dir, `${name}.gz`);
    if (!existsSync(gzPath)) continue;
    const plainPath = join(dir, name);
    if (!existsSync(plainPath)) {
      const buf = gunzipSync(readFileSync(gzPath));
      const tmp = `${plainPath}.tmp-${process.pid}`;
      writeFileSync(tmp, buf);
      renameSync(tmp, plainPath);
    }
    rmSync(gzPath, { force: true });
    return name;
  }
  throw new Error(`归档缺少压缩日志：${dir}`);
}
