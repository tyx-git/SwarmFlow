import type { LogEntry } from "./context/log-entry.js";

/** 摘要来源类型 */
export type SummaryOrigin = "agent" | "manual";

/** 活动上下文分组——将具有相同 contextId 的条目聚合在一起 */
export interface ActiveContextGroup {
  /** 上下文 ID */
  contextId: string;
  /** 分组中的条目列表 */
  entries: Array<{ entry: LogEntry; index: number }>;
  /** 分组中第一个条目的全局索引 */
  firstIndex: number;
  /** 分组中最后一个条目的全局索引 */
  lastIndex: number;
  /** 分组覆盖的起始 turnIndex */
  turnStart: number;
  /** 分组覆盖的结束 turnIndex */
  turnEnd: number;
  /** 分组是否包含用户消息 */
  hasUserMessage: boolean;
  /**
   * 此分组在组装视图中所属的 turn。摘要属于最近的前一个存活用户消息的 turn；
   * 所有其他分组保持自己的 turn。在排序后计算。
   */
  assignedTurn: number;
  /** 是否为摘要条目 */
  isSummary: boolean;
  /** 摘要来源 */
  summaryOrigin?: SummaryOrigin;
  /** 摘要深度 */
  summaryDepth?: number;
  /** 此摘要覆盖的上下文 ID 列表 */
  coveredContextIds?: string[];
}

/** 活动上下文中的单个条目项 */
export interface ActiveContextEntryItem {
  /** 项类型标识 */
  kind: "entry";
  /** 日志条目 */
  entry: LogEntry;
  /** 全局索引 */
  index: number;
}

/** 活动上下文中的分组项 */
export interface ActiveContextGroupItem {
  /** 项类型标识 */
  kind: "group";
  /** 上下文分组 */
  group: ActiveContextGroup;
}

/** 活动上下文项——单个条目或分组 */
export type ActiveContextItem = ActiveContextEntryItem | ActiveContextGroupItem;

/** 活动上下文视图——用于 UI 展示和 API 投影 */
export interface ActiveContextView {
  /** 活动窗口起始索引（最后一个 compact_marker 之后） */
  windowStartIdx: number;
  /** 视图中的项列表（条目和分组的混合） */
  items: ActiveContextItem[];
  /** 所有分组 */
  groups: ActiveContextGroup[];
  /** 按 contextId 索引的分组映射 */
  groupByContextId: Map<string, ActiveContextGroup>;
  /** 分组的上下文 ID 顺序 */
  order: string[];
}

/** 活动上下文视图选项 */
export interface ActiveContextViewOptions {
  /** 是否包含压缩上下文条目。默认 true */
  includeCompactContext?: boolean;
  /** 是否包含无上下文 ID 的条目。默认 false */
  includeEntriesWithoutContext?: boolean;
}

/** 获取条目的上下文 ID，不存在或已丢弃时返回 null */
export function getEntryContextId(entry: LogEntry): string | null {
  if (entry.discarded) return null;
  const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
  if (ctxId === undefined || ctxId === null) return null;
  return String(ctxId);
}

/** 查找活动窗口起始位置（最后一个 compact_marker 之后的索引） */
export function findActiveWindowStart(entries: LogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      return i + 1;
    }
  }
  return 0;
}

/** 安全地将值转换为字符串数组 */
function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** 从条目元数据中提取摘要来源 */
function getSummaryOrigin(entry: LogEntry): SummaryOrigin | undefined {
  const raw = (entry.meta as Record<string, unknown>)["summaryOrigin"];
  return raw === "manual" || raw === "agent" ? raw : undefined;
}

/** 检查条目是否为用户自己的消息（受保护的用户上下文） */
function isUserContextEntry(entry: LogEntry): boolean {
  // 只有用户自己的消息受保护。系统通知、对等消息和注入的命令提示
  // 共享 user_message 条目类型，但不是用户的话
  // （没有 inputKind 的条目早于该标签，为安全起见视为用户消息）。
  if (entry.type === "user_message") {
    const inputKind = (entry.meta as Record<string, unknown>)["inputKind"];
    return inputKind === undefined || inputKind === "user";
  }
  if (entry.type !== "input_received") return false;
  const inputKind = (entry.meta as Record<string, unknown>)["inputKind"];
  return inputKind === "user";
}

