/**
 * 压缩上下文窗口的归档文件（archive/window-<n>.json.gz）读写。
 *
 * 两级瘦身：
 *  1. 每个窗口关闭时归档内容，并在内存里清掉 content（API 投影不再需要）；
 *  2. 窗口滑出 TUI 折叠边界后，再把 display 与 meta 搬走（见
 *     stripArchivedPresentation），只留枚举字段。
 * 归档文件同时写入一份轻量 turn 索引（window-<n>.index.json.gz），
 * 供 listTurns 在不加载全文的情况下恢复 turnKind/preview。
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry } from "../context/entry/types.js";
import {
  readGzipJsonlEnvelope,
  readGzipJsonlEnvelopeIndex,
  writeGzipJsonlEnvelopeAtomic,
  writeGzipJsonlEnvelopeAtomicSync,
} from "./gzip-json.js";

export interface ArchivedEntryRecord {
  id: string;
  content: unknown;
  display?: string;
  meta?: Record<string, unknown>;
}

export interface ArchivedTurnInfo {
  id: string;
  type: string;
  turnIndex: number;
  turnKind?: string;
  /** 已归一化并截断到 240 字符；与 SessionLog.listTurns 的规则一致。 */
  preview?: string;
}

/** 文件变更的轻量摘要，供回退菜单统计，不必加载 reversePatch。 */
export interface ArchivedMutationInfo {
  id: string;
  turnIndex: number;
  path: string;
  additions: number;
  deletions: number;
}

export interface ArchivedWindowIndex {
  turns: ArchivedTurnInfo[];
  mutations: ArchivedMutationInfo[];
  entryIds: string[];
}

// ------------------------------------------------------------------
// 归档窗口
// ------------------------------------------------------------------

function archiveDir(dir: string): string {
  return join(dir, "archive");
}

