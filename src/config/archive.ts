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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry } from "../context/entry/types.js";
import { readGzipJson, writeGzipJson } from "./gzip-json.js";

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
  /** 新格式归档才带 display/meta；旧索引无此字段 → 视为 false。 */
  hasPresentation?: boolean;
  /** 该窗口归档的全部条目 id（M0 legacy 守卫用）。 */
  entryIds?: string[];
}

// ------------------------------------------------------------------
// 归档窗口
// ------------------------------------------------------------------

function archiveDir(dir: string): string {
  return join(dir, "archive");
}

/** 将归档条目压缩并写入归档文件 */
function writeArchiveFile(
  dir: string,
  fileName: string,
  archived: ArchivedEntryRecord[],
): void {
  const targetDir = archiveDir(dir);
  mkdirSync(targetDir, { recursive: true });
  writeGzipJson(join(targetDir, fileName), archived);
}

/** 只记录 turn 列表需要的字段，避免 listTurns 反序列化整份归档。 */
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

function writeArchiveIndex(dir: string, fileName: string, entries: readonly LogEntry[]): void {
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
  if (entries.length === 0) return;
  const index: ArchivedWindowIndex = {
    turns,
    mutations,
    hasPresentation: true,
    entryIds: entries.map((entry) => entry.id),
  };
  writeGzipJson(join(archiveDir(dir), fileName), index);
}

/**
 * 归档指定窗口范围内的日志条目到压缩文件。
 *
 * 只写盘、不改内存：调用方拿到 id 后必须走 `SessionLog.archiveEntries`。
 * 这样落盘与内存变更只有一个入口；归档写入失败时内存也保持原样。
 */
export function archiveWindow(
  dir: string,
  windowIndex: number,
  entries: LogEntry[],
  windowStartIdx: number,
  windowEndIdx: number,
): string[] {
  const targets: LogEntry[] = [];
  for (let i = windowStartIdx; i <= windowEndIdx && i < entries.length; i++) {
    const e = entries[i];
    if (e.content !== null && !e.archived) targets.push(e);
  }
  writeArchiveFile(
    dir,
    `window-${windowIndex}.json.gz`,
    targets.map((e) => ({ id: e.id, content: e.content, display: e.display, meta: e.meta })),
  );
  writeArchiveIndex(dir, `window-${windowIndex}.index.json.gz`, targets);
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
  /** 实际读取的窗口号（测试/诊断用，用于证明没有整目录预载）。 */
  windowsRead: number[];
  /** 已归档但找不到 display 的条目 id。 */
  unresolved: string[];
}

interface WindowFile {
  window: number;
  name: string;
}

function listWindows(dir: string, pattern: RegExp): WindowFile[] {
  const directory = archiveDir(dir);
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory)
      .map((name) => {
        const match = pattern.exec(name);
        return match ? { window: Number(match[1]), name } : null;
      })
      .filter((item): item is WindowFile => item !== null);
  } catch {
    return [];
  }
}

/**
 * 只为给定条目按需读取归档窗口的 display。
 *
 * 新归档的 `window-N.index.json.gz` 带 `entryIds`，可直接定位窗口；
 * 旧索引只有 turn 信息，按 turnIndex 缩小范围；完全没有索引的旧窗口
 * 才逐个读取（兼容路径）。调用方通常只传当前历史页的条目。
 */