/** 构建新的上下文分组 */
function buildGroup(ctxId: string, entry: LogEntry, index: number): ActiveContextGroup {
  const meta = entry.meta as Record<string, unknown>;
  const coveredTurnStart = typeof meta["coveredTurnStart"] === "number"
    ? meta["coveredTurnStart"]
    : entry.turnIndex;
  const coveredTurnEnd = typeof meta["coveredTurnEnd"] === "number"
    ? meta["coveredTurnEnd"]
    : entry.turnIndex;
  return {
    contextId: ctxId,
    entries: [{ entry, index }],
    firstIndex: index,
    lastIndex: index,
    turnStart: coveredTurnStart,
    turnEnd: coveredTurnEnd,
    hasUserMessage: isUserContextEntry(entry),
    assignedTurn: coveredTurnStart,
    isSummary: entry.type === "summary",
    summaryOrigin: entry.type === "summary" ? getSummaryOrigin(entry) : undefined,
    summaryDepth: entry.type === "summary"
      ? Number(meta["summaryDepth"] ?? 1)
      : undefined,
    coveredContextIds: entry.type === "summary"
      ? getStringArray(meta["coveredContextIds"])
      : undefined,
  };
}

/** 将条目追加到现有分组中 */
function appendToGroup(group: ActiveContextGroup, entry: LogEntry, index: number): void {
  const meta = entry.meta as Record<string, unknown>;
  group.entries.push({ entry, index });
  group.firstIndex = Math.min(group.firstIndex, index);
  group.lastIndex = Math.max(group.lastIndex, index);
  if (!group.isSummary) {
    group.turnStart = Math.min(group.turnStart, entry.turnIndex);
    group.turnEnd = Math.max(group.turnEnd, entry.turnIndex);
    group.hasUserMessage = group.hasUserMessage || isUserContextEntry(entry);
  }
  if (entry.type === "summary") {
    group.isSummary = true;
    group.summaryOrigin = getSummaryOrigin(entry);
    group.summaryDepth = Number(meta["summaryDepth"] ?? 1);
    group.coveredContextIds = getStringArray(meta["coveredContextIds"]);
    if (typeof meta["coveredTurnStart"] === "number") {
      group.turnStart = meta["coveredTurnStart"] as number;
    }
    if (typeof meta["coveredTurnEnd"] === "number") {
      group.turnEnd = meta["coveredTurnEnd"] as number;
    }
  }
}

/** 在项列表中查找指定 contextId 分组的索引 */
function itemIndexForGroup(items: ActiveContextItem[], contextId: string): number {
  return items.findIndex((item) => item.kind === "group" && item.group.contextId === contextId);
}