/** 只记录 turn 列表需要的字段，避免历史索引反序列化整份归档。 */
function buildTurnInfo(entry: LogEntry): ArchivedTurnInfo | null {
  if (entry.type !== "input_received" && entry.type !== "turn_start") return null;
  const meta = entry.meta as Record<string, unknown>;
  const rawKind = entry.type === "input_received" ? meta.inputKind : meta.turnKind;
  const turnKind = typeof rawKind === "string" ? rawKind : undefined;
  const preview = entry.type === "input_received"
    ? (entry.display || "").replace(/\s+/g, " ").trim().slice(0, 240)
    : "";
  return {
    id: entry.id,
    type: entry.type,
    turnIndex: entry.turnIndex,
    ...(turnKind ? { turnKind } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** 只记录列表、回退菜单和历史页定位需要的字段。 */
function buildArchiveIndex(entries: readonly LogEntry[]): ArchivedWindowIndex {
  const turns = entries.map(buildTurnInfo).filter((info): info is ArchivedTurnInfo => info !== null);
  const mutations: ArchivedMutationInfo[] = [];
  for (const entry of entries) {
    if (entry.type !== "tool_result") continue;
    const meta = entry.meta as Record<string, unknown>;
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const fm = toolMeta?.fileMutation as {
      path?: unknown;
      additions?: unknown;
      deletions?: unknown;
    } | undefined;
    if (!fm || typeof fm.path !== "string") continue;
    mutations.push({
      id: entry.id,
      turnIndex: entry.turnIndex,
      path: fm.path,
      additions: typeof fm.additions === "number" ? fm.additions : 0,
      deletions: typeof fm.deletions === "number" ? fm.deletions : 0,
    });
  }
  return { turns, mutations, entryIds: entries.map((entry) => entry.id) };
}

export interface ArchiveWindowResult {
  ids: string[];
  archiveFile: string;
  archiveIndexFile: string;
}

/** 回滚未提交的 archive 写入；只删本事务的文件。 */
export function deleteArchiveFiles(dir: string, archiveFile: string, archiveIndexFile = ""): void {
  for (const name of new Set([archiveFile, archiveIndexFile])) {
    if (!name) continue;
    try { rmSync(join(archiveDir(dir), name), { force: true }); } catch { /* best effort */ }
  }
}

/** 归档窗口内全部条目，index 与 entries 由一个 gzip envelope 原子提交。 */
export async function archiveWindowById(
  dir: string,
  checkpointId: string,
  entries: LogEntry[],
  windowStartIdx: number,
  windowEndIdx: number,
): Promise<ArchiveWindowResult> {
  const targets: LogEntry[] = [];
  for (let i = windowStartIdx; i <= windowEndIdx && i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.archived || entry.discarded) continue;
    targets.push(entry);
  }
  const archiveFile = `window-${checkpointId}.jsonl.gz`;
  mkdirSync(archiveDir(dir), { recursive: true });
  const records = (function* (): Iterable<ArchivedEntryRecord> {
    for (const entry of targets) {
      yield { id: entry.id, content: entry.content, display: entry.display, meta: entry.meta };
    }
  })();
  await writeGzipJsonlEnvelopeAtomic(
    join(archiveDir(dir), archiveFile),
    checkpointId,
    records,
    buildArchiveIndex(targets),
  );
  return { ids: targets.map((entry) => entry.id), archiveFile, archiveIndexFile: archiveFile };
}

export function writeArchiveEnvelopeForMigration(
  dir: string,
  checkpointId: string,
  archiveFile: string,
  entries: readonly ArchivedEntryRecord[],
  index: ArchivedWindowIndex,
): void {
  mkdirSync(archiveDir(dir), { recursive: true });
  writeGzipJsonlEnvelopeAtomicSync(
    join(archiveDir(dir), archiveFile),
    checkpointId,
    entries,
    index,
  );
}

/** 同步归档入口，供显式 prune 与测试夹具使用；运行时压缩使用异步流式入口。 */
export function archiveWindow(
  dir: string,
  windowIndex: number | string,
  entries: LogEntry[],
  windowStartIdx: number,
  windowEndIdx: number,
): string[] {
  const targets: LogEntry[] = [];
  for (let i = windowStartIdx; i <= windowEndIdx && i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.archived || entry.discarded) continue;
    targets.push(entry);
  }
  const archiveFile = `window-${windowIndex}.jsonl.gz`;
  mkdirSync(archiveDir(dir), { recursive: true });
  writeGzipJsonlEnvelopeAtomicSync(
    join(archiveDir(dir), archiveFile),
    String(windowIndex),
    targets.map((entry) => ({
      id: entry.id,
      content: entry.content,
      display: entry.display,
      meta: entry.meta,
    } satisfies ArchivedEntryRecord)),
    buildArchiveIndex(targets),
  );
  return targets.map((entry) => entry.id);
}

/**
 * 把已归档且滑出 TUI 折叠边界的条目的 display/meta 也搬走。
 * 归档文件里已经保存了原始值，重新进入活动窗口时由
 * restoreArchiveToEntries 恢复。返回被清理的条目数。
 *
 * 保留极小的身份键与回退标记：
 * - contextId/providerRoundId：回退后重建去重集合、轮次归组仍会读；
 * - *MutationReverted*：运行时回退标记，丢了会让旧 mutation 重新出现。
 */
export const RETAINED_ARCHIVED_META_KEYS: ReadonlySet<string> = new Set([
  "contextId",
  "providerRoundId",
  "fileMutationReverted",
  "bashMutationReverted",
  "bashMutationRevertedIndices",
]);

/** 生成剥离 presentation 后的 meta；三处落盘/内存剥离共用这一份白名单。 */
export function retainArchivedMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const retained: Record<string, unknown> = {};
  for (const key of RETAINED_ARCHIVED_META_KEYS) {
    if (key in meta) retained[key] = meta[key];
  }
  return retained;
}

/** M0：生成落盘视图——只改副本，不动内存条目。 */
export function stripEntryForPersistence(entry: LogEntry): LogEntry {
  return { ...entry, display: "", meta: retainArchivedMeta(entry.meta as Record<string, unknown>) };
}

export interface ArchivedDisplayLookup {
  displays: Map<string, string>;
  /** 实际读取的窗口（数值窗口保留 number，checkpoint 窗口为文件名）。 */
  windowsRead: Array<number | string>;
  /** 已归档但找不到 display 的条目 id。 */
  unresolved: string[];
}

function listArchiveNames(dir: string): string[] {
  const directory = archiveDir(dir);
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory).filter(
      (name) => name.startsWith("window-") && name.endsWith(".jsonl.gz"),
    );
  } catch {
    return [];
  }
}

function displayWindowKey(archiveName: string): number | string {
  const match = /^window-(\d+)\.jsonl\.gz$/.exec(archiveName);
  return match ? Number(match[1]) : archiveName;
}

function archivePath(dir: string, archiveName: string): string {
  return join(archiveDir(dir), archiveName);
}

function archiveReadError(name: string, error: unknown): Error {
  return new Error(
    `Archive '${name}' is corrupt or unreadable (${error instanceof Error ? error.message : String(error)}).`,
  );
}

