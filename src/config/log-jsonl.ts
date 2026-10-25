/**
 * W-1：log.jsonl 的格式、追加、重放与一次性迁移。
 *
 * 设计见 LOG_WRITE_DESIGN.md §W3/§W4/§W6/§W7。
 * 运行期写入由 SessionLog 网关调用 appendRecords/writeLogJsonlSnapshot；
 * 读取由 loadLog 统一入口调用 loadLogJsonl。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { LogIdAllocator } from "../context/entry/id-allocator.js";
import type { LogEntry } from "../context/entry/types.js";
import { retainArchivedMeta } from "./archive.js";
import {
  buildLogHead,
  entryFromSnake,
  entryToSnake,
  sessionMetaFromSnake,
  type LoadLogResult,
} from "./log-codec.js";
import { loadLegacyLog } from "./log-legacy.js";
import type { LogSessionMeta } from "./session-meta.js";

export const LOG_JSONL_VERSION = 4;
export const LOG_JSONL_FILENAME = "log.jsonl";
export const LOG_JSONL_BACKUP_SUFFIX = ".pre-v4.bak";

/** 允许通过 patch 记录更新的闭集字段。 */
export interface EntryFlags {
  discarded?: boolean;
  archived?: boolean;
  fileMutationReverted?: boolean;
  bashMutationReverted?: boolean;
  bashMutationRevertedIndices?: number[];
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
}

export interface SessionRecord {
  v: typeof LOG_JSONL_VERSION;
  op: "session";
  seq: number;
  ts: string;
  session: Record<string, unknown>;
}

export interface UpsertRecord {
  v: typeof LOG_JSONL_VERSION;
  op: "upsert";
  seq: number;
  ts: string;
  entries: Record<string, unknown>[];
  /**
   * true 表示覆盖已存在条目；缺省表示该 id 在文件中的首次出现。
   * TUI 历史分页靠它把更新后的内容放回创建位置（与全量重放的 Map 顺序一致）。
   */
  replaces?: true;
}

export interface PatchRecord {
  v: typeof LOG_JSONL_VERSION;
  op: "patch";
  seq: number;
  ts: string;
  ids: string[];
  flags?: EntryFlags;
  dropPresentation?: true;
}

export interface TruncateRecord {
  v: typeof LOG_JSONL_VERSION;
  op: "truncate";
  seq: number;
  ts: string;
  fromEntryId: string;
}

export interface UsageRecord {
  v: typeof LOG_JSONL_VERSION;
  op: "usage";
  seq: number;
  ts: string;
  totals: UsageTotals;
}

export type JsonlRecord =
  | SessionRecord
  | UpsertRecord
  | PatchRecord
  | TruncateRecord
  | UsageRecord;

export interface AppendResult {
  appendedBytes: number;
  appendedRecords: number;
}

export interface ReadRecordsResult {
  records: JsonlRecord[];
  warnings: string[];
  /** 文件尾是否有未换行的半条记录（读取时已忽略）。 */
  repairedTail: boolean;
}

export interface MigrationResult {
  migrated: boolean;
  backupPath?: string;
}