/** 构建活动上下文视图——将日志条目分组并排序用于 UI 展示 */
export function buildActiveContextView(
  entries: LogEntry[],
  options: ActiveContextViewOptions = {},
): ActiveContextView {
  const includeCompactContext = options.includeCompactContext ?? true;
  const includeEntriesWithoutContext = options.includeEntriesWithoutContext ?? false;
  const windowStartIdx = findActiveWindowStart(entries);
  const items: ActiveContextItem[] = [];
  const groupByContextId = new Map<string, ActiveContextGroup>();

  const insertGroup = (group: ActiveContextGroup, insertAt?: number): void => {
    groupByContextId.set(group.contextId, group);
    const item: ActiveContextGroupItem = { kind: "group", group };
    if (insertAt === undefined || insertAt < 0 || insertAt > items.length) {
      items.push(item);
    } else {
      items.splice(insertAt, 0, item);
    }
  };

  for (let i = windowStartIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.discarded) continue;
    if (entry.type === "system_prompt") continue;
    if (entry.type === "compact_marker") continue;
    if (entry.type === "compact_context" && !includeCompactContext) continue;

    const ctxId = getEntryContextId(entry);
    if (!ctxId) {
      if (includeEntriesWithoutContext && (entry.apiRole !== null || entry.type === "reasoning")) {
        items.push({ kind: "entry", entry, index: i });
      }
      continue;
    }

    const existing = groupByContextId.get(ctxId);
    if (existing) {
      appendToGroup(existing, entry, i);
      continue;
    }

    const group = buildGroup(ctxId, entry, i);
    if (entry.type !== "summary") {
      insertGroup(group);
      continue;
    }

    const covered = group.coveredContextIds ?? [];
    const coveredIndexes = covered
      .map((coveredId) => itemIndexForGroup(items, coveredId))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b);

    if (coveredIndexes.length === 0) {
      insertGroup(group);
      continue;
    }

    const insertAt = coveredIndexes[0];
    for (let j = coveredIndexes.length - 1; j >= 0; j--) {
      const idx = coveredIndexes[j];
      const [removed] = items.splice(idx, 1);
      if (removed?.kind === "group") {
        groupByContextId.delete(removed.group.contextId);
      }
    }
    insertGroup(group, insertAt);
  }

  // 按 turn 稳定排序项，使得队列中的输入（在 turn 中途以更高 turnIndex
  // 写入日志）永远不会出现在当前 turn 的分组之前。
  // 同一 turn 内，保持原始日志顺序。
  items.sort((a, b) => {
    const aTurn = a.kind === "group" ? a.group.turnStart : a.entry.turnIndex;
    const bTurn = b.kind === "group" ? b.group.turnStart : b.entry.turnIndex;
    return aTurn - bTurn;
  });

  // 将每个分组分配到其视图 turn。摘要属于最近的前一个存活用户消息的
  // turn（因此覆盖锚点已消失的摘要折叠到前一个活跃 turn 中，
  // 相邻的此类摘要落在同一 turn 中）；所有其他分组保持自己的 turn。
  let lastAnchorTurn = -1;
  for (const item of items) {
    if (item.kind !== "group") continue;
    const group = item.group;
    if (group.isSummary) {
      group.assignedTurn = lastAnchorTurn >= 0 ? lastAnchorTurn : group.turnStart;
    } else {
      group.assignedTurn = group.turnStart;
      if (group.hasUserMessage) lastAnchorTurn = group.turnStart;
    }
  }

  const groups = items
    .filter((item): item is ActiveContextGroupItem => item.kind === "group")
    .map((item) => item.group);

  return {
    windowStartIdx,
    items,
    groups,
    groupByContextId,
    order: groups.map((group) => group.contextId),
  };
}

/** 将活动上下文视图展平为日志条目列表 */
export function flattenActiveContextEntries(view: ActiveContextView): LogEntry[] {
  const out: LogEntry[] = [];
  for (const item of view.items) {
    if (item.kind === "entry") {
      out.push(item.entry);
      continue;
    }
    for (const { entry } of item.group.entries) {
      out.push(entry);
    }
  }
  return out;
}

/** 展开上下文范围——返回从 from 到 to 之间的所有上下文 ID */
export function expandContextRange(
  from: string,
  to: string,
  view: ActiveContextView,
): { contextIds: string[]; error?: string } {
  const fromIdx = view.order.indexOf(from);
  if (fromIdx < 0) {
    return { contextIds: [], error: `"from" context_id "${from}" not found in the active context.` };
  }
  const toIdx = view.order.indexOf(to);
  if (toIdx < 0) {
    return { contextIds: [], error: `"to" context_id "${to}" not found in the active context.` };
  }
  if (fromIdx > toIdx) {
    return { contextIds: [], error: `"from" ("${from}") appears after "to" ("${to}") in spatial order. Swap them or check show_context.` };
  }
  return { contextIds: view.order.slice(fromIdx, toIdx + 1) };
}
