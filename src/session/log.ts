/**
 * SessionLog —— 结构化日志存储（P2.2）。
 *
 * 拥有只增的 LogEntry 数组、变更检测 revision、变更监听器、
 * 以及 entry ID 分配器。Session 暴露薄访问器，
 * 使运行时其余部分读写 _log 时保持不变。
 */

import { LogIdAllocator } from "../context/entry/id-allocator.js";
import type { LogEntry, TurnKind } from "../context/entry/types.js";
import {
  collectPresentationStripIds,
  retainArchivedMeta,
  type ArchivedEntryRecord,
  type ArchivedTurnInfo,
} from "../config/archive.js";
import { LOG_JSONL_VERSION, type EntryFlags, type JsonlRecord } from "../config/log-jsonl.js";
import { entryToSnake } from "../config/log-codec.js";

/** 压缩提交所需的路由信息；marker/context 必须一起落盘。 */
export interface CompactCheckpointMeta {
  checkpointId: string;
  archiveFile: string;
  archiveIndexFile: string;
  compactIndex: number;
  scenario: "before_turn" | "mid_turn" | "manual";
}

/** 为 provider-round 条目类型打 providerRoundId 标记（幂等）。 */
export function stampProviderRoundId(entry: LogEntry): void {
  if (
    entry.roundIndex !== undefined &&
    (
      entry.type === "assistant_text" ||
      entry.type === "reasoning" ||
      entry.type === "tool_call" ||
      entry.type === "tool_result" ||
      entry.type === "no_reply"
    )
  ) {
    entry.meta["providerRoundId"] ??= `input-${entry.turnIndex}:round-${entry.roundIndex}`;
  }
}

/** 用于列出 turn 的摘要信息。 */
type PendingLogOp =
  | { kind: "upsert"; id: string }
  | { kind: "patch"; ids: string[]; flags: EntryFlags; dropPresentation?: true }
  | { kind: "truncate"; fromEntryId: string }
  | { kind: "checkpoint"; markerId: string; contextId: string; meta: CompactCheckpointMeta };

function snapshotEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

export interface TurnListing {
  turnIndex: number;
  entryIndex: number;
  turnKind: TurnKind;
  preview: string;
  timestamp: number;
  /** 该 turn 是否在活动窗口内（最近一次 compact_marker 之后）。 */
  inActiveWindow: boolean;
}

export interface SessionLogOptions {
  /** 是否写入追加日志（ephemeral/未完成态过滤）。 */
  shouldPersist?: (entry: LogEntry) => boolean;
  /** 落盘前的减重变换（截断/外置）；返回 null 表示跳过。 */
  prepareForPersistence?: (entry: LogEntry) => LogEntry | null;
}

/**
 * SessionLog —— 结构化日志存储。
 *
 * 核心设计：
 * - appendOnly：条目只能追加，不直接支持修改（修改通过 rewind 或 updateEntry 实现）
 * - 索引延迟扩展：热点路径（工具执行状态更新、流式条目补丁）使用 Map 索引，
 *   惰性扩展到 _indexedUpTo 水印；append 时若数组缩短则重建索引
 * - 订阅/通知：每次修改触发 bumpRevision + notifyListeners，UI 可检测变化
 */
export class SessionLog {
  private _entries: LogEntry[] = [];
  private _revision = 0;
  private _listeners = new Set<() => void>();
  private _idAllocator = new LogIdAllocator();

  // ─── 索引层 ───
  // 热点路径曾每次操作扫描整个日志，现改为 Map 索引。
  // 索引在 _indexedUpTo 水印前惰性扩展；append 时若数组缩短则重建。
  // 失效契约：后端数组仅通过 append()/replace()/rewind 截断改变，
  // 后两者显式失效。每次索引命中都验证 live entry， mismatch 触发重建。
  private _idIndex = new Map<string, number>();
  private _toolCallIdIndex = new Map<string, number>();
  private _indexedUpTo = 0;