const ALLOWED_FLAGS = new Set([
  "discarded",
  "archived",
  "fileMutationReverted",
  "bashMutationReverted",
  "bashMutationRevertedIndices",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string): never {
  throw new Error(`Invalid JSONL record: ${reason}`);
}

function validateFlags(value: unknown): void {
  if (!isPlainObject(value)) invalid("flags must be an object");
  for (const [key, flag] of Object.entries(value)) {
    if (!ALLOWED_FLAGS.has(key)) invalid(`unknown flag '${key}'`);
    if (key === "bashMutationRevertedIndices") {
      if (!Array.isArray(flag) || !flag.every((item) => Number.isInteger(item) && item >= 0)) {
        invalid("bashMutationRevertedIndices must be a non-negative integer array");
      }
      continue;
    }
    if (typeof flag !== "boolean") invalid(`flag '${key}' must be boolean`);
  }
}

function validateRecord(value: unknown): asserts value is JsonlRecord {
  if (!isPlainObject(value)) invalid("record must be an object");
  if (value.v !== LOG_JSONL_VERSION) invalid(`version must be ${LOG_JSONL_VERSION}`);
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) {
    invalid("seq must be a positive integer");
  }
  if (typeof value.ts !== "string" || value.ts.length === 0) invalid("ts must be a non-empty string");

  switch (value.op) {
    case "session":
      if (!isPlainObject(value.session)) invalid("session payload must be an object");
      return;
    case "upsert":
      if (!Array.isArray(value.entries) || value.entries.length === 0) {
        invalid("upsert.entries must be a non-empty array");
      }
      if (value.replaces !== undefined && value.replaces !== true) {
        invalid("upsert.replaces must be true when present");
      }
      for (const entry of value.entries) {
        if (!isPlainObject(entry)) invalid("upsert entry must be an object");
      }
      return;
    case "patch":
      if (!Array.isArray(value.ids) || value.ids.length === 0 || !value.ids.every((id) => typeof id === "string" && id.length > 0)) {
        invalid("patch.ids must be a non-empty string array");
      }
      if (value.flags !== undefined) validateFlags(value.flags);
      if (value.dropPresentation !== undefined && value.dropPresentation !== true) {
        invalid("patch.dropPresentation must be true when present");
      }
      return;
    case "truncate":
      if (typeof value.fromEntryId !== "string" || value.fromEntryId.length === 0) {
        invalid("truncate.fromEntryId must be a non-empty string");
      }
      return;
    case "usage":
      if (!isPlainObject(value.totals)) invalid("usage.totals must be an object");
      for (const key of ["input", "output", "cacheRead"] as const) {
        if (typeof value.totals[key] !== "number" || !Number.isFinite(value.totals[key])) {
          invalid(`usage.totals.${key} must be a finite number`);
        }
      }
      return;
    default:
      invalid(`unknown op '${String(value.op)}'`);
  }
}

/** 序列化为单行 JSON（不含行尾换行）。 */
export function serializeRecord(record: JsonlRecord): string {
  validateRecord(record);
  return JSON.stringify(record);
}

/** 解析单行记录；非法记录必须抛错，而不是返回 undefined。 */
export function parseRecordLine(line: string): JsonlRecord {
  if (typeof line !== "string") invalid("line must be a string");
  const trimmed = line.replace(/[\r\n]+$/, "");
  if (/[\r\n]/.test(trimmed)) invalid("record must be a single line");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    invalid(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  validateRecord(parsed);
  return parsed;
}

/** 追加一批记录；已有字节不得被重写。已有文件时再传 session 记录必须拒绝。 */
export function appendRecords(dir: string, records: readonly JsonlRecord[]): AppendResult {
  if (records.length === 0) return { appendedBytes: 0, appendedRecords: 0 };
  for (const record of records) validateRecord(record);

  mkdirSync(dir, { recursive: true });
  const file = join(dir, LOG_JSONL_FILENAME);
  const size = existsSync(file) ? statSync(file).size : 0;
  const hasHeader = size > 0;

  if (!hasHeader && records[0].op !== "session") {
    throw new Error("log.jsonl must start with a session record");
  }
  if (hasHeader && records.some((record) => record.op === "session")) {
    throw new Error("log.jsonl session record is only allowed on the first line");
  }
  if (!hasHeader && records.filter((record) => record.op === "session").length !== 1) {
    throw new Error("log.jsonl must contain exactly one session record");
  }

  const lastSeq = size > 0 ? readLastSeq(dir) : 0;
  if (records[0].seq !== lastSeq + 1) {
    throw new Error(`log.jsonl seq must continue at ${lastSeq + 1} (got ${records[0].seq})`);
  }
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].seq !== records[index - 1].seq + 1) {
      throw new Error(
        `log.jsonl seq must be contiguous (got ${records[index - 1].seq} then ${records[index].seq})`,
      );
    }
  }

  const fd = openSync(file, "a");
  let appendedBytes = 0;
  try {
    if (size > 0) {
      const rfd = openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        readSync(rfd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) {
          writeSync(fd, "\n");
          appendedBytes += 1;
        }
      } finally {
        closeSync(rfd);
      }
    }
    for (const record of records) {
      const line = `${serializeRecord(record)}\n`;
      writeSync(fd, line);
      appendedBytes += Buffer.byteLength(line, "utf8");
    }
  } finally {
    closeSync(fd);
  }
  return { appendedBytes, appendedRecords: records.length };
}

