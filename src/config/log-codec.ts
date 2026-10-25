/**
 * 日志条目的磁盘编解码（snake_case ↔ camelCase）。
 *
 * log.json（legacy）与 log.jsonl 共用这一份规则，避免两套字段口径漂移。
 */

import type { LogIdAllocator } from "../context/entry/id-allocator.js";
import type { LogEntry, LogEntryType, TuiDisplayKind } from "../context/entry/types.js";
import type { ChildSessionMetaRecord } from "../session/tree-types.js";
import type { LogSessionMeta } from "./session-meta.js";

/** 日志加载结果（log.json 与 log.jsonl 共用）。 */
export interface LoadLogResult {
  meta: LogSessionMeta;
  entries: LogEntry[];
  idAllocator: LogIdAllocator;
  /** true 表示只加载了活动窗口（R-2 有界路径）；缺省/undefined = 全量。 */
  bounded?: boolean;
  /** 有界路径下活动窗口首条记录（marker）的字节偏移。 */
  windowStartOffset?: number;
}

/** 将 LogEntry 对象转换为 snake_case 键名的记录（用于 JSON 序列化） */
export function entryToSnake(entry: LogEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    turn_index: entry.turnIndex,
    tui_visible: entry.tuiVisible,
    display_kind: entry.displayKind,
    display: entry.display,
    api_role: entry.apiRole,
    content: entry.content,
    archived: entry.archived,
    meta: entry.meta,
  };
  if (entry.roundIndex !== undefined) obj.round_index = entry.roundIndex;
  if (entry.discarded) obj.discarded = true;
  return obj;
}

/** 从 snake_case 键名的记录恢复为 LogEntry 对象（用于 JSON 反序列化） */
export function entryFromSnake(obj: Record<string, unknown>): LogEntry {
  return {
    id: obj.id as string,
    type: obj.type as LogEntryType,
    timestamp: obj.timestamp as number,
    turnIndex: (obj.turn_index as number) ?? 0,
    roundIndex: obj.round_index as number | undefined,
    tuiVisible: (obj.tui_visible as boolean) ?? false,
    displayKind: (obj.display_kind as TuiDisplayKind | null) ?? null,
    display: (obj.display as string) ?? "",
    apiRole: (obj.api_role as LogEntry["apiRole"]) ?? null,
    content: obj.content ?? null,
    archived: (obj.archived as boolean) ?? false,
    meta: (obj.meta as Record<string, unknown>) ?? {},
    ...(obj.discarded ? { discarded: true } : {}),
  };
}

/** 会话元数据 → 日志头部/session 记录的 snake_case 视图。 */
export function buildLogHead(meta: LogSessionMeta): Record<string, unknown> {
  return {
    version: meta.version,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    project_path: meta.projectPath,
    model_config_name: meta.modelConfigName,
    model_provider: meta.modelProvider ?? null,
    model_selection_key: meta.modelSelectionKey ?? null,
    model_id: meta.modelId ?? null,
    initial_model: meta.initialModel ?? null,
    prompt_cache_affinity_key: meta.promptCacheAffinityKey ?? null,
    summary: meta.summary,
    title: meta.title ?? null,
    turn_count: meta.turnCount,
    compact_count: meta.compactCount,
    thinking_level: meta.thinkingLevel,
    child_sessions: meta.childSessions ?? null,
    inbox: meta.inbox ?? null,
  };
}

function normalizeChildSessionMeta(value: unknown): ChildSessionMetaRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw["id"] !== "string" || !raw["id"].trim() ||
    typeof raw["template"] !== "string" || !raw["template"].trim() ||
    (raw["mode"] !== "oneshot" && raw["mode"] !== "persistent")
  ) return undefined;

  const numericId = raw["numericId"];
  if (typeof numericId !== "number" || !Number.isInteger(numericId) || numericId < 0) return undefined;
  const orderRaw = raw["order"];
  const order = typeof orderRaw === "number" && Number.isInteger(orderRaw) && orderRaw >= 0 ? orderRaw : numericId;
  const outcome = raw["outcome"] === "none" || raw["outcome"] === "completed" || raw["outcome"] === "interrupted" || raw["outcome"] === "error"
    ? raw["outcome"]
    : undefined;
  const lifecycle = raw["lifecycle"] === "running" || raw["lifecycle"] === "blocked" || raw["lifecycle"] === "idle" || raw["lifecycle"] === "archived"
    ? raw["lifecycle"]
    : outcome === "completed" || outcome === "error" || outcome === "interrupted"
      ? "archived"
      : "idle";
  const status = raw["status"] === "working" || raw["status"] === "idle" || raw["status"] === "error" || raw["status"] === "interrupted" || raw["status"] === "terminated" || raw["status"] === "completed"
    ? raw["status"]
    : undefined;
  const terminationCause = raw["terminationCause"] === "natural" || raw["terminationCause"] === "parent_kill" || raw["terminationCause"] === "user_targeted_kill" || raw["terminationCause"] === "user_mass_interrupt"
    ? raw["terminationCause"]
    : undefined;

  const record: ChildSessionMetaRecord = {
    id: raw["id"],
    numericId,
    template: raw["template"],
    mode: raw["mode"],
    lifecycle,
    order,
  };
  if (outcome !== undefined) record.outcome = outcome;
  if (status !== undefined) record.status = status as ChildSessionMetaRecord["status"];
  if (terminationCause !== undefined) record.terminationCause = terminationCause;
  if (Array.isArray(raw["inbox"])) {
    record.inbox = raw["inbox"].filter((item) => Boolean(item && typeof item === "object" && !Array.isArray(item))) as ChildSessionMetaRecord["inbox"];
  }
  return record;
}

