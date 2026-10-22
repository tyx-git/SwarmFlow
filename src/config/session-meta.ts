/**
 * 会话元数据（meta.json）的形状、默认值与写入。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildSessionMetaRecord } from "../session/tree-types.js";

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
  /** 子会话元数据记录 */
  childSessions?: ChildSessionMetaRecord[];
  /** 根会话的冻结收件箱（关闭时持久化，用于快照/恢复） */
  inbox?: import("../session/tree-types.js").MessageEnvelope[];
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
  const tmp = metaFile + ".tmp";
  // 通过与现有元数据合并来保留外部设置的字段（例如 "archived"）
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(metaFile)) {
      existing = JSON.parse(readFileSync(metaFile, "utf-8"));
    }
  } catch { /* ignore */ }
  const payload: Record<string, unknown> = {
    ...existing,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    last_active_at: meta.updatedAt,
    summary: meta.summary,
    title: meta.title,
    turn_count: meta.turnCount,
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, metaFile);
}
