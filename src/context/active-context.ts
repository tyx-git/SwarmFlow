import type { LogEntry } from "./context/log-entry.js";

export type SummaryOrigin = "agent" | "manual";

export interface ActiveContextGroup {
  contextId: string;
  entries: Array<{ entry: LogEntry; index: number }>;
  firstIndex: number;
  lastIndex: number;
  turnStart: number;
  turnEnd: number;
  hasUserMessage: boolean;
  /**
   * The turn this group belongs to in the assembled view. Summaries belong
   * to the turn of the nearest preceding surviving user message; all other
   * groups keep their own turn. Computed after ordering.
   */
  assignedTurn: number;
  isSummary: boolean;
  summaryOrigin?: SummaryOrigin;
  summaryDepth?: number;
  coveredContextIds?: string[];
}

export interface ActiveContextEntryItem {
  kind: "entry";
  entry: LogEntry;
  index: number;
}

export interface ActiveContextGroupItem {
  kind: "group";
  group: ActiveContextGroup;
}

export type ActiveContextItem = ActiveContextEntryItem | ActiveContextGroupItem;

export interface ActiveContextView {
  windowStartIdx: number;
  items: ActiveContextItem[];
  groups: ActiveContextGroup[];
  groupByContextId: Map<string, ActiveContextGroup>;
  order: string[];
}

export interface ActiveContextViewOptions {
  includeCompactContext?: boolean;
  includeEntriesWithoutContext?: boolean;
}

export function getEntryContextId(entry: LogEntry): string | null {
  if (entry.discarded) return null;
  const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
  if (ctxId === undefined || ctxId === null) return null;
  return String(ctxId);
}

export function findActiveWindowStart(entries: LogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      return i + 1;
    }
  }
  return 0;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function getSummaryOrigin(entry: LogEntry): SummaryOrigin | undefined {
  const raw = (entry.meta as Record<string, unknown>)["summaryOrigin"];
  return raw === "manual" || raw === "agent" ? raw : undefined;
}

function isUserContextEntry(entry: LogEntry): boolean {
  // Only the user's own messages are protected. System notices, peer
  // messages, and injected command prompts share the user_message entry
  // type but are not the user's words (entries without inputKind predate
  // the tag and are treated as user messages for safety).
  if (entry.type === "user_message") {
    const inputKind = (entry.meta as Record<string, unknown>)["inputKind"];
    return inputKind === undefined || inputKind === "user";
  }
  if (entry.type !== "input_received") return false;
  const inputKind = (entry.meta as Record<string, unknown>)["inputKind"];
  return inputKind === "user";
}

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

function itemIndexForGroup(items: ActiveContextItem[], contextId: string): number {
  return items.findIndex((item) => item.kind === "group" && item.group.contextId === contextId);
}

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

  // Stable-sort items by turn so that queued inputs (written to the log
  // mid-turn with a higher turnIndex) never appear before the current
  // turn's groups.  Within the same turn, original log order is preserved.
  items.sort((a, b) => {
    const aTurn = a.kind === "group" ? a.group.turnStart : a.entry.turnIndex;
    const bTurn = b.kind === "group" ? b.group.turnStart : b.entry.turnIndex;
    return aTurn - bTurn;
  });

  // Assign each group to its view turn. Summaries belong to the turn of the
  // nearest preceding surviving user message (so summaries whose covered
  // anchors are gone fold into the previous live turn, and adjacent such
  // summaries land in the same turn); all other groups keep their own turn.
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