  // W-1 变更网关：所有落盘变更先进入待写队列，drain 时再序列化。
  private _pendingOps: PendingLogOp[] = [];
  /** 已成功落盘的条目 id；用于区分创建 vs 覆盖（TUI 历史分页的顺序依据）。 */
  private _persistedIds = new Set<string>();
  /** 本次 peek 实际写入的 id（append 成功后由 commit 合并进 _persistedIds）。 */
  private _peekedIds = new Set<string>();
  private _entrySnapshots = new Map<string, string>();
  private _guardEnabled = false;
  private _shouldPersist?: (entry: LogEntry) => boolean;
  private _prepareForPersistence?: (entry: LogEntry) => LogEntry | null;

  constructor(opts?: SessionLogOptions) {
    this._shouldPersist = opts?.shouldPersist;
    this._prepareForPersistence = opts?.prepareForPersistence;
  }

  /** 实时条目数组。调用方可以就地修改条目（修改后 touch()）。 */
  get entries(): LogEntry[] {
    return this._entries;
  }

  /** 替换后端数组（初始化、恢复时使用）。 */
  replace(entries: LogEntry[]): void {
    this._entries = entries;
    this._pendingOps = [];
    this._persistedIds = new Set(entries.map((entry) => entry.id));
    this._peekedIds.clear();
    this._entrySnapshots.clear();
    if (this._guardEnabled) {
      for (const entry of entries) this._entrySnapshots.set(entry.id, snapshotEntry(entry));
    }
    this.invalidateIndexes();
  }

  /** 丢弃所有索引（rewind 截断等带外结构变更后必须调用）。 */
  invalidateIndexes(): void {
    this._idIndex.clear();
    this._toolCallIdIndex.clear();
    this._indexedUpTo = 0;
  }

  /** 扩展索引到当前 _entries 长度。 */
  private _extendIndexes(): void {
    if (this._indexedUpTo > this._entries.length) {
      // 数组在若缩短了——从零重建。
      this.invalidateIndexes();
    }
    for (let i = this._indexedUpTo; i < this._entries.length; i++) {
      const e = this._entries[i];
      if (!this._idIndex.has(e.id)) this._idIndex.set(e.id, i);
      if (e.type === "tool_call") {
        const callId = String((e.meta as Record<string, unknown>)["toolCallId"] ?? "");
        // 首次出现优先——与此函数替换的前向扫描语义一致。
        if (callId && !this._toolCallIdIndex.has(callId)) {
          this._toolCallIdIndex.set(callId, i);
        }
      }
    }
    this._indexedUpTo = this._entries.length;
  }

  /** 按 ID 查找条目（等价于 entries.find(e => e.id === id)，包含已丢弃条目）。 */
  findEntryById(id: string): LogEntry | undefined {
    for (let attempt = 0; attempt < 2; attempt++) {
      this._extendIndexes();
      const idx = this._idIndex.get(id);
      if (idx === undefined) return undefined;
      const e = this._entries[idx];
      if (e && e.id === id) return e;
      this.invalidateIndexes();
    }
    return this._entries.find((e) => e.id === id);
  }