function readRecordsFromFile(file: string): ReadRecordsResult {
  const raw = readFileSync(file, "utf-8");
  const warnings: string[] = [];
  const records: JsonlRecord[] = [];
  let repairedTail = false;
  if (raw.length === 0) return { records, warnings, repairedTail };

  const hadTrailingNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const isLast = index === lines.length - 1;
    try {
      const record = parseRecordLine(line);
      if (record.op === "session" && records.length > 0) {
        warnings.push(`session record at line ${index + 1} ignored`);
        continue;
      }
      if (records.length === 0 && record.op !== "session") {
        warnings.push(`first record at line ${index + 1} is not session`);
      }
      records.push(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isLast && !hadTrailingNewline) {
        repairedTail = true;
        warnings.push(`partial tail at line ${index + 1} ignored: ${message}`);
      } else {
        warnings.push(`invalid record at line ${index + 1} skipped: ${message}`);
      }
    }
  }

  let lastSeq = 0;
  for (const record of records) {
    if (record.op === "session") {
      lastSeq = Math.max(lastSeq, record.seq);
      continue;
    }
    if (record.seq <= lastSeq) {
      warnings.push(`seq ${record.seq} is not increasing (last ${lastSeq})`);
    } else if (record.seq > lastSeq + 1) {
      warnings.push(`seq gap: ${lastSeq} -> ${record.seq}`);
    }
    lastSeq = Math.max(lastSeq, record.seq);
  }

  return { records, warnings, repairedTail };
}

/** 从文件读取全部记录；坏行跳过并告警，半条尾行忽略。 */
export function readRecords(dir: string): ReadRecordsResult {
  return readRecordsFromFile(join(dir, LOG_JSONL_FILENAME));
}

/** header 是不可变身份；可变字段（title/turnCount/model/children/inbox）以 meta.json 为准。 */
function mergeMetaFromSidecar(dir: string, meta: LogSessionMeta): LogSessionMeta {
  const file = join(dir, "meta.json");
  if (!existsSync(file)) return meta;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...buildLogHead(meta), ...raw, version: meta.version };
    if (typeof raw.last_active_at === "string") merged.updated_at = raw.last_active_at;
    return sessionMetaFromSnake(merged);
  } catch {
    return meta;
  }
}

/** 只读第一行原始文本（header），不解析正文。 */
function readFirstLine(dir: string): string {
  const file = join(dir, LOG_JSONL_FILENAME);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf-8");
    const newline = text.search(/\r?\n/);
    return newline >= 0 ? text.slice(0, newline) : text;
  } finally {
    closeSync(fd);
  }
}

/** 第一行 session 记录；用于迁移/有界读取。 */
function readHeaderRecord(dir: string): SessionRecord {
  const record = parseRecordLine(readFirstLine(dir));
  if (record.op !== "session") {
    throw new Error("log.jsonl first record is not a session record");
  }
  return record;
}

/** 只读第一行 session 记录，不解析正文。 */
export function readLogHeader(dir: string): LogSessionMeta {
  return mergeMetaFromSidecar(dir, sessionMetaFromSnake(readHeaderRecord(dir).session));
}