/** 只为给定条目按需读取归档窗口的 display；索引来自同一 envelope 尾记录。 */
export function loadArchivedDisplaysForEntries(
  dir: string,
  entries: readonly LogEntry[],
): ArchivedDisplayLookup {
  const needed = new Map<string, LogEntry>();
  for (const entry of entries) {
    if (entry.archived && entry.display === "") needed.set(entry.id, entry);
  }
  const displays = new Map<string, string>();
  const windowsRead = new Set<number | string>();
  if (needed.size === 0) return { displays, windowsRead: [], unresolved: [] };

  const targeted: string[] = [];
  for (const archiveName of listArchiveNames(dir)) {
    let index: ArchivedWindowIndex;
    try {
      index = readGzipJsonlEnvelopeIndex<ArchivedWindowIndex>(archivePath(dir, archiveName)).index;
    } catch (error) {
      throw archiveReadError(archiveName, error);
    }
    if (index.entryIds.some((id) => needed.has(id))) targeted.push(archiveName);
  }

  for (const archiveName of targeted) {
    windowsRead.add(displayWindowKey(archiveName));
    let records: ArchivedEntryRecord[];
    try {
      records = readGzipJsonlEnvelope<ArchivedEntryRecord, ArchivedWindowIndex>(archivePath(dir, archiveName)).entries;
    } catch (error) {
      throw archiveReadError(archiveName, error);
    }
    for (const record of records) {
      if (needed.has(record.id) && typeof record.display === "string") displays.set(record.id, record.display);
    }
  }

  return {
    displays,
    windowsRead: [...windowsRead],
    unresolved: [...needed.keys()].filter((id) => !displays.has(id)),
  };
}

/** 收集所有带正文副本的归档条目 id（prune 的安全判据）。 */
export function loadArchivedContentIds(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const name of listArchiveNames(dir)) {
    let records: ArchivedEntryRecord[];
    try {
      records = readGzipJsonlEnvelope<ArchivedEntryRecord, ArchivedWindowIndex>(archivePath(dir, name)).entries;
    } catch (error) {
      throw archiveReadError(name, error);
    }
    for (const record of records) {
      if (typeof record.id === "string" && record.content !== undefined && record.content !== null) ids.add(record.id);
    }
  }
  return ids;
}

/** 读取全部归档窗口的 display 映射（诊断用，不用于启动恢复）。 */
export function loadArchivedDisplays(dir: string): Map<string, string> {
  const displays = new Map<string, string>();
  for (const name of listArchiveNames(dir)) {
    let records: ArchivedEntryRecord[];
    try {
      records = readGzipJsonlEnvelope<ArchivedEntryRecord, ArchivedWindowIndex>(archivePath(dir, name)).entries;
    } catch (error) {
      throw archiveReadError(name, error);
    }
    for (const record of records) {
      if (typeof record.display === "string") displays.set(record.id, record.display);
    }
  }
  return displays;
}

/** 显式历史页加载：只为调用方传入的条目回填 display。 */
export function hydrateArchivedDisplay(dir: string, entries: LogEntry[]): number {
  if (!entries.some((entry) => entry.archived && entry.display === "")) return 0;
  const { displays } = loadArchivedDisplaysForEntries(dir, entries);
  let hydrated = 0;
  for (const entry of entries) {
    if (!entry.archived || entry.display !== "") continue;
    const display = displays.get(entry.id);
    if (display === undefined) continue;
    entry.display = display;
    hydrated += 1;
  }
  return hydrated;
}

function needsPresentationStrip(entry: LogEntry): boolean {
  if (!entry.archived) return false;
  const meta = entry.meta as Record<string, unknown>;
  const hasHeavyMeta = Object.keys(meta).some((key) => !RETAINED_ARCHIVED_META_KEYS.has(key));
  return entry.display !== "" || hasHeavyMeta;
}

/** 收集需要清理 presentation 的已归档条目 id（网关批量 patch 用）。 */
export function collectPresentationStripIds(
  entries: readonly LogEntry[],
  foldEndIdx: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i <= foldEndIdx && i < entries.length; i++) {
    const entry = entries[i];
    if (needsPresentationStrip(entry)) ids.push(entry.id);
  }
  return ids;
}

