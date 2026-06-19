/**
 * SessionLog —— 结构化日志存储（P2.2）。
 *
 * 拥有只增的 LogEntry 数组、变更检测 revision、变更监听器、
 * 以及 entry ID 分配器。Session 暴露薄访问器，
 * 使运行时其余部分读写 _log 时保持不变。
 */

import { LogIdAllocator, type LogEntry, type TurnKind } from "../context/log-entry.js";

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
export interface TurnListing {
  turnIndex: number;
  entryIndex: number;
  turnKind: TurnKind;
  preview: string;
  timestamp: number;
  /** 该 turn 是否在活动窗口内（最近一次 compact_marker 之后）。 */
  inActiveWindow: boolean;
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

  /** 实时条目数组。调用方可以就地修改条目（修改后 touch()）。 */
  get entries(): LogEntry[] {
    return this._entries;
  }

  /** 替换后端数组（初始化、恢复时使用）。 */
  replace(entries: LogEntry[]): void {
    this._entries = entries;
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
      // 数组在我们背后缩短了——从零重建。
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
   * 以便 UI 订阅者始终检测到交换。
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
      listener();
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
    this.touch();
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
   */
  listTurns(): TurnListing[] {
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
      const turnKind = entry.type === "input_received"
        ? ((meta.inputKind as TurnKind) ?? "user")
        : ((meta.turnKind as TurnKind) ?? "user");
      if (turnKind !== "user" && turnKind !== "summarize" && turnKind !== "compact") continue;

      const preview = entry.type === "input_received"
        ? (entry.display || "").replace(/\s+/g, " ").trim().slice(0, 240)
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
