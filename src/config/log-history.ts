/**
 * R-3：TUI 历史分页读取。
 *
 * 从文件尾按 64 KiB 块反向扫描，逐页产出"已应用补丁/截断"的日志条目。
 * 与 `loadModelContext` 的区别：这里面向展示，包含标记前的历史，不做窗口截断；
 * 游标是字节偏移，翻页状态（已见 id、补丁、截断死区）跨页保留。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { LogEntry } from "../context/entry/types.js";
import { entryFromSnake, entryToSnake } from "./log-codec.js";
import {
  LOG_JSONL_FILENAME,
  parseRecordLine,
  type EntryFlags,
  type JsonlRecord,
} from "./log-jsonl.js";
import { retainArchivedMeta } from "./archive.js";

export const TUI_HISTORY_PAGE_ENTRIES = 200;
export const TUI_HISTORY_PAGE_BYTES = 2 * 1024 * 1024;
/** 已加载历史页的常驻上限；达到后不再继续向上取页。 */
export const HISTORY_PAGE_CACHE_BYTES = 8 * 1024 * 1024;
const SCAN_BLOCK_BYTES = 64 * 1024;

/** 与分页器页字节口径一致：条目落盘序列化后的 UTF-8 字节。 */
export function estimateEntriesBytes(entries: readonly LogEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += Buffer.byteLength(JSON.stringify(entryToSnake(entry)), "utf8");
  }
  return total;
}

export interface TuiHistoryPage {
  /** 本页条目，按时间顺序（旧 → 新）。 */
  entries: LogEntry[];
  /** 是否还有更早的页。 */
  hasMore: boolean;
  /** 本页实际读取的原始字节数（含块开销）。 */
  scannedBytes: number;
}

export interface TuiHistoryPagerOptions {
  maxEntries?: number;
  maxBytes?: number;
  /**
   * 扫描起点（字节偏移，通常是活动窗口 marker 的行首）；缺省为文件尾。
   * 必须是行边界（前一字节为换行），否则跨边界的记录会被丢弃。
   */
  startOffset?: number;
}

function stripPresentation(entry: LogEntry): void {
  entry.display = "";
  entry.meta = retainArchivedMeta(entry.meta as Record<string, unknown>);
}

