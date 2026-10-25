/**
 * D22：显式 prune 会话日志的已归档前缀。
 *
 * 只删除最后一个 live compact_marker 之前、且满足以下之一的条目：
 * - discarded；
 * - archive/ 中有正文副本；
 * - 旧 compact_marker（结构锚点，正文为空）。
 * system_prompt 保留；其他无副本条目会让整次 prune 拒绝执行。
 * 重写是原子的；archive/artifacts/sealed 不删除，只在结果中报告体积。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadArchivedContentIds } from "../config/archive.js";
import { loadLogJsonl, writeLogJsonlSnapshot } from "../config/log-jsonl.js";
import type { LogEntry } from "../context/entry/types.js";
import { deleteTurnIndex } from "./turn-index.js";

export interface PruneSessionOptions {
  dryRun?: boolean;
  /** 只有日志超过该字节数才 prune；缺省总是尝试。 */
  maxLogBytes?: number;
}

export type PruneSessionResult =
  | {
    ok: true;
    pruned: boolean;
    dryRun: boolean;
    reason?: "no-log-jsonl" | "no-live-marker" | "nothing-to-prune" | "below-threshold";
    entriesBefore: number;
    entriesAfter: number;
    droppedEntries: number;
    droppedUserTurns: number[];
    logBytesBefore: number;
    logBytesAfter?: number;
    archiveBytes: number;
    artifactsBytes: number;
    sealedBytes: number;
  }
  | { ok: false; error: string };

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  try {
    for (const name of readdirSync(path)) {
      const target = join(path, name);
      try {
        const stat = statSync(target);
        total += stat.isDirectory() ? directoryBytes(target) : stat.size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function isUserTurnEntry(entry: LogEntry): boolean {
  const meta = entry.meta as Record<string, unknown>;
  if (entry.type === "input_received") return meta.inputKind === "user";
  if (entry.type === "turn_start") return meta.turnKind === "user";
  return false;
}

function commonReport(dir: string, entriesBefore: number, logBytesBefore: number) {
  return {
    entriesBefore,
    logBytesBefore,
    archiveBytes: directoryBytes(join(dir, "archive")),
    artifactsBytes: directoryBytes(join(dir, "artifacts")),
    sealedBytes: directoryBytes(join(dir, "sealed")),
  };
}

/** 对一个会话目录执行 prune（调用方负责锁与活动会话检查）。 */
export function pruneSessionDirectory(
  dir: string,
  opts: PruneSessionOptions = {},
): PruneSessionResult {
  if (!existsSync(join(dir, "log.jsonl"))) {
    return { ok: false, error: "只有 log.jsonl 会话支持 prune；legacy log.json 请先打开一次完成迁移。" };
  }

  let loaded: ReturnType<typeof loadLogJsonl>;
  try {
    loaded = loadLogJsonl(dir);
  } catch (error) {
    return { ok: false, error: `无法读取会话日志：${error instanceof Error ? error.message : String(error)}` };
  }
  const entries = loaded.entries;
  const logPath = join(dir, "log.jsonl");
  const logBytesBefore = statSync(logPath).size;
  const report = commonReport(dir, entries.length, logBytesBefore);

  let markerIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compact_marker" && !entries[index]?.discarded) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) {
    return { ok: true, pruned: false, dryRun: opts.dryRun === true, reason: "no-live-marker", entriesAfter: entries.length, droppedEntries: 0, droppedUserTurns: [], ...report };
  }
  if (opts.maxLogBytes !== undefined && logBytesBefore <= opts.maxLogBytes) {
    return { ok: true, pruned: false, dryRun: opts.dryRun === true, reason: "below-threshold", entriesAfter: entries.length, droppedEntries: 0, droppedUserTurns: [], ...report };
  }

  const archivedIds = loadArchivedContentIds(dir);
  const dropIndexes = new Set<number>();
  for (let index = 0; index < markerIndex; index += 1) {
    const entry = entries[index]!;
    if (entry.type === "system_prompt") continue;
    if (
      entry.discarded
      || entry.content === null
      || entry.type === "compact_marker"
      || archivedIds.has(entry.id)
    ) {
      // content 已为 null 的条目没有正文可丢（turn_start/turn_end 等结构条目）。
      dropIndexes.add(index);
      continue;
    }
    return {
      ok: false,
      error: `拒绝 prune：${entry.id} (${entry.type}) 在最后一个 marker 前且没有归档正文副本。`,
    };
  }

  const droppedEntries = dropIndexes.size;
  if (droppedEntries === 0) {
    return { ok: true, pruned: false, dryRun: opts.dryRun === true, reason: "nothing-to-prune", entriesAfter: entries.length, droppedEntries: 0, droppedUserTurns: [], ...report };
  }

  const droppedUserTurns = [...new Set(
    [...dropIndexes]
      .map((index) => entries[index]!)
      .filter(isUserTurnEntry)
      .map((entry) => entry.turnIndex),
  )].sort((a, b) => a - b);

  const kept = entries.filter((_entry, index) => index >= markerIndex || !dropIndexes.has(index));
  if (opts.dryRun) {
    return {
      ok: true,
      pruned: true,
      dryRun: true,
      entriesAfter: kept.length,
      droppedEntries,
      droppedUserTurns,
      ...report,
    };
  }

  try {
    writeLogJsonlSnapshot(dir, loaded.meta, kept);
  } catch (error) {
    return { ok: false, error: `重写日志失败：${error instanceof Error ? error.message : String(error)}` };
  }
  deleteTurnIndex(dir);
  return {
    ok: true,
    pruned: true,
    dryRun: false,
    entriesAfter: kept.length,
    droppedEntries,
    droppedUserTurns,
    logBytesAfter: statSync(logPath).size,
    ...report,
  };
}