export function loadArchivedDisplaysForEntries(
  dir: string,
  entries: readonly LogEntry[],
): ArchivedDisplayLookup {
  const needed = new Map<string, LogEntry>();
  for (const entry of entries) {
    if (entry.archived && entry.display === "") needed.set(entry.id, entry);
  }
  const displays = new Map<string, string>();
  const windowsRead = new Set<number>();
  if (needed.size === 0) return { displays, windowsRead: [], unresolved: [] };

  const indexFiles = listWindows(dir, /^window-(\d+)\.index\.json\.gz$/);
  const windowFiles = listWindows(dir, /^window-(\d+)\.json\.gz$/);
  const windowsWithEntryIds = new Set<number>();
  const idToWindow = new Map<string, number>();
  const turnToWindows = new Map<number, Set<number>>();
  const targeted = new Set<number>();
  const unresolvedAfterIndex = new Set(needed.keys());

  for (const file of indexFiles) {
    try {
      const parsed = readGzipJson<ArchivedWindowIndex | ArchivedTurnInfo[]>(
        join(archiveDir(dir), file.name),
      );
      const index: ArchivedWindowIndex = Array.isArray(parsed)
        ? { turns: parsed, mutations: [] }
        : parsed;
      if (Array.isArray(index.entryIds)) windowsWithEntryIds.add(file.window);
      for (const id of index.entryIds ?? []) {
        if (typeof id === "string" && needed.has(id)) {
          idToWindow.set(id, file.window);
          unresolvedAfterIndex.delete(id);
        }
      }
      for (const info of index.turns ?? []) {
        if (!needed.has(info.id)) continue;
        let windows = turnToWindows.get(info.turnIndex);
        if (!windows) {
          windows = new Set();
          turnToWindows.set(info.turnIndex, windows);
        }
        windows.add(file.window);
        // turn 只能定位到窗口，仍需扫描记录才能确认 display，先不算已解析。
      }
    } catch {
      // 索引损坏时无法定位，留给下面的兜底。
    }
  }

  for (const [id, entry] of needed) {
    const exact = idToWindow.get(id);
    if (exact !== undefined) {
      targeted.add(exact);
      continue;
    }
    const byTurn = turnToWindows.get(entry.turnIndex);
    if (byTurn) {
      for (const window of byTurn) targeted.add(window);
      unresolvedAfterIndex.delete(id);
    }
  }

  // 索引无法定位的条目才兜底读取“没有 entryIds”的旧窗口；新归档仍保持按需。
  if (unresolvedAfterIndex.size > 0) {
    for (const file of windowFiles) {
      if (!windowsWithEntryIds.has(file.window)) targeted.add(file.window);
    }
  }

  for (const window of [...targeted].sort((a, b) => a - b)) {
    const file = windowFiles.find((item) => item.window === window);
    if (!file) continue;
    windowsRead.add(window);
    try {
      for (const record of readGzipJson<ArchivedEntryRecord[]>(join(archiveDir(dir), file.name))) {
        if (!needed.has(record.id) || typeof record.display !== "string") continue;
        displays.set(record.id, record.display);
      }
    } catch {
      // 损坏窗口跳过；对应条目保持空 display。
    }
  }

  const unresolved = [...needed.keys()].filter((id) => !displays.has(id));
  return { displays, windowsRead: [...windowsRead], unresolved };
}

/** 收集所有带正文副本的归档条目 id（prune 的安全判据）。 */
export function loadArchivedContentIds(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const file of listWindows(dir, /^window-\d+\.json\.gz$/)) {
    try {
      for (const record of readGzipJson<ArchivedEntryRecord[]>(join(archiveDir(dir), file.name))) {
        if (typeof record.id === "string" && record.content !== undefined && record.content !== null) {
          ids.add(record.id);
        }
      }
    } catch {
      // 损坏窗口不贡献安全副本； prune 会因缺少副本而拒绝。
    }
  }
  return ids;
}

/** 读取全部归档窗口的 display 映射（旧调用方/诊断用）。 */
export function loadArchivedDisplays(dir: string): Map<string, string> {
  const displays = new Map<string, string>();
  for (const file of listWindows(dir, /^window-(\d+)\.json\.gz$/)) {
    try {
      for (const record of readGzipJson<ArchivedEntryRecord[]>(join(archiveDir(dir), file.name))) {
        if (typeof record.display === "string") displays.set(record.id, record.display);
      }
    } catch {
      // 损坏窗口跳过；对应条目保持空 display。
    }
  }
  return displays;
}