  /**
   * 按 toolCallId 查找 tool_call 条目（包含已丢弃条目）。
   * 仅从活动窗口起始处向前扫描。
   */
  findToolCallByCallId(callId: string): LogEntry | undefined {
    if (!callId) return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      this._extendIndexes();
      const idx = this._toolCallIdIndex.get(callId);
      if (idx === undefined) return undefined;
      const e = this._entries[idx];
      if (
        e && e.type === "tool_call" &&
        String((e.meta as Record<string, unknown>)["toolCallId"] ?? "") === callId
      ) {
        return e;
      }
      this.invalidateIndexes();
    }
    return this._entries.find(
      (e) => e.type === "tool_call" &&
        String((e.meta as Record<string, unknown>)["toolCallId"] ?? "") === callId,
    );
  }

  get revision(): number {
    return this._revision;
  }

  bumpRevision(): void {
    this._revision += 1;
  }

  /**
   * 仅在全新/影子存储上重置：live session 的 revision 必须保持单调递增，
   * 以便 UI 监控始终检测到交换。
   */
  resetRevision(): void {
    this._revision = 0;
  }

  /** 订阅变更通知。返回取消订阅的函数。 */
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  notifyListeners(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (error) {
        // 监听器属于表现层：异常不能让日志提交回滚或中断。
        console.warn(
          `[log] listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** 递增 revision 并通知——在任何就地条目变更后调用。 */
  touch(): void {
    this.bumpRevision();
    this.notifyListeners();
  }

  get idAllocator(): LogIdAllocator {
    return this._idAllocator;
  }

  set idAllocator(alloc: LogIdAllocator) {
    this._idAllocator = alloc;
  }

  nextId(type: LogEntry["type"]): string {
    return this._idAllocator.next(type);
  }

  /** 追加条目，同时为 provider-round 类型打 providerRoundId 标记。 */
  append(entry: LogEntry): void {
    stampProviderRoundId(entry);
    // 关闭合同盲点：若数组在未调用 invalidate 的情况下缩短，
    // 然后又增长回旧水印以上，惰性扩展的索引会跳过重新增长的区间。
    // 任何在缩短状态下 append 的操作都会触发重建而非扩展。
    if (this._entries.length < this._indexedUpTo) {
      this.invalidateIndexes();
    }
    this._entries.push(entry);
    if (this._guardEnabled) this._entrySnapshots.set(entry.id, snapshotEntry(entry));
    this._queueUpsert(entry.id);
    this.touch();
  }

  /**
   * 原子追加一次压缩提交：marker 与 context 进同一 pending checkpoint，
   * 落盘时序列化为一条 compact_checkpoint 记录。
   */
  appendCheckpoint(
    marker: LogEntry,
    context: LogEntry,
    meta: CompactCheckpointMeta,
  ): void {
    if (this._entries.length < this._indexedUpTo) {
      this.invalidateIndexes();
    }
    marker.meta["checkpointId"] = meta.checkpointId;
    marker.meta["archiveFile"] = meta.archiveFile;
    marker.meta["archiveIndexFile"] = meta.archiveIndexFile;
    marker.meta["compactIndex"] = meta.compactIndex;
    marker.meta["scenario"] = meta.scenario;
    context.meta["checkpointId"] = meta.checkpointId;
    context.meta["compactIndex"] = meta.compactIndex;
    this._entries.push(marker, context);
    if (this._guardEnabled) {
      this._entrySnapshots.set(marker.id, snapshotEntry(marker));
      this._entrySnapshots.set(context.id, snapshotEntry(context));
    }
    this._pendingOps.push({
      kind: "checkpoint",
      markerId: marker.id,
      contextId: context.id,
      meta,
    });
    this.touch();
  }

  private _queueUpsert(id: string): void {
    const last = this._pendingOps[this._pendingOps.length - 1];
    if (last?.kind === "upsert" && last.id === id) return;
    this._pendingOps.push({ kind: "upsert", id });
  }

  private _applyFlags(entry: LogEntry, flags: EntryFlags, dropPresentation?: true): void {
    if (flags.discarded !== undefined) {
      if (flags.discarded) entry.discarded = true;
      else delete entry.discarded;
    }
    if (flags.archived !== undefined) entry.archived = flags.archived;

    const meta = entry.meta as Record<string, unknown>;
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

    if (dropPresentation) {
      entry.display = "";
      entry.meta = retainArchivedMeta(meta);
    }
  }

  /** 通过网关更新条目；直接改 entries 不会被持久化。 */
  updateEntry(id: string, mutator: (entry: LogEntry) => void): void {
    const entry = this.findEntryById(id);
    if (!entry) return;
    mutator(entry);
    this._queueUpsert(id);
    this.touch();
  }

  /** 批量翻转闭集 flags；compact_marker 一律走完整 upsert。 */
  patchFlags(ids: readonly string[], flags: EntryFlags, opts?: { dropPresentation?: true }): void {
    const dropPresentation = opts?.dropPresentation;
    const hasFlags = Object.keys(flags).length > 0 || dropPresentation === true;
    if (!hasFlags) return;

    const patchIds: string[] = [];
    for (const id of ids) {
      const entry = this.findEntryById(id);
      if (!entry) continue;
      this._applyFlags(entry, flags, dropPresentation);
      if (entry.type === "compact_marker") {
        this._queueUpsert(id);
      } else {
        patchIds.push(id);
      }
    }
    if (patchIds.length > 0) {
      const op: PendingLogOp = { kind: "patch", ids: patchIds, flags: { ...flags } };
      if (dropPresentation) op.dropPresentation = true;
      this._pendingOps.push(op);
    }
    this.touch();
  }

  /** 回退：截断该条目及其之后的全部条目，并记录 truncate。 */
  truncateFrom(entryId: string): void {
    const index = this._entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return;
    const removed = this._entries.slice(index);
    this._entries.length = index;
    for (const entry of removed) {
      this._entrySnapshots.delete(entry.id);
      this._persistedIds.delete(entry.id);
    }
    this.invalidateIndexes();

    const survivingIds = new Set(this._entries.map((entry) => entry.id));
    this._pendingOps = this._pendingOps.flatMap((op): PendingLogOp[] => {
      if (op.kind === "upsert") return survivingIds.has(op.id) ? [op] : [];
      if (op.kind === "patch") {
        const ids = op.ids.filter((id) => survivingIds.has(id));
        return ids.length > 0 ? [{ ...op, ids }] : [];
      }
      if (op.kind === "checkpoint") {
        return survivingIds.has(op.markerId) && survivingIds.has(op.contextId) ? [op] : [];
      }
      return [];
    });
    this._pendingOps.push({ kind: "truncate", fromEntryId: entryId });
    this.touch();
  }

  /** 归档条目：content 置空并标 archived；变更以 upsert 记录。 */
  archiveEntries(
    ids: readonly string[],
    meta?: { checkpointId: string; archiveFile: string },
  ): void {
    const changed: string[] = [];
    for (const id of ids) {
      const entry = this.findEntryById(id);
      if (!entry) continue;
      entry.content = null;
      entry.archived = true;
      if (meta) {
        entry.meta["checkpointId"] = meta.checkpointId;
        entry.meta["archiveFile"] = meta.archiveFile;
      }
      changed.push(id);
    }
    for (const id of changed) this._queueUpsert(id);
    if (changed.length > 0) this.touch();
  }

  /** 撤销归档：按归档记录恢复 content/display/meta，并清 archived。 */
  restoreArchivedEntries(records: readonly ArchivedEntryRecord[]): void {
    const recordMap = new Map(records.map((record) => [record.id, record]));
    const changed: string[] = [];
    for (const entry of this._entries) {
      if (!entry.archived) continue;
      const record = recordMap.get(entry.id);
      if (!record) continue;
      entry.content = record.content;
      if (record.display !== undefined) entry.display = record.display;
      // 归档快照可能早于运行时的 revert 标记；当前条目的保留键必须覆盖快照。
      const retained = retainArchivedMeta(entry.meta as Record<string, unknown>);
      entry.meta = { ...(record.meta ?? {}), ...retained };
      entry.archived = false;
      changed.push(entry.id);
    }
    for (const id of changed) this._queueUpsert(id);
    if (changed.length > 0) this.touch();
  }

  /** 清理折叠边界前已归档条目的 display/meta（走 patch + dropPresentation）。 */
  stripArchivedPresentation(foldEndIdx: number): number {
    const ids = collectPresentationStripIds(this._entries, foldEndIdx);
    if (ids.length > 0) {
      this.patchFlags(ids, { archived: true }, { dropPresentation: true });
    }
    return ids.length;
  }

  private _touchedIds(): Set<string> {
    const touched = new Set<string>();
    for (const op of this._pendingOps) {
      if (op.kind === "upsert") touched.add(op.id);
      else if (op.kind === "patch") for (const id of op.ids) touched.add(id);
      else if (op.kind === "checkpoint") {
        touched.add(op.markerId);
        touched.add(op.contextId);
      }
    }
    return touched;
  }

  private _prepareForDisk(entry: LogEntry): LogEntry | null {
    if (this._shouldPersist && !this._shouldPersist(entry)) return null;
    return this._prepareForPersistence ? this._prepareForPersistence(entry) : entry;
  }

  /** 预览待写记录（不清队列）；append 成功后再 commit。 */
  peekPendingRecords(startSeq: number): JsonlRecord[] {
    const records: JsonlRecord[] = [];
    const ts = new Date().toISOString();
    this._peekedIds.clear();
    let seq = startSeq;
    for (const op of this._pendingOps) {
      if (op.kind === "upsert") {
        const entry = this.findEntryById(op.id);
        if (!entry) continue;
        const prepared = this._prepareForDisk(entry);
        if (!prepared) continue;
        records.push({
          v: LOG_JSONL_VERSION,
          op: "upsert",
          seq: seq++,
          ts,
          entries: [entryToSnake(prepared)],
          ...(this._persistedIds.has(entry.id) ? { replaces: true as const } : {}),
        });
        this._peekedIds.add(entry.id);
        continue;
      }
      if (op.kind === "checkpoint") {
        const marker = this.findEntryById(op.markerId);
        const context = this.findEntryById(op.contextId);
        if (!marker || !context) continue;
        const preparedMarker = this._prepareForDisk(marker);
        const preparedContext = this._prepareForDisk(context);
        if (!preparedMarker || !preparedContext) continue;
        records.push({
          v: LOG_JSONL_VERSION,
          op: "compact_checkpoint",
          seq: seq++,
          ts,
          checkpointId: op.meta.checkpointId,
          archiveFile: op.meta.archiveFile,
          archiveIndexFile: op.meta.archiveIndexFile,
          compactIndex: op.meta.compactIndex,
          scenario: op.meta.scenario,
          marker: entryToSnake(preparedMarker),
          context: entryToSnake(preparedContext),
        });
        this._peekedIds.add(marker.id);
        this._peekedIds.add(context.id);
        continue;
      }
      if (op.kind === "patch") {
        const ids = this._shouldPersist
          ? op.ids.filter((id) => {
              const entry = this.findEntryById(id);
              return entry ? this._shouldPersist!(entry) : false;
            })
          : [...op.ids];
        if (ids.length === 0) continue;
        const flags = { ...op.flags };
        const hasFlags = Object.keys(flags).length > 0;
        if (!hasFlags && !op.dropPresentation) continue;
        records.push({
          v: LOG_JSONL_VERSION,
          op: "patch",
          seq: seq++,
          ts,
          ids,
          ...(hasFlags ? { flags } : {}),
          ...(op.dropPresentation ? { dropPresentation: true as const } : {}),
        });
        continue;
      }
      records.push({
        v: LOG_JSONL_VERSION,
        op: "truncate",
        seq: seq++,
        ts,
        fromEntryId: op.fromEntryId,
      });
    }
    return records;
  }

  /** 追加成功后提交：清空队列并刷新守卫快照。 */
  commitPendingRecords(): void {
    const touched = this._touchedIds();
    for (const id of this._peekedIds) this._persistedIds.add(id);
    this._peekedIds.clear();
    this._pendingOps = [];
    if (this._guardEnabled) {
      for (const id of touched) {
        const entry = this.findEntryById(id);
        if (entry) this._entrySnapshots.set(id, snapshotEntry(entry));
        else this._entrySnapshots.delete(id);
      }
    }
  }

  /** 取出并清空待写记录；seq 由调用方给定的起点连续分配。 */
  drainPendingRecords(startSeq: number): JsonlRecord[] {
    const records = this.peekPendingRecords(startSeq);
    this.commitPendingRecords();
    return records;
  }

  /** 快照写入成功后登记已落盘 id（快照里的条目都是文件中的首次出现）。 */
  markPersisted(ids: Iterable<string>): void {
    for (const id of ids) this._persistedIds.add(id);
  }

  /** 开发/测试守卫：显式开启后才记录快照，生产不承担额外内存。 */
  enableDirectMutationGuard(): void {
    this._guardEnabled = true;
    this._entrySnapshots.clear();
    for (const entry of this._entries) this._entrySnapshots.set(entry.id, snapshotEntry(entry));
  }

  /** 开发/测试守卫：直接改 entries 会在这里暴露。 */
  assertNoDirectMutations(): void {
    if (!this._guardEnabled) return;
    const pendingIds = new Set<string>();
    for (const op of this._pendingOps) {
      if (op.kind === "upsert") pendingIds.add(op.id);
      else if (op.kind === "patch") for (const id of op.ids) pendingIds.add(id);
    }
    for (const entry of this._entries) {
      if (pendingIds.has(entry.id)) continue;
      const snapshot = this._entrySnapshots.get(entry.id);
      if (snapshot === undefined) continue;
      if (snapshot !== snapshotEntry(entry)) {
        throw new Error(
          `Direct mutation detected for entry '${entry.id}'; use SessionLog gateway methods instead.`,
        );
      }
    }
  }

  /** 最近一次 live compact_marker 之后第一个条目的索引。 */
  activeWindowStartIdx(): number {
    for (let i = this._entries.length - 1; i >= 0; i--) {
      if (this._entries[i].type === "compact_marker" && !this._entries[i].discarded) {
        return i + 1;
      }
    }
    return 0;
  }

  /**
   * 返回日志中每个 turn 的元数据。
   * 每个条目包含 turnKind（来自 turn_start meta）和预览文本。
   * 调用方按 turnKind、活动窗口等条件过滤。
   *
   * 已归档且 presentation 被清理的条目，其 turnKind/preview 由归档索引兜底。
   */
  listTurns(archivedTurnInfo?: ReadonlyMap<string, ArchivedTurnInfo>): TurnListing[] {
    let lastCompactMarkerIdx = -1;
    for (let i = this._entries.length - 1; i >= 0; i--) {
      if (this._entries[i].type === "compact_marker" && !this._entries[i].discarded) {
        lastCompactMarkerIdx = i;
        break;
      }
    }

    const turns: TurnListing[] = [];

    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i];
      if (entry.discarded) continue;
      if (entry.type !== "input_received" && entry.type !== "turn_start") continue;

      const meta = entry.meta as Record<string, unknown>;
      const archived = archivedTurnInfo?.get(entry.id);
      const rawKind = entry.type === "input_received" ? meta.inputKind : meta.turnKind;
      const turnKind: TurnKind = (typeof rawKind === "string"
        ? rawKind as TurnKind
        : archived?.turnKind as TurnKind | undefined) ?? "user";
      if (turnKind !== "user" && turnKind !== "summarize" && turnKind !== "compact") continue;

      const display = entry.display || archived?.preview || "";
      const preview = entry.type === "input_received"
        ? display.replace(/\s+/g, " ").trim().slice(0, 240)
        : "";

      turns.push({
        turnIndex: entry.turnIndex,
        entryIndex: i,
        turnKind,
        preview: preview || `(turn ${entry.turnIndex})`,
        timestamp: entry.timestamp,
        inActiveWindow: i > lastCompactMarkerIdx,
      });
    }

    return turns;
  }
}
