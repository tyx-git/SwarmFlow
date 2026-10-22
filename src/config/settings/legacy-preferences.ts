/**
 * 旧版全局 TUI 偏好设置（迁移期间保留）。
 */

import type { LocalProviderConfig } from "./types.js";

// ------------------------------------------------------------------
// 旧版偏好设置类型（迁移期间临时保留）
// ------------------------------------------------------------------

/** 旧版全局 TUI 偏好设置（已弃用，保留用于迁移） */
export interface GlobalTuiPreferences {
  /** 版本号 */
  version: number;
  /** 模型配置名称 */
  modelConfigName?: string;
  /** 模型提供商 */
  modelProvider?: string;
  /** 模型选择键 */
  modelSelectionKey?: string;
  /** 模型 ID */
  modelId?: string;
  /** 思维链级别 */
  thinkingLevel: string;
  /** 强调色 */
  accentColor?: string;
  /** 禁用的技能列表 */
  disabledSkills?: string[];
  /** 提供商 → 环境变量名映射（例如 { "openai": "OPENAI_API_KEY_1" }） */
  providerEnvVars?: Record<string, string>;
  /** 本地推理服务器配置（例如 { "lmstudio": { baseUrl, model, contextLength } }） */
  localProviders?: Record<string, LocalProviderConfig>;
  /** 主会话上下文预算百分比（1-100）。默认 100 */
  contextBudgetPercent?: number;
  /** 是否在侧边栏显示 Codex 使用量卡片。默认 true */
  showCodexUsage?: boolean;
  /** 权限模式偏好。默认 "reversible" */
  permissionMode?: string;
}

/** 创建默认的全局 TUI 偏好设置对象 */
export function createGlobalTuiPreferences(
  partial?: Partial<GlobalTuiPreferences>,
): GlobalTuiPreferences {
  return {
    version: 1,
    modelConfigName: undefined,
    modelProvider: undefined,
    modelSelectionKey: undefined,
    modelId: undefined,
    thinkingLevel: "",
    ...partial,
  };
}
