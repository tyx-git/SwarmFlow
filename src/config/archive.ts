/**
 * 压缩上下文窗口的归档文件（archive/window-<n>.json.gz）读写。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { LogEntry } from "../context/entry/types.js";

// ------------------------------------------------------------------
// 归档窗口
// ------------------------------------------------------------------

/** 将归档条目压缩并写入归档文件 */
function writeArchiveFile(
  dir: string,
  fileName: string,
  archived: Array<{ id: string; content: unknown }>,
): void {
  const archiveDir = join(dir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const json = JSON.stringify(archived);
  const compressed = gzipSync(Buffer.from(json));
  writeFileSync(join(archiveDir, fileName), compressed);
}

/** 归档指定窗口范围内的日志条目内容到压缩文件 */
export function archiveWindow(
  dir: string,
  windowIndex: number,
  entries: LogEntry[],
  windowStartIdx: number,
  windowEndIdx: number,
): void {
  const targets: LogEntry[] = [];
  for (let i = windowStartIdx; i <= windowEndIdx && i < entries.length; i++) {
    const e = entries[i];
    if (e.content !== null && !e.archived) targets.push(e);
  }
  // 先写入，后剥离——写入失败时必须保留内容
  // （没有归档文件的已剥离条目无法恢复）。
  writeArchiveFile(
    dir,
    `window-${windowIndex}.json.gz`,
    targets.map((e) => ({ id: e.id, content: e.content })),
  );
  for (const e of targets) {
    e.content = null;
    e.archived = true;
  }
}

/** 加载指定窗口索引的归档文件 */
export function loadArchive(
  dir: string,
  windowIndex: number,
): Array<{ id: string; content: unknown }> {
  const archiveFile = join(dir, "archive", `window-${windowIndex}.json.gz`);
  const compressed = readFileSync(archiveFile);
  const json = gunzipSync(compressed).toString("utf-8");
  return JSON.parse(json);
}

/**
 * 按名称加载归档文件。文件不存在时返回 null
 * （例如由旧版二进制写入的归档，或已被修剪的会话目录）
 * ——调用者会降级为保留条目的归档状态。
 */
export function loadArchiveFile(
  dir: string,
  fileName: string,
): Array<{ id: string; content: unknown }> | null {
  const archiveFile = join(dir, "archive", fileName);
  if (!existsSync(archiveFile)) return null;
  const compressed = readFileSync(archiveFile);
  const json = gunzipSync(compressed).toString("utf-8");
  return JSON.parse(json);
}

/**
 * 将归档内容恢复回条目中（仅内存中）。恢复的条目会丢弃其归档标志，
 * 以便重新进入 API 投影，并可被后续的摘要/压缩重新归档。
 */
export function restoreArchiveToEntries(
  entries: LogEntry[],
  archived: Array<{ id: string; content: unknown }>,
): void {
  const contentMap = new Map(archived.map((a) => [a.id, a.content]));
  for (const e of entries) {
    if (e.archived && contentMap.has(e.id)) {
      e.content = contentMap.get(e.id)!;
      e.archived = false;
    }
  }
}
