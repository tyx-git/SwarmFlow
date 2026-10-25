/**
 * 会话元数据（meta.json）的形状、默认值与写入。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildSessionMetaRecord, ChildSessionPhase } from "../session/tree-types.js";
import { isSameUtcMinute } from "./timestamps.js";

// ------------------------------------------------------------------
// LogSessionMeta——会话元数据接口
// ------------------------------------------------------------------

/** 会话元数据——存储在 meta.json 中 */
export interface LogSessionMeta {
  /** 元数据版本号 */
  version: number;
  /** 会话 UUID */
  sessionId: string;
  /** 创建时间（UTC ISO 格式） */
  createdAt: string;
  /** 最后更新时间（UTC ISO 格式） */
  updatedAt: string;
  /** 原始项目路径 */
  projectPath: string;
  /** 模型配置名称 */
  modelConfigName: string;
  /** 模型提供商 */
  modelProvider?: string;
  /** 模型选择键 */
  modelSelectionKey?: string;
  /** 模型 ID */
  modelId?: string;
  /** 会话创建时的模型身份，在恢复和 /model 切换时保持稳定 */
  initialModel?: string;
  /**
   * Prompt cache 路由亲和键（随机 opaque id）。
   *
   * 同一会话跨进程恢复时必须复用；fork 默认生成新键（路由隔离）。
   */
  promptCacheAffinityKey?: string;
  /** 会话摘要 */
  summary: string;
  /** 会话标题 */
  title?: string;
  /** 对话轮数 */
  turnCount: number;
  /** 压缩次数 */
  compactCount: number;
  /** 思维链级别 */
  thinkingLevel: string;
  /** 落盘策略版本；缺省表示 M0/M1 之前的旧文件，需要一次归一化。 */
  persistencePolicy?: number;
  /** 压缩/归档持久化格式版本。 */
  compactionFormat?: number;
  /** 子会话元数据记录 */
  childSessions?: ChildSessionMetaRecord[];
  /** 根会话的冻结收件箱（关闭时持久化，用于快照/恢复） */
  inbox?: import("../session/tree-types.js").MessageEnvelope[];
  /**
   * 追加安全：各 ID 前缀已用的最大序号。
   * 有界恢复只加载活动窗口，窗口里可能没有某个前缀的条目；靠这份快照避免从 001 重号。
   */
  idCounters?: Record<string, number>;
  /** 活动 work_start 数量（work ID 生成用）。 */
  workCount?: number;
  /** 生命周期工具调用数（恢复后的阈值判断/展示）。 */
  lifetimeToolCallCount?: number;
  /** 累计用量基线（含 cacheRead）；有界恢复与统计页共用，写入时取自日志求和。 */
  tokens?: { input: number; output: number; cacheRead: number };
  /** 首个有效调用的输入 token（system prompt 估算基线）。 */
  firstInput?: number;
  /** 首条真实用户消息的 token 估算。 */
  firstUserMessageTokens?: number;
  lastToolCallSummary?: string;
  recentSessionEvents?: string[];
  lastTurnEndStatus?: "completed" | "interrupted" | "error" | null;
  selfPhase?: ChildSessionPhase;
}
/** 创建默认的会话元数据对象 */
export function createLogSessionMeta(
  partial?: Partial<LogSessionMeta>,
): LogSessionMeta {
  return {
    version: 2,
    sessionId: "",
    createdAt: "",
    updatedAt: "",
    projectPath: "",
    modelConfigName: "",
    modelProvider: undefined,
    modelSelectionKey: undefined,
    modelId: undefined,
    promptCacheAffinityKey: undefined,
    summary: "",
    title: undefined,
    turnCount: 0,
    compactCount: 0,
    thinkingLevel: "",
    childSessions: undefined,
    ...partial,
  };
}
// ------------------------------------------------------------------
// 会话 meta.json（轻量级摘要，用于快速列表）
// ------------------------------------------------------------------

/** 会话元数据摘要——用于快速列表展示 */
export interface SessionMetaSummary {
  /** 会话 ID */
  session_id?: string;
  /** 创建时间 */
  created_at: string;
  /** 最后活跃时间 */
  last_active_at: string;
  /** 会话摘要 */
  summary: string;
  /** 会话标题 */
  title?: string;
  /** 对话轮数 */
  turn_count: number;
  /** 是否已归档 */
  archived?: boolean;
}

/** 保存会话元数据到 meta.json 文件 */
export function saveSessionMeta(sessionDir: string, meta: LogSessionMeta): void {
  const metaFile = join(sessionDir, "meta.json");
  // 通过与现有元数据合并来保留外部设置的字段（例如 "archived"）
  let existing: Record<string, unknown> | undefined;
  try {
    if (existsSync(metaFile)) {
      existing = JSON.parse(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
    }
  } catch { /* ignore */ }

  // last_active_at 只在跨分钟时推进：高频检查点不应反复重写同一份小文件。
  const existingActiveAt = existing?.["last_active_at"];
  const lastActiveAt = isSameUtcMinute(existingActiveAt, meta.updatedAt)
    ? existingActiveAt
    : meta.updatedAt;
  const payload: Record<string, unknown> = {
    ...(existing ?? {}),
    version: meta.version,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    last_active_at: lastActiveAt,
    project_path: meta.projectPath,
    model_config_name: meta.modelConfigName,
    model_provider: meta.modelProvider ?? null,
    model_selection_key: meta.modelSelectionKey ?? null,
    model_id: meta.modelId ?? null,
    initial_model: meta.initialModel ?? null,
    prompt_cache_affinity_key: meta.promptCacheAffinityKey ?? null,
    summary: meta.summary,
    title: meta.title,
    turn_count: meta.turnCount,
    compact_count: meta.compactCount,
    thinking_level: meta.thinkingLevel,
    child_sessions: meta.childSessions ?? null,
    inbox: meta.inbox ?? null,
    id_counters: meta.idCounters ?? null,
    work_count: meta.workCount ?? null,
    tool_call_count: meta.lifetimeToolCallCount ?? null,
    tokens: meta.tokens ?? null,
    first_input: meta.firstInput ?? null,
    first_user_message_tokens: meta.firstUserMessageTokens ?? null,
    last_tool_call_summary: meta.lastToolCallSummary ?? null,
    recent_session_events: meta.recentSessionEvents ?? null,
    last_turn_end_status: meta.lastTurnEndStatus ?? null,
    self_phase: meta.selfPhase ?? null,
    persistence_policy: 3,
    compaction_format: meta.compactionFormat ?? 2,
  };
  const serialized = JSON.stringify(payload);
  if (existing && JSON.stringify(existing) === serialized) return;
  const tmp = metaFile + ".tmp";
  writeFileSync(tmp, serialized);
  renameSync(tmp, metaFile);
}