export function stripArchivedPresentation(entries: readonly LogEntry[], foldEndIdx: number): number {
  const ids = new Set(collectPresentationStripIds(entries, foldEndIdx));
  let stripped = 0;
  for (const entry of entries) {
    if (!ids.has(entry.id)) continue;
    entry.display = "";
    entry.meta = retainArchivedMeta(entry.meta as Record<string, unknown>);
    stripped += 1;
  }
  return stripped;
}

/** 新格式 envelope 尾索引覆盖的全部条目 id。 */
export function loadPresentationCapableEntryIds(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const name of listArchiveNames(dir)) {
    let index: ArchivedWindowIndex;
    try {
      index = readGzipJsonlEnvelopeIndex<ArchivedWindowIndex>(archivePath(dir, name)).index;
    } catch (error) {
      throw archiveReadError(name, error);
    }
    for (const id of index.entryIds) ids.add(id);
  }
  return ids;
}

/** 加载指定数值窗口，仅保留给显式 prune/旧测试使用；文件内容仍必须是新 envelope。 */
export function loadArchive(dir: string, windowIndex: number): ArchivedEntryRecord[] {
  return loadArchiveFile(dir, `window-${windowIndex}.jsonl.gz`) ?? [];
}

/** 按 checkpoint 字段加载归档；文件不存在返回 null，格式损坏直接抛出。 */
export function loadArchiveFile(dir: string, fileName: string): ArchivedEntryRecord[] | null {
  const file = archivePath(dir, fileName);
  if (!existsSync(file)) return null;
  try {
    return readGzipJsonlEnvelope<ArchivedEntryRecord, ArchivedWindowIndex>(file).entries;
  } catch (error) {
    throw archiveReadError(fileName, error);
  }
}

function readArchiveIndexes(dir: string): ArchivedWindowIndex[] {
  const result: ArchivedWindowIndex[] = [];
  for (const name of listArchiveNames(dir)) {
    try {
      result.push(readGzipJsonlEnvelopeIndex<ArchivedWindowIndex>(archivePath(dir, name)).index);
    } catch (error) {
      throw archiveReadError(name, error);
    }
  }
  return result;
}

/** 加载全部窗口的 turn 索引；索引与归档正文共享一个 envelope。 */
export function loadArchiveTurnIndexes(dir: string): Map<string, ArchivedTurnInfo> {
  const result = new Map<string, ArchivedTurnInfo>();
  for (const index of readArchiveIndexes(dir)) {
    for (const info of index.turns) result.set(info.id, info);
  }
  return result;
}

/** 加载全部窗口的文件变更摘要（不加载 reversePatch）。 */
export function loadArchiveMutationIndexes(dir: string): Map<string, ArchivedMutationInfo> {
  const result = new Map<string, ArchivedMutationInfo>();
  for (const index of readArchiveIndexes(dir)) {
    for (const info of index.mutations) result.set(info.id, info);
  }
  return result;
}

/** 读取指定 turn 之后、已归档条目的 meta；筛选先用 envelope 尾索引完成。 */
export function loadArchivedMetaForTurns(
  dir: string,
  fromTurnIndex: number,
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const name of listArchiveNames(dir)) {
    let envelope: ReturnType<typeof readGzipJsonlEnvelope<ArchivedEntryRecord, ArchivedWindowIndex>>;
    try {
      envelope = readGzipJsonlEnvelope<ArchivedEntryRecord, ArchivedWindowIndex>(archivePath(dir, name));
    } catch (error) {
      throw archiveReadError(name, error);
    }
    const relevant = envelope.index.turns.length === 0
      || envelope.index.turns.some((info) => info.turnIndex >= fromTurnIndex);
    if (!relevant) continue;
    for (const record of envelope.entries) {
      if (record.meta?.["toolMetadata"]) result.set(record.id, record.meta);
    }
  }
  return result;
}

/**
 * 将归档内容恢复回条目中（仅内存中）。恢复的条目会丢弃其归档标志，
 * 以便重新进入 API 投影，并可被后续的摘要/压缩重新归档。
 * 旧版归档没有 display/meta，此时保留条目当前值。
 */
export function restoreArchiveToEntries(
  entries: LogEntry[],
  archived: ArchivedEntryRecord[],
): void {
  const recordMap = new Map(archived.map((a) => [a.id, a]));
  for (const e of entries) {
    if (!e.archived) continue;
    const record = recordMap.get(e.id);
    if (!record) continue;
    e.content = record.content;
    if (record.display !== undefined) e.display = record.display;
    const retained = retainArchivedMeta(e.meta as Record<string, unknown>);
    e.meta = { ...(record.meta ?? {}), ...retained };
    e.archived = false;
  }
}