function applyFlags(entry: LogEntry, flags: EntryFlags | undefined): void {
  if (!flags) return;
  const meta = entry.meta as Record<string, unknown>;
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

/**
 * 有状态的 TUI 历史分页器：`nextPage()` 每次向前（更早）翻一页。
 * 页与页之间必须复用同一实例，否则补丁/截断状态会丢。
 */
export class TuiHistoryPager {
  private readonly fd: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private cursor: number;
  /** id → 最新内容，等待扫描到它的创建 upsert 后再按创建位置发射。 */
  private readonly held = new Map<string, LogEntry>();
  private readonly emittedIds = new Set<string>();
  private readonly patchedFlags = new Map<string, EntryFlags>();
  private readonly droppedPresentation = new Set<string>();
  private readonly warnings: string[] = [];
  private deadUntil: string | null = null;
  private repairedTail = false;
  private tailLinePending = true;
  private readonly endsWithNewline: boolean;
  /** header 行结束偏移；cursor 到这里就没有更早的记录（避免返回空的终止页）。 */
  private readonly headerEndOffset: number;

  constructor(dir: string, opts?: TuiHistoryPagerOptions) {
    const file = join(dir, LOG_JSONL_FILENAME);
    this.fd = openSync(file, "r");
    const size = statSync(file).size;
    this.cursor = Math.min(Math.max(0, opts?.startOffset ?? size), size);
    this.endsWithNewline = (() => {
      if (size === 0) return true;
      const last = Buffer.alloc(1);
      readSync(this.fd, last, 0, 1, size - 1);
      return last[0] === 0x0a;
    })();
    this.maxEntries = Math.max(1, opts?.maxEntries ?? TUI_HISTORY_PAGE_ENTRIES);
    this.maxBytes = Math.max(1, opts?.maxBytes ?? TUI_HISTORY_PAGE_BYTES);
    this.tailLinePending = this.cursor === size;
    const header = Buffer.alloc(Math.min(SCAN_BLOCK_BYTES, size));
    readSync(this.fd, header, 0, header.length, 0);
    const newline = header.indexOf(0x0a);
    this.headerEndOffset = newline >= 0 ? newline + 1 : 0;
  }

  get warningsSoFar(): readonly string[] {
    return this.warnings;
  }

  get repairedTailSoFar(): boolean {
    return this.repairedTail;
  }

  /** 下一页（更早的历史）；没有更早内容时返回空页且 hasMore=false。 */
  nextPage(): TuiHistoryPage {
    const collected: LogEntry[] = []; // 新 → 旧
    let pageBytes = 0;
    let pos = this.cursor;
    let remainder = Buffer.alloc(0);
    let firstLine = this.tailLinePending;
    let scannedBytes = 0;

    while (pos > 0) {
      const chunkSize = Math.min(SCAN_BLOCK_BYTES, pos);
      pos -= chunkSize;
      const chunk = Buffer.alloc(chunkSize);
      readSync(this.fd, chunk, 0, chunkSize, pos);
      scannedBytes += chunkSize;
      const buffer = remainder.length > 0 ? Buffer.concat([chunk, remainder]) : chunk;
      const bufferStart = pos;
      let end = buffer.length;

      while (end > 0) {
        const newline = buffer.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const lineStart = bufferStart + newline + 1;
        const line = buffer.subarray(newline + 1, end).toString("utf-8");
        end = newline;
        if (!line.trim()) {
          this.cursor = lineStart;
          continue;
        }

        let record: JsonlRecord;
        try {
          record = parseRecordLine(line);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (firstLine && !this.endsWithNewline) {
            // 文件尾半条记录；仅当扫描起点就是文件尾时可能发生。
            this.repairedTail = true;
            this.warnings.push(`partial tail ignored: ${message}`);
          } else {
            this.warnings.push(`invalid record skipped: ${message}`);
          }
          firstLine = false;
          this.tailLinePending = false;
          this.cursor = lineStart;
          continue;
        }
        firstLine = false;
        this.tailLinePending = false;
        this.cursor = lineStart;

        pageBytes += this.processRecord(record, collected);
        if (collected.length >= this.maxEntries || pageBytes >= this.maxBytes) {
          return { entries: collected.slice().reverse(), hasMore: this.cursor > this.headerEndOffset, scannedBytes };
        }
      }

      remainder = Buffer.from(buffer.subarray(0, end));
    }

    if (pos === 0) this.cursor = 0;
    return { entries: collected.slice().reverse(), hasMore: false, scannedBytes };
  }

  /** 处理一条记录；返回本次发射条目的序列化字节数（用于页内存上限）。 */
  private processRecord(record: JsonlRecord, collected: LogEntry[]): number {
    if (record.op === "session" || record.op === "usage") return 0;

    if (record.op === "truncate") {
      this.deadUntil = record.fromEntryId;
      return 0;
    }

    if (this.deadUntil !== null) {
      if (record.op === "upsert" && record.entries.some((raw) => raw.id === this.deadUntil)) {
        this.deadUntil = null;
      }
      return 0;
    }

    if (record.op === "patch") {
      if (record.dropPresentation) {
        for (const id of record.ids) this.droppedPresentation.add(id);
      }
      for (const id of record.ids) {
        // 反向扫描：先遇到的补丁更新；同一 flag 只保留最新值。
        const merged = this.patchedFlags.get(id) ?? {};
        let changed = false;
        const flags = record.flags;
        if (flags) {
          for (const key of ["discarded", "archived", "fileMutationReverted", "bashMutationReverted", "bashMutationRevertedIndices"] as const) {
            const value = flags[key];
            if (value !== undefined && merged[key] === undefined) {
              (merged as Record<string, unknown>)[key] = value;
              changed = true;
            }
          }
        }
        if (changed) this.patchedFlags.set(id, merged);
      }
      return 0;
    }

    let bytes = 0;
    for (const raw of record.entries) {
      const id = raw.id;
      if (typeof id !== "string" || this.emittedIds.has(id)) continue;

      if (record.replaces === true) {
        // 覆盖记录：先持有最新内容，等扫到创建记录再按创建位置发射。
        // 反向扫描时第一条 replaces 就是最新值，更早的覆盖直接忽略。
        if (this.held.has(id)) continue;
        const entry = entryFromSnake(raw);
        applyFlags(entry, this.patchedFlags.get(id));
        if (this.droppedPresentation.has(id)) stripPresentation(entry);
        this.held.set(id, entry);
        continue;
      }

      // 创建记录（旧日志没有 replaces 标志，也按创建处理）。
      const entry = this.held.get(id) ?? entryFromSnake(raw);
      if (!this.held.has(id)) {
        applyFlags(entry, this.patchedFlags.get(id));
        if (this.droppedPresentation.has(id)) stripPresentation(entry);
      }
      this.held.delete(id);
      this.emittedIds.add(id);
      collected.push(entry);
      bytes += Buffer.byteLength(JSON.stringify(entryToSnake(entry)), "utf8");
    }
    return bytes;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** 打开一个历史分页器；调用方负责 close()。 */
export function openTuiHistoryPager(dir: string, opts?: TuiHistoryPagerOptions): TuiHistoryPager {
  return new TuiHistoryPager(dir, opts);
}

/** 一次性取一页（从文件尾开始）；连续翻页请复用 pager。 */
export function loadLatestTuiPage(dir: string, opts?: TuiHistoryPagerOptions): TuiHistoryPage {
  const pager = openTuiHistoryPager(dir, opts);
  try {
    return pager.nextPage();
  } finally {
    pager.close();
  }
}
