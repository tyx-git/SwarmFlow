/**
 * 一次性离线迁移：旧 marker/context + window-N.json.gz → checkpoint 格式。
 *
 * 只由 CLI `sessions migrate-compact` 调用，不进入运行时读取路径。
 * 迁移成功后才删除旧归档；log.jsonl 先写备份，再原子替换。
 */

import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import {
  LOG_JSONL_FILENAME,
  migrateLogToJsonl,
  readRecords,
  replayRecords,
  writeLogJsonlSnapshot,
  type JsonlRecord,
} from "../config/log-jsonl.js";
import { readGzipJson } from "../config/gzip-json.js";
import { writeArchiveEnvelopeForMigration } from "../config/archive.js";
import type { ArchivedEntryRecord, ArchivedTurnInfo, ArchivedWindowIndex } from "../config/archive.js";
import { sessionMetaFromSnake } from "../config/log-codec.js";
import { saveSessionMeta, type LogSessionMeta } from "../config/session-meta.js";
import type { LogEntry } from "../context/entry/types.js";

export interface CompactMigrationResult {
  migrated: boolean;
  checkpoints: number;
  archivesMigrated: number;
  backups: string[];
}

const LEGACY_LOG_JSONL_VERSION = 4;

function readLegacyV4Records(dir: string): JsonlRecord[] {
  const raw = readFileSync(join(dir, LOG_JSONL_FILENAME), "utf-8");
  const records: JsonlRecord[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Legacy log.jsonl line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Legacy log.jsonl line ${index + 1} is not a record.`);
    }
    const record = value as Record<string, unknown>;
    if (record["v"] !== LEGACY_LOG_JSONL_VERSION) {
      throw new Error(`Legacy log.jsonl line ${index + 1} is not version ${LEGACY_LOG_JSONL_VERSION}.`);
    }
    records.push(record as unknown as JsonlRecord);
  }
  return records;
}

interface MigrationRecords {
  records: JsonlRecord[];
  legacyV4: boolean;
}

function readMigrationRecords(dir: string): MigrationRecords {
  const current = readRecords(dir).records;
  if (current.length > 0) return { records: current, legacyV4: false };
  return { records: readLegacyV4Records(dir), legacyV4: true };
}

function readMigrationMeta(dir: string, fallback: LogSessionMeta): LogSessionMeta {
  const file = join(dir, "meta.json");
  if (!existsSync(file)) return { ...fallback, compactionFormat: 2 };
  try {
    const sidecar = sessionMetaFromSnake(JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>);
    return { ...fallback, ...sidecar, compactionFormat: 2 };
  } catch {
    return { ...fallback, compactionFormat: 2 };
  }
}

function assertSafeLegacyFileName(value: string, label: string, pattern: RegExp): string {
  if (value !== basename(value) || value.includes("/") || value.includes("\\") || !pattern.test(value)) {
    throw new Error(`Legacy ${label} filename is invalid: '${value}'.`);
  }
  return value;
}

function assertSafeCheckpointId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`Legacy checkpoint id is invalid: '${value}'.`);
  }
  return value;
}

function removeCreatedArchives(paths: readonly string[]): void {
  for (const file of paths) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

function readLegacyArchive(file: string): ArchivedEntryRecord[] | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = readGzipJson<unknown>(file);
    return Array.isArray(parsed) ? parsed as ArchivedEntryRecord[] : null;
  } catch {
    return null;
  }
}

function readIndex(file: string): ArchivedWindowIndex | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = readGzipJson<ArchivedWindowIndex | ArchivedTurnInfo[]>(file);
    return Array.isArray(parsed) ? { turns: parsed, mutations: [], entryIds: [] } : parsed;
  } catch {
    return null;
  }
}

function isLegacyMarker(entry: LogEntry): boolean {
  if (entry.type !== "compact_marker" || entry.discarded) return false;
  return typeof entry.meta["checkpointId"] !== "string";
}

/**
 * 迁移一个会话目录。无旧压缩记录时返回 migrated:false。
 * 调用方负责会话锁与活动会话检查。
 */
export function migrateCompactFormat(dir: string): CompactMigrationResult {
  const logPath = join(dir, LOG_JSONL_FILENAME);
  const backups: string[] = [];
  if (!existsSync(logPath)) {
    const legacyPath = join(dir, "log.json");
    if (!existsSync(legacyPath)) throw new Error("只有 log.json 或 log.jsonl 会话支持 migrate-compact。");
    const migratedLog = migrateLogToJsonl(dir);
    if (migratedLog.backupPath) backups.push(migratedLog.backupPath);
  }

  const migrationRecords = readMigrationRecords(dir);
  const records = migrationRecords.records;
  if (records.length === 0) throw new Error("log.jsonl 为空。");
  const replayed = replayRecords(records);
  const migrationMeta = readMigrationMeta(dir, replayed.meta);
  const entries = replayed.entries;
  const legacyMarkers = entries.filter(isLegacyMarker);
  if (legacyMarkers.length === 0) {
    if (!migrationRecords.legacyV4) {
      return { migrated: false, checkpoints: 0, archivesMigrated: 0, backups };
    }
    const backupPath = `${logPath}.pre-compact-v1.bak`;
    copyFileSync(logPath, backupPath);
    backups.push(backupPath);
    try {
      writeLogJsonlSnapshot(dir, migrationMeta, entries);
      saveSessionMeta(dir, migrationMeta);
      return { migrated: true, checkpoints: 0, archivesMigrated: 0, backups };
    } catch (error) {
      try { copyFileSync(backupPath, logPath); } catch { /* retain the backup for manual recovery */ }
      throw error;
    }
  }

  const archiveDir = join(dir, "archive");
  const contexts = entries.filter((entry) => entry.type === "compact_context" && !entry.discarded);
  const usedContexts = new Set<string>();
  const oldFiles: string[] = [];
  let archivesMigrated = 0;

  const pairs = new Map<string, LogEntry>();
  const migratedArchives = new Map<string, { file: string; entries: ArchivedEntryRecord[]; index: ArchivedWindowIndex }>();
  const createdArchives: string[] = [];
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  for (const marker of legacyMarkers) {
    assertSafeCheckpointId(marker.id);
    const compactIndex = typeof marker.meta["compactIndex"] === "number"
      ? marker.meta["compactIndex"] as number
      : -1;
    const context = contexts.find((candidate) => {
      if (usedContexts.has(candidate.id)) return false;
      const candidateIndex = candidate.meta["compactIndex"];
      if (compactIndex >= 0) return candidateIndex === compactIndex;
      return candidate.turnIndex === marker.turnIndex;
    });
    if (!context) throw new Error(`Legacy compact marker '${marker.id}' has no matching context pair.`);
    if (typeof context.content !== "string" || context.content.trim().length === 0) {
      throw new Error(`Legacy compact context '${context.id}' is empty.`);
    }
    usedContexts.add(context.id);
    pairs.set(marker.id, context);

    const oldArchiveName = typeof marker.meta["archiveFile"] === "string"
      ? assertSafeLegacyFileName(marker.meta["archiveFile"] as string, "archive", /^window-\d+\.json\.gz$/)
      : compactIndex >= 0
        ? `window-${compactIndex}.json.gz`
        : "";
    const oldIndexName = typeof marker.meta["archiveIndexFile"] === "string"
      ? assertSafeLegacyFileName(marker.meta["archiveIndexFile"] as string, "archive index", /^window-\d+\.index\.json\.gz$/)
      : compactIndex >= 0
        ? `window-${compactIndex}.index.json.gz`
        : "";
    const oldArchivePath = oldArchiveName ? join(archiveDir, oldArchiveName) : "";
    const oldArchive = oldArchivePath ? readLegacyArchive(oldArchivePath) : null;
    const hasArchivedEntries = entries.some((entry) => entry.archived && !entry.discarded);
    if (hasArchivedEntries && !oldArchive) {
      throw new Error(`Legacy archive '${oldArchiveName || "<missing>"}' for marker '${marker.id}' is missing or corrupt.`);
    }

    const archiveFile = `window-${marker.id}.jsonl.gz`;
    const archived = (oldArchive ?? []).map((record) => {
      if (typeof record.id !== "string" || record.id.length === 0) {
        throw new Error(`Legacy archive '${oldArchiveName}' contains an entry without an id.`);
      }
      const source = entryById.get(record.id);
      const content = record.content !== undefined ? record.content : source?.content;
      const display = typeof record.display === "string" ? record.display : source?.display;
      const meta = record.meta ?? source?.meta;
      if (content === undefined || content === null) {
        throw new Error(`Legacy archive '${oldArchiveName}' entry '${record.id}' has no content snapshot.`);
      }
      if (typeof display !== "string" || !meta || typeof meta !== "object" || Array.isArray(meta)) {
        throw new Error(`Legacy archive '${oldArchiveName}' entry '${record.id}' is missing display or metadata.`);
      }
      return { id: record.id, content, display, meta };
    });
    const oldIndex = oldIndexName ? readIndex(join(archiveDir, oldIndexName)) : null;
    const index: ArchivedWindowIndex = {
      turns: oldIndex?.turns ?? [],
      mutations: oldIndex?.mutations ?? [],
      entryIds: archived.map((record) => record.id),
    };
    migratedArchives.set(marker.id, { file: archiveFile, entries: archived, index });
    if (oldArchive) {
      archivesMigrated += 1;
      if (oldArchiveName && oldArchiveName !== archiveFile) oldFiles.push(join(archiveDir, oldArchiveName));
      if (oldIndexName && oldIndexName !== archiveFile) oldFiles.push(join(archiveDir, oldIndexName));
    }

    marker.meta["checkpointId"] = marker.id;
    marker.meta["archiveFile"] = archiveFile;
    marker.meta["archiveIndexFile"] = archiveFile;
    marker.meta["scenario"] ??= "before_turn";
    context.meta["checkpointId"] = marker.id;
  }
    const backupPath = `${logPath}.pre-compact-v1.bak`;
    copyFileSync(logPath, backupPath);
    backups.push(backupPath);

  try {
    for (const [checkpointId, archive] of migratedArchives) {
      const target = join(archiveDir, archive.file);
      if (existsSync(target)) {
        throw new Error(`Migration target archive already exists: '${archive.file}'.`);
      }
      writeArchiveEnvelopeForMigration(dir, checkpointId, archive.file, archive.entries, archive.index);
      if (existsSync(target)) createdArchives.push(target);
    }

    // marker/context 必须相邻，快照才能折叠成 checkpoint 记录。
    const ordered: LogEntry[] = [];
    const emitted = new Set<string>();
    for (const entry of entries) {
      if (emitted.has(entry.id)) continue;
      ordered.push(entry);
      emitted.add(entry.id);
      if (entry.type === "compact_marker") {
        const context = pairs.get(entry.id);
        if (context && !emitted.has(context.id)) {
          ordered.push(context);
          emitted.add(context.id);
        }
      }
    }

    writeLogJsonlSnapshot(dir, migrationMeta, ordered);

    // 快照验证：所有 marker/context 必须仍在，且能重放为 checkpoint。
    const verifiedEntries = replayRecords(readRecords(dir).records).entries;
    if (verifiedEntries.length !== ordered.length) {
      throw new Error("migrateCompactFormat: replay verification failed");
    }
    saveSessionMeta(dir, migrationMeta);
  } catch (error) {
    removeCreatedArchives(createdArchives);
    try { copyFileSync(backupPath, logPath); } catch { /* retain the backup for manual recovery */ }
    throw error;
  }

  for (const file of oldFiles) {
    try { rmSync(file, { force: true }); } catch { /* migration succeeded; stale legacy files remain visible */ }
  }

  return {
    migrated: true,
    checkpoints: pairs.size,
    archivesMigrated,
    backups,
  };
}
