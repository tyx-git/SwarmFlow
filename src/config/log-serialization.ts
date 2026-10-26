/**
 * 会话日志的持久化入口。
 *
 * 运行期读取：优先 log.jsonl；只有 legacy log.json 时先一次性迁移。
 * legacy 写入 saveLog 仅保留给迁移夹具/测试；运行期保存走 Session.persistToDisk。
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { LogEntry } from "../context/entry/types.js";
import { buildLogHead, entryToSnake } from "./log-codec.js";
import { loadLegacyLog } from "./log-legacy.js";
import { LOG_JSONL_FILENAME, loadLogJsonl, migrateLogToJsonl } from "./log-jsonl.js";
import { saveSessionMeta, type LogSessionMeta } from "./session-meta.js";
import { nowTimestamps, isSameUtcMinute } from "./timestamps.js";

export type { LoadLogResult } from "./log-codec.js";

/** 更新项目元数据中的最后活跃时间（跨分钟才写，避免检查点反复重写） */
function updateProjectLastActive(projectDir: string, lastActiveAt: string): boolean {
  const projectJson = join(projectDir, "project.json");
  if (!existsSync(projectJson)) return true;
  try {
    const raw = JSON.parse(readFileSync(projectJson, "utf-8"));
    if (isSameUtcMinute(raw.last_active_at, lastActiveAt)) return true;
    raw.last_active_at = lastActiveAt;
    const tmp = projectJson + ".tmp";
    writeFileSync(tmp, JSON.stringify(raw));
    renameSync(tmp, projectJson);
    return true;
  } catch {
    return false;
  }
}

/**
 * 分块写入日志 JSON。
 *
 * 不在内存里拼出整份日志字符串：头部序列化一次，条目逐条序列化并
 * 按约 1 MiB 批量落盘。峰值从"整份日志"降到"单条 + 写缓冲"。
 * 输出与 JSON.stringify({...head, entries}) 等价（紧凑格式）。
 */
function writeLogFile(
  file: string,
  payloadHead: Record<string, unknown>,
  entries: readonly LogEntry[],
): void {
  const fd = openSync(file, "w");
  try {
    const head = JSON.stringify(payloadHead);
    const chunks: string[] = [head.slice(0, -1) + ',"entries":['];
    let pendingChars = 0;
    let first = true;
    for (const entry of entries) {
      // 标记为 meta.ephemeral === true 的条目仅存在于内存中（例如 /fork
      // 来源指针）；它们会到达 TUI 但永远不会持久化。
      if (entry.meta?.["ephemeral"]) continue;
      const json = JSON.stringify(entryToSnake(entry));
      const piece = first ? json : "," + json;
      first = false;
      chunks.push(piece);
      pendingChars += piece.length;
      if (pendingChars >= 1 << 20) {
        writeSync(fd, chunks.join(""));
        chunks.length = 0;
        pendingChars = 0;
      }
    }
    chunks.push("]}");
    writeSync(fd, chunks.join(""));
  } finally {
    closeSync(fd);
  }
}

/** 写 meta.json 与 project.json（JSONL 保存与 legacy 保存共用）。 */
export function saveSessionSidecars(dir: string, meta: LogSessionMeta): boolean {
  const now = nowTimestamps();
  meta.updatedAt = now.utcIso;
  if (!meta.createdAt) meta.createdAt = now.utcIso;
  if (!meta.sessionId) meta.sessionId = basename(dir);

  let ok = true;
  try {
    saveSessionMeta(dir, meta);
  } catch {
    ok = false;
  }
  if (!updateProjectLastActive(dirname(dir), meta.updatedAt)) ok = false;
  return ok;
}

/** legacy 保存（仅迁移/测试夹具使用）。 */
export function saveLog(
  dir: string,
  meta: LogSessionMeta,
  entries: LogEntry[],
): void {
  const now = nowTimestamps();
  meta.updatedAt = now.utcIso;
  if (!meta.createdAt) meta.createdAt = now.utcIso;
  if (!meta.sessionId) meta.sessionId = basename(dir);

  const logFile = join(dir, "log.json");
  const tmp = logFile + ".tmp";
  writeLogFile(tmp, buildLogHead(meta), entries);
  renameSync(tmp, logFile);

  saveSessionSidecars(dir, meta);
}

/**
 * 读取会话日志：log.jsonl 优先；只有 legacy log.json 时先迁移再读。
 * 迁移失败会抛错，不保留双读回退。
 */
export function loadLog(dir: string) {
  const jsonlPath = join(dir, LOG_JSONL_FILENAME);
  let result;
  if (existsSync(jsonlPath)) {
    result = loadLogJsonl(dir);
  } else {
    const legacyPath = join(dir, "log.json");
    if (!existsSync(legacyPath)) {
      throw new Error(`No ${LOG_JSONL_FILENAME} or log.json found in ${dir}`);
    }
    migrateLogToJsonl(dir);
    result = loadLogJsonl(dir);
  }
  return result;
}

/** 仅供迁移/测试直接读 legacy 格式。 */
export { loadLegacyLog };
