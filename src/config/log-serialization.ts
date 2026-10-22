/**
 * 会话日志（log.json）的落盘与读取。
 *
 * 磁盘形状用 snake_case，运行时 LogEntry 用 camelCase，两个方向都在这里转换。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LogIdAllocator } from "../context/entry/id-allocator.js";
import type { LogEntry, LogEntryType, TuiDisplayKind } from "../context/entry/types.js";
import type { ChildSessionMetaRecord } from "../session/tree-types.js";
import { saveSessionMeta, type LogSessionMeta } from "./session-meta.js";
import { nowTimestamps } from "./timestamps.js";

// ------------------------------------------------------------------
// LogEntry 的 camelCase → snake_case 转换
// ------------------------------------------------------------------

/** 将 LogEntry 对象转换为 snake_case 键名的记录（用于 JSON 序列化） */
function entryToSnake(entry: LogEntry): Record<string, unknown> {
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
function entryFromSnake(obj: Record<string, unknown>): LogEntry {
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
/** 更新项目元数据中的最后活跃时间 */
function updateProjectLastActive(projectDir: string, lastActiveAt: string): void {
  const projectJson = join(projectDir, "project.json");
  if (!existsSync(projectJson)) return;
  try {
    const raw = JSON.parse(readFileSync(projectJson, "utf-8"));
    raw.last_active_at = lastActiveAt;
    const tmp = projectJson + ".tmp";
    writeFileSync(tmp, JSON.stringify(raw, null, 2));
    renameSync(tmp, projectJson);
  } catch {
    // 尽力更新
  }
}

// ------------------------------------------------------------------
// saveLog / loadLog——日志保存与加载
// ------------------------------------------------------------------

/** 保存会话日志到磁盘（log.json + meta.json） */
export function saveLog(
  dir: string,
  meta: LogSessionMeta,
  entries: LogEntry[],
): void {
  const now = nowTimestamps();
  meta.updatedAt = now.utcIso;
  if (!meta.createdAt) meta.createdAt = now.utcIso;
  if (!meta.sessionId) meta.sessionId = basename(dir);

  const payload: Record<string, unknown> = {
    version: meta.version,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    project_path: meta.projectPath,
    model_config_name: meta.modelConfigName,
    model_provider: meta.modelProvider ?? null,
    model_selection_key: meta.modelSelectionKey ?? null,
    model_id: meta.modelId ?? null,
    prompt_cache_affinity_key: meta.promptCacheAffinityKey ?? null,
    summary: meta.summary,
    title: meta.title ?? null,
    turn_count: meta.turnCount,
    compact_count: meta.compactCount,
    thinking_level: meta.thinkingLevel,
    child_sessions: meta.childSessions ?? null,
    // 标记为 meta.ephemeral === true 的条目仅存在于内存中（例如 /fork
    // 来源指针）；它们会到达 TUI 但永远不会持久化。
    entries: entries.filter((e) => !e.meta?.["ephemeral"]).map(entryToSnake),
  };

  const logFile = join(dir, "log.json");
  const tmp = logFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, logFile);

  // 在 log.json 旁边写入轻量级 meta.json
  try {
    saveSessionMeta(dir, meta);
  } catch {
    // 尽力而为
  }

  // 更新 project.json 的 last_active_at
  try {
    updateProjectLastActive(dirname(dir), meta.updatedAt);
  } catch {
    // 尽力而为
  }
}

/** 日志加载结果 */
export interface LoadLogResult {
  /** 会话元数据 */
  meta: LogSessionMeta;
  /** 日志条目列表 */
  entries: LogEntry[];
  /** ID 分配器 */
  idAllocator: LogIdAllocator;
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

/** 从磁盘加载会话日志（log.json） */
export function loadLog(dir: string): LoadLogResult {
  const logFile = join(dir, "log.json");
  const raw = JSON.parse(readFileSync(logFile, "utf-8"));

  const meta: LogSessionMeta = {
    version: raw.version ?? 2,
    sessionId: raw.session_id ?? "",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    projectPath: raw.project_path ?? "",
    modelConfigName: raw.model_config_name ?? "",
    modelProvider: raw.model_provider ?? undefined,
    modelSelectionKey: raw.model_selection_key ?? undefined,
    modelId: raw.model_id ?? undefined,
    promptCacheAffinityKey: typeof raw.prompt_cache_affinity_key === "string"
      ? raw.prompt_cache_affinity_key
      : undefined,
    summary: raw.summary ?? "",
    title: raw.title ?? undefined,
    turnCount: raw.turn_count ?? 0,
    compactCount: raw.compact_count ?? 0,
    thinkingLevel: raw.thinking_level ?? "",
    childSessions: Array.isArray(raw.child_sessions)
      ? (raw.child_sessions as unknown[]).map(normalizeChildSessionMeta).filter((record): record is ChildSessionMetaRecord => record !== undefined)
      : undefined,
  };

  const rawEntries = (raw.entries ?? []) as Array<Record<string, unknown>>;
  const entries = rawEntries.map(entryFromSnake);

  // 验证条目 ID 唯一性
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry ID detected: ${entry.id}`);
    }
    seenIds.add(entry.id);
  }

  // 通过全量扫描恢复 ID 分配器
  const idAllocator = new LogIdAllocator();
  idAllocator.restoreFrom(entries);

  return { meta, entries, idAllocator };
}