function applyPatch(entry: LogEntry, flags?: EntryFlags, dropPresentation?: true): void {
  const meta = entry.meta as Record<string, unknown>;
  if (flags) {
    if (flags.discarded !== undefined) {
      if (flags.discarded) entry.discarded = true;
      else delete entry.discarded;
    }
    if (flags.archived !== undefined) entry.archived = flags.archived;
    if (flags.fileMutationReverted !== undefined) {
      if (flags.fileMutationReverted) meta.fileMutationReverted = true;
      else delete meta.fileMutationReverted;
    }
    if (flags.bashMutationReverted !== undefined) {
      if (flags.bashMutationReverted) meta.bashMutationReverted = true;
      else delete meta.bashMutationReverted;
    }
    if (flags.bashMutationRevertedIndices !== undefined) {
      if (flags.bashMutationRevertedIndices.length > 0) {
        meta.bashMutationRevertedIndices = [...flags.bashMutationRevertedIndices];
      } else {
        delete meta.bashMutationRevertedIndices;
      }
    }
  }
  if (dropPresentation) {
    entry.display = "";
    entry.meta = retainArchivedMeta(meta);
  }
}

/** 按 seq 重放记录，返回与 loadLog 同形的结果。 */
export function replayRecords(records: readonly JsonlRecord[]): LoadLogResult {
  const session = records.find((record) => record.op === "session");
  if (!session || session.op !== "session") {
    throw new Error("log.jsonl has no session record");
  }
  const meta = sessionMetaFromSnake(session.session);
  const entriesById = new Map<string, LogEntry>();

  for (const record of records) {
    if (record.op === "upsert") {
      for (const raw of record.entries) {
        const entry = entryFromSnake(raw);
        entriesById.set(entry.id, entry);
      }
    } else if (record.op === "patch") {
      for (const id of record.ids) {
        const entry = entriesById.get(id);
        if (entry) applyPatch(entry, record.flags, record.dropPresentation);
      }
    } else if (record.op === "truncate") {
      const ids = [...entriesById.keys()];
      const index = ids.indexOf(record.fromEntryId);
      if (index >= 0) {
        for (const id of ids.slice(index)) entriesById.delete(id);
      }
    }
  }

  const entries = [...entriesById.values()];
  const idAllocator = new LogIdAllocator();
  // meta.json 的计数器可能领先于窗口/条目（截断过的前缀），先合并再扫条目取最大。
  idAllocator.restoreCounters(meta.idCounters);
  idAllocator.mergeFrom(entries);
  return { meta, entries, idAllocator };
}

/** 加载 log.jsonl；不存在时抛错（迁移由 migrateLogToJsonl 负责）。 */
export function loadLogJsonl(dir: string): LoadLogResult {
  const result = replayRecords(readRecords(dir).records);
  const meta = mergeMetaFromSidecar(dir, result.meta);
  // 条目扫描只看到现存条目；已截断前缀的计数器从 meta.json 补齐，避免重号。
  result.idAllocator.restoreCounters(meta.idCounters);
  return { ...result, meta };
}

/** R-2：有界模型上下文的加载结果。 */
export interface ModelContextLoadResult extends LoadLogResult {
  /** true 表示只加载了最新 live marker 及之后；false 表示回退到整份日志。 */
  bounded: boolean;
  /** 反向扫描实际读取的字节数（含尾部块开销）。 */
  scannedBytes: number;
  /** 活动窗口首条记录（marker）在文件中的字节偏移；未走有界路径时为 0。 */
  windowStartOffset: number;
  warnings: string[];
  repairedTail: boolean;
}

const SCAN_BLOCK_BYTES = 64 * 1024;

interface WindowScan {
  records: JsonlRecord[];
  bounded: boolean;
  scannedBytes: number;
  warnings: string[];
  repairedTail: boolean;
  windowStartOffset: number;
}

