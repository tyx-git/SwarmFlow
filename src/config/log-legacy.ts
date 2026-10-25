/**
 * legacy log.json 读取（仅用于一次性迁移与测试夹具）。
 *
 * 运行期读取统一走 log.jsonl；不要在新代码里直接调用本模块。
 */

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import { LogIdAllocator } from "../context/entry/id-allocator.js";
import { entryFromSnake, sessionMetaFromSnake, type LoadLogResult } from "./log-codec.js";

/** 列表快路径的头部读取上限；超过则退化为整读（旧格式、首次列出时可达）。 */
export const LEGACY_HEADER_MAX_BYTES = 64 * 1024;
const ENTRIES_KEY = /"entries"\s*:\s*\[/;

/**
 * 只读 legacy log.json 的头部（entries 之前），供会话列表使用。
 *
 * 写入布局保证头部字段在 `"entries":[` 之前；找不到该键时说明格式异常或
 * 头部超限，退回整读以保持旧行为。
 */
export function readLegacyLogHeader(dir: string): Record<string, unknown> {
  const logFile = join(dir, "log.json");
  const fd = openSync(logFile, "r");
  try {
    const buffer = Buffer.alloc(LEGACY_HEADER_MAX_BYTES);
    const bytes = readSync(fd, buffer, 0, LEGACY_HEADER_MAX_BYTES, 0);
    const chunk = buffer.subarray(0, bytes).toString("utf-8");
    const match = ENTRIES_KEY.exec(chunk);
    if (!match) {
      return JSON.parse(readFileSync(logFile, "utf-8")) as Record<string, unknown>;
    }
    let prefix = chunk.slice(0, match.index).trimEnd();
    if (prefix.endsWith(",")) prefix = prefix.slice(0, -1);
    const parsed: unknown = JSON.parse(`${prefix}}`);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("legacy log.json header is not an object");
    }
    return parsed as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/** 从磁盘加载 legacy log.json。 */
export function loadLegacyLog(dir: string): LoadLogResult {
  const logFile = join(dir, "log.json");
  const raw = JSON.parse(readFileSync(logFile, "utf-8")) as Record<string, unknown>;

  const meta = sessionMetaFromSnake(raw);
  const rawEntries = (raw.entries ?? []) as Array<Record<string, unknown>>;
  const entries = rawEntries.map(entryFromSnake);

  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry ID detected: ${entry.id}`);
    }
    seenIds.add(entry.id);
  }

  const idAllocator = new LogIdAllocator();
  idAllocator.restoreFrom(entries);
  return { meta, entries, idAllocator };
}