/** 日志头部 → LogSessionMeta（loadLog 与 JSONL replay 共用同一口径）。 */
export function sessionMetaFromSnake(raw: Record<string, unknown>): LogSessionMeta {
  // meta.json 用 null 表示缺失；LogSessionMeta 的口径是 undefined，别把 null 泄漏给调用方。
  const optionalString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const idCounters = (() => {
    if (!raw.id_counters || typeof raw.id_counters !== "object" || Array.isArray(raw.id_counters)) {
      return undefined;
    }
    const counters: Record<string, number> = {};
    for (const [prefix, count] of Object.entries(raw.id_counters as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
        counters[prefix] = count;
      }
    }
    return counters;
  })();
  const recentEvents = Array.isArray(raw.recent_session_events)
    ? (raw.recent_session_events as unknown[]).filter((item): item is string => typeof item === "string")
    : undefined;
  const tokens = (() => {
    if (!raw.tokens || typeof raw.tokens !== "object" || Array.isArray(raw.tokens)) return undefined;
    const source = raw.tokens as Record<string, unknown>;
    const input = source["input"];
    const output = source["output"];
    const cacheRead = source["cacheRead"];
    if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return undefined;
    if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return undefined;
    if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead) || cacheRead < 0) return undefined;
    return { input, output, cacheRead };
  })();
  const lastTurnEndStatus = raw.last_turn_end_status === "completed"
    || raw.last_turn_end_status === "interrupted"
    || raw.last_turn_end_status === "error"
    ? raw.last_turn_end_status
    : undefined;
  const selfPhase = raw.self_phase === "idle"
    || raw.self_phase === "thinking"
    || raw.self_phase === "tool_calling"
    || raw.self_phase === "generating"
    || raw.self_phase === "waiting"
    ? raw.self_phase
    : undefined;
  return {
    version: (raw.version as number) ?? 2,
    sessionId: (raw.session_id as string) ?? "",
    createdAt: (raw.created_at as string) ?? "",
    updatedAt: (raw.updated_at as string) ?? "",
    projectPath: (raw.project_path as string) ?? "",
    modelConfigName: (raw.model_config_name as string) ?? "",
    modelProvider: optionalString(raw.model_provider),
    modelSelectionKey: optionalString(raw.model_selection_key),
    modelId: optionalString(raw.model_id),
    initialModel: optionalString(raw.initial_model),
    promptCacheAffinityKey: optionalString(raw.prompt_cache_affinity_key),
    summary: (raw.summary as string) ?? "",
    title: optionalString(raw.title),
    turnCount: (raw.turn_count as number) ?? 0,
    compactCount: (raw.compact_count as number) ?? 0,
    thinkingLevel: (raw.thinking_level as string) ?? "",
    persistencePolicy: typeof raw.persistence_policy === "number" ? raw.persistence_policy : undefined,
    childSessions: Array.isArray(raw.child_sessions)
      ? (raw.child_sessions as unknown[]).map(normalizeChildSessionMeta).filter((record): record is ChildSessionMetaRecord => record !== undefined)
      : undefined,
    inbox: Array.isArray(raw.inbox)
      ? (raw.inbox as LogSessionMeta["inbox"])
      : undefined,
    idCounters,
    workCount: typeof raw.work_count === "number" && Number.isInteger(raw.work_count) && raw.work_count >= 0
      ? raw.work_count
      : undefined,
    lifetimeToolCallCount: typeof raw.tool_call_count === "number" && Number.isInteger(raw.tool_call_count) && raw.tool_call_count >= 0
      ? raw.tool_call_count
      : undefined,
    tokens,
    firstInput: typeof raw.first_input === "number" && Number.isFinite(raw.first_input) && raw.first_input >= 0
      ? raw.first_input
      : undefined,
    firstUserMessageTokens: typeof raw.first_user_message_tokens === "number" && Number.isFinite(raw.first_user_message_tokens) && raw.first_user_message_tokens >= 0
      ? raw.first_user_message_tokens
      : undefined,
    lastToolCallSummary: optionalString(raw.last_tool_call_summary),
    recentSessionEvents: recentEvents,
    lastTurnEndStatus,
    selfPhase,
  };
}