/**
 * 从文件尾反向扫描，收集最新 live compact_marker 及之后的记录。
 *
 * 规则（LOG_READ_DESIGN.md §R3.2）：
 * - 同一 id 只看离文件尾最近的 upsert；
 * - `truncate` 建立“死区”，跳过被截断的条目，直到遇到 fromEntryId 的 upsert；
 * - 压缩时在 marker 之后补写的 `archived: true` upsert 属于标记前的窗口，必须过滤；
 * - marker 本身 `discarded` 或事后被 patch 丢弃 → 继续向更早找；
 * - 找不到 live marker → 返回全部存活记录（回退全量）。
 */
function scanBackwardForWindow(file: string): WindowScan {
  const fd = openSync(file, "r");
  const warnings: string[] = [];
  const collected: JsonlRecord[] = []; // 文件尾 → 文件头
  try {
    const size = statSync(file).size;
    const endsWithNewline = (() => {
      if (size === 0) return true;
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] === 0x0a;
    })();

    let pos = size;
    let remainder = Buffer.alloc(0);
    let scannedBytes = 0;
    let repairedTail = false;
    let firstLine = true;
    let bounded = false;
    let windowStartOffset = 0;
    let done = false;
    let deadUntil: string | null = null;
    const patchedDiscarded = new Map<string, boolean>();
    const seenUpsertIds = new Set<string>();

    while (!done && (pos > 0 || remainder.length > 0)) {
      let lines: Array<{ text: string; start: number }>;
      if (pos > 0) {
        const chunkSize = Math.min(SCAN_BLOCK_BYTES, pos);
        pos -= chunkSize;
        const chunk = Buffer.alloc(chunkSize);
        readSync(fd, chunk, 0, chunkSize, pos);
        scannedBytes += chunkSize;
        const buffer = remainder.length > 0 ? Buffer.concat([chunk, remainder]) : chunk;
        const bufferStart = pos;
        lines = [];
        let end = buffer.length;
        while (end > 0) {
          const newline = buffer.lastIndexOf(0x0a, end - 1);
          if (newline < 0) break;
          lines.push({
            text: buffer.subarray(newline + 1, end).toString("utf-8"),
            start: bufferStart + newline + 1,
          });
          end = newline;
        }
        remainder = Buffer.from(buffer.subarray(0, end));
      } else {
        lines = remainder.length > 0 ? [{ text: remainder.toString("utf-8"), start: 0 }] : [];
        remainder = Buffer.alloc(0);
      }

      for (const { text: line, start: lineStart } of lines) {
        if (done) break;
        if (!line.trim()) continue;
        let record: JsonlRecord;
        try {
          record = parseRecordLine(line);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (firstLine && !endsWithNewline) {
            repairedTail = true;
            warnings.push(`partial tail ignored during reverse scan: ${message}`);
          } else {
            warnings.push(`invalid record skipped during reverse scan: ${message}`);
          }
          firstLine = false;
          continue;
        }
        firstLine = false;

        if (record.op === "session") continue;

        if (record.op === "truncate") {
          // 只影响它之前（文件序更早）的记录；已收集的尾部记录是截断后追加的，保留。
          deadUntil = record.fromEntryId;
          continue;
        }

        if (deadUntil !== null) {
          if (record.op === "upsert" && record.entries.some((raw) => raw.id === deadUntil)) {
            deadUntil = null;
          }
          continue;
        }

        if (record.op === "patch") {
          if (record.flags?.discarded !== undefined) {
            for (const id of record.ids) {
              if (!patchedDiscarded.has(id)) patchedDiscarded.set(id, record.flags.discarded);
            }
          }
          collected.push(record);
          continue;
        }

        if (record.op === "usage") {
          collected.push(record);
          continue;
        }

        // 归档条目的 upsert 是在后续 marker 之后补写的标记前窗口，不属于当前窗口。
        const kept = record.entries.filter((raw) => raw.archived !== true);
        if (kept.length === 0) continue;
        const upsert: UpsertRecord = kept.length === record.entries.length
          ? record
          : { ...record, entries: kept };
        collected.push(upsert);

        for (const raw of kept) {
          const id = raw.id;
          if (typeof id !== "string" || seenUpsertIds.has(id)) continue;
          seenUpsertIds.add(id);
          if (raw.type !== "compact_marker") continue;
          if (raw.discarded === true || patchedDiscarded.get(id) === true) continue;
          bounded = true;
          windowStartOffset = lineStart;
          done = true;
          break;
        }
      }
    }

    return {
      records: collected.slice().reverse(),
      bounded,
      scannedBytes,
      warnings,
      repairedTail,
      windowStartOffset,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * R-2：有界模型上下文。只读“最新 live marker 及之后”的记录。
 *
 * 追加安全（ID/work 计数）依赖 meta.json 的 `idCounters`/`workCount`；
 * 旧会话缺这两个字段时退回整读，下一次保存会自动补写。
 */
export function loadModelContext(dir: string): ModelContextLoadResult {
  const file = join(dir, LOG_JSONL_FILENAME);
  const size = statSync(file).size;
  const header = readHeaderRecord(dir);
  const meta = mergeMetaFromSidecar(dir, sessionMetaFromSnake(header.session));

  if (!meta.idCounters || meta.workCount === undefined || !meta.tokens) {
    const full = loadLogJsonl(dir);
    return {
      ...full,
      bounded: false,
      scannedBytes: size,
      warnings: ["model context: meta.json lacks id_counters/work_count/tokens; fell back to full read"],
      repairedTail: false,
      windowStartOffset: 0,
    };
  }

  const scan = scanBackwardForWindow(file);
  const replayed = replayRecords([header, ...scan.records]);
  const idAllocator = new LogIdAllocator();
  idAllocator.restoreCounters(meta.idCounters);
  idAllocator.mergeFrom(replayed.entries);
  return {
    meta,
    entries: replayed.entries,
    idAllocator,
    bounded: scan.bounded,
    scannedBytes: scan.scannedBytes,
    warnings: scan.warnings,
    repairedTail: scan.repairedTail,
    windowStartOffset: scan.windowStartOffset,
  };
}

/** 一次性把旧 log.json 迁移为 log.jsonl；失败不得破坏旧文件。 */
export function migrateLogToJsonl(dir: string): MigrationResult {
  const jsonlPath = join(dir, LOG_JSONL_FILENAME);
  if (existsSync(jsonlPath)) return { migrated: false };

  const legacyPath = join(dir, "log.json");
  if (!existsSync(legacyPath)) {
    throw new Error("migrateLogToJsonl: log.json not found");
  }

  const old = loadLegacyLog(dir);
  const now = new Date().toISOString();
  const records: JsonlRecord[] = [
    {
      v: LOG_JSONL_VERSION,
      op: "session",
      seq: 1,
      ts: now,
      session: { ...buildLogHead(old.meta), version: LOG_JSONL_VERSION },
    },
    ...old.entries.map((entry, index): UpsertRecord => ({
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: index + 2,
      ts: now,
      entries: [entryToSnake(entry)],
    })),
  ];

  const tmpPath = `${jsonlPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, records.map((record) => `${serializeRecord(record)}\n`).join(""), "utf-8");
    const replayed = replayRecords(readRecordsFromFile(tmpPath).records);
    if (!isDeepStrictEqual(replayed.entries, old.entries)) {
      throw new Error("migrateLogToJsonl: replay verification failed (entries differ)");
    }
    if (
      replayed.meta.sessionId !== old.meta.sessionId
      || replayed.meta.turnCount !== old.meta.turnCount
      || replayed.meta.compactCount !== old.meta.compactCount
    ) {
      throw new Error("migrateLogToJsonl: replay verification failed (meta differs)");
    }

    renameSync(tmpPath, jsonlPath);
    const backupPath = legacyPath + LOG_JSONL_BACKUP_SUFFIX;
    if (existsSync(backupPath)) rmSync(backupPath, { force: true });
    renameSync(legacyPath, backupPath);
    return { migrated: true, backupPath };
  } catch (error) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** 下一批记录的起始 seq。 */
export function nextSeq(records: readonly JsonlRecord[]): number {
  let max = 0;
  for (const record of records) {
    if (record.seq > max) max = record.seq;
  }
  return max + 1;
}

/** 只读文件尾，取最后一条有效记录的 seq（不整读 200 MB 日志）。 */
export function readLastSeq(dir: string): number {
  const file = join(dir, LOG_JSONL_FILENAME);
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    let position = size;
    let tail = Buffer.alloc(0);
    while (position > 0) {
      const chunkSize = Math.min(64 * 1024, position);
      position -= chunkSize;
      const chunk = Buffer.alloc(chunkSize);
      readSync(fd, chunk, 0, chunkSize, position);
      tail = Buffer.concat([chunk, tail]);
      let end = tail.length;
      while (end > 0) {
        const newline = tail.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const line = tail.subarray(newline + 1, end).toString("utf-8").trim();
        end = newline;
        if (!line) continue;
        try {
          return parseRecordLine(line).seq;
        } catch {
          // 半条尾行/坏行：继续向更早的记录找。
        }
      }
      if (position === 0 && end > 0) {
        // 文件最短只有一行（如仅 header）时，上面需要换行才能切出行；这里补解析首行。
        const line = tail.subarray(0, end).toString("utf-8").trim();
        if (!line) return 0;
        try {
          return parseRecordLine(line).seq;
        } catch {
          return 0;
        }
      }
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

export interface SnapshotResult {
  entriesWritten: number;
  nextSeq: number;
}

/** 首次保存：写 header + 全部条目（tmp+rename），不做增量 diff。 */
export function writeLogJsonlSnapshot(
  dir: string,
  meta: LogSessionMeta,
  entries: readonly LogEntry[],
  prepare?: (entry: LogEntry) => LogEntry | null,
  usage?: UsageTotals,
): SnapshotResult {
  mkdirSync(dir, { recursive: true });
  const jsonlPath = join(dir, LOG_JSONL_FILENAME);
  const now = new Date().toISOString();
  const records: JsonlRecord[] = [{
    v: LOG_JSONL_VERSION,
    op: "session",
    seq: 1,
    ts: now,
    session: { ...buildLogHead(meta), version: LOG_JSONL_VERSION },
  }];
  const expectedIds: string[] = [];
  let seq = 2;
  for (const entry of entries) {
    const prepared = prepare ? prepare(entry) : entry;
    if (!prepared) continue;
    expectedIds.push(prepared.id);
    records.push({
      v: LOG_JSONL_VERSION,
      op: "upsert",
      seq: seq++,
      ts: now,
      entries: [entryToSnake(prepared)],
    });
  }
  const hasCompactMarker = records.some((record) =>
    record.op === "upsert" && record.entries.some((entry) => entry.type === "compact_marker"));
  if (usage && hasCompactMarker) {
    records.push({
      v: LOG_JSONL_VERSION,
      op: "usage",
      seq: seq++,
      ts: now,
      totals: usage,
    });
  }

  const tmpPath = `${jsonlPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, records.map((record) => `${serializeRecord(record)}\n`).join(""), "utf-8");
    const replayed = replayRecords(readRecordsFromFile(tmpPath).records);
    if (
      replayed.entries.length !== expectedIds.length
      || expectedIds.some((id, index) => replayed.entries[index]?.id !== id)
    ) {
      throw new Error("writeLogJsonlSnapshot: replay verification failed");
    }
    renameSync(tmpPath, jsonlPath);
    return { entriesWritten: expectedIds.length, nextSeq: seq };
  } catch (error) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}