/** M0 重启补偿：只为已归档且 display 为空的条目从 archive 取回 display。 */
export function hydrateArchivedDisplay(dir: string, entries: LogEntry[]): number {
  if (!entries.some((entry) => entry.archived && entry.display === "")) return 0;
  const { displays } = loadArchivedDisplaysForEntries(dir, entries);
  if (displays.size === 0) return 0;
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

/** 新格式归档索引覆盖的条目 id（无 hasPresentation 的旧归档不返回）。 */
export function loadPresentationCapableEntryIds(dir: string): Set<string> {
  const ids = new Set<string>();
  const directory = archiveDir(dir);
  if (!existsSync(directory)) return ids;
  for (const name of readdirSync(directory)) {
    if (!/^window-\d+\.index\.json\.gz$/.test(name)) continue;
    try {
      const index = readGzipJson<ArchivedWindowIndex>(join(directory, name));
      if (index.hasPresentation !== true || !Array.isArray(index.entryIds)) continue;
      for (const id of index.entryIds) {
        if (typeof id === "string") ids.add(id);
      }
    } catch {
      // 损坏索引：保守视为不可剥。
    }
  }
  return ids;
}

/** 加载指定窗口索引的归档文件 */
export function loadArchive(
  dir: string,
  windowIndex: number,
): ArchivedEntryRecord[] {
  return readGzipJson<ArchivedEntryRecord[]>(join(archiveDir(dir), `window-${windowIndex}.json.gz`));
}

/**
 * 按名称加载归档文件。文件不存在时返回 null
 * （例如由旧版二进制写入的归档，或已被修剪的会话目录）
 * ——调用者会降级为保留条目的归档状态。
 */
export function loadArchiveFile(
  dir: string,
  fileName: string,
): ArchivedEntryRecord[] | null {
  const archiveFile = join(archiveDir(dir), fileName);
  if (!existsSync(archiveFile)) return null;
  return readGzipJson<ArchivedEntryRecord[]>(archiveFile);
}

/** 读取全部窗口索引；单个文件损坏只跳过该窗口。 */
function readAllArchiveIndexes(dir: string): ArchivedWindowIndex[] {
  const targetDir = archiveDir(dir);
  if (!existsSync(targetDir)) return [];
  let files: string[];
  try {
    files = readdirSync(targetDir).filter((name) => name.endsWith(".index.json.gz"));
  } catch {
    return [];
  }
  const result: ArchivedWindowIndex[] = [];
  for (const name of files) {
    try {
      const parsed = readGzipJson<ArchivedWindowIndex | ArchivedTurnInfo[]>(join(targetDir, name));
      result.push(Array.isArray(parsed)
        ? { turns: parsed, mutations: [] }
        : { turns: parsed.turns ?? [], mutations: parsed.mutations ?? [] });
    } catch {
      // 单个索引损坏不影响其余窗口。
    }
  }
  return result;
}

/**
 * 加载全部窗口的 turn 索引。索引只含枚举字段，体积很小；
 * 缺失/损坏的索引文件跳过（旧版归档没有索引）。
 */
export function loadArchiveTurnIndexes(dir: string): Map<string, ArchivedTurnInfo> {
  const result = new Map<string, ArchivedTurnInfo>();
  for (const index of readAllArchiveIndexes(dir)) {
    for (const info of index.turns) result.set(info.id, info);
  }
  return result;
}

/** 加载全部窗口的文件变更摘要（回退菜单用，不含 reversePatch）。 */
export function loadArchiveMutationIndexes(dir: string): Map<string, ArchivedMutationInfo> {
  const result = new Map<string, ArchivedMutationInfo>();
  for (const index of readAllArchiveIndexes(dir)) {
    for (const info of index.mutations) result.set(info.id, info);
  }
  return result;
}

/**
 * 读取指定 turn 之后、已归档条目的 meta。
 * 只保留带 toolMetadata 的 tool_result（回退计划只需要 fileMutation /
 * bashMutation），并逐窗口读取，峰值只有一个归档窗口。
 */
export function loadArchivedMetaForTurns(
  dir: string,
  fromTurnIndex: number,
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const targetDir = archiveDir(dir);
  if (!existsSync(targetDir)) return result;
  let files: string[];
  try {
    files = readdirSync(targetDir).filter((name) => /^window-\d+\.json\.gz$/.test(name));
  } catch {
    return result;
  }
  for (const name of files) {
    const windowIndex = Number(/^window-(\d+)\.json\.gz$/.exec(name)![1]);
    const indexFile = join(targetDir, `window-${windowIndex}.index.json.gz`);
    let relevant = false;
    if (existsSync(indexFile)) {
      try {
        const parsed = readGzipJson<ArchivedWindowIndex | ArchivedTurnInfo[]>(indexFile);
        const turns = Array.isArray(parsed) ? parsed : parsed.turns;
        relevant = turns.length === 0 || turns.some((info) => info.turnIndex >= fromTurnIndex);
      } catch {
        relevant = true;
      }
    } else {
      // 没有索引（旧版归档）：保守加载。
      relevant = true;
    }
    if (!relevant) continue;
    try {
      for (const record of readGzipJson<ArchivedEntryRecord[]>(join(targetDir, name))) {
        if (record.meta?.["toolMetadata"]) result.set(record.id, record.meta);
      }
    } catch {
      // 损坏的归档跳过，调用方按"缺失"降级。
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
    if (record.meta !== undefined) e.meta = record.meta;
    e.archived = false;
  }
}
