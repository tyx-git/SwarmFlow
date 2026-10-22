/**
 * 模型切换、思考等级与全局/子代理偏好。
 *
 * 只搬把偏好写进会话/落盘这层；纯字段读写器（get/set thinkingLevel、accentColor、
 * currentModelName、currentModelConfigName）仍留在 Session，它们是状态面本身。
 */

import type { Agent } from "../agents/agent.js";
import type { Config } from "../config/loader.js";
import { createGlobalTuiPreferences, type GlobalTuiPreferences } from "../config/settings/legacy-preferences.js";
import type { SwarmflowSettings } from "../config/settings/types.js";
import type { PersistedModelSelection } from "../models/selection.js";
import type { PermissionAdvisor, PermissionMode } from "../permissions/index.js";
import type { ContextManager } from "./context-manager.js";
import { loadSubagentSettings, saveSubagentSettings, subagentSettingsPath, type SubagentSettings } from "./subagent-settings.js";

/** 模型/偏好设置所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface ModelSettingsHost {
  primaryAgent: Agent;
  config: Config;
  onSaveRequest?: () => void | boolean;
  currentModelConfigName: string;
  _thinkingLevel: string;
  _preferredThinkingLevel: string;
  _preferredAccentColor?: string;
  _persistedModelSelection: PersistedModelSelection;
  _disabledSkills: Set<string>;
  _permissionAdvisor: PermissionAdvisor;
  _contextManager: ContextManager;
  _store: any;
  _projectRoot: string;
  _buildPersistedModelSelection(overrides?: Partial<PersistedModelSelection>): PersistedModelSelection;
  _rebuildSystemPrompt(): void;
  _ensureSessionStorageReady(): void;
  reloadSkills(): { added: string[]; removed: string[]; total: number };
}

/**
 * Switch the primary agent to a different model config.
 * Only callable between turns (not while a turn is in progress).
 */
export function switchModel(host: ModelSettingsHost, modelConfigName: string): void {
  const newModelConfig = host.config.getModel(modelConfigName);
  host.primaryAgent.replaceModelConfig(newModelConfig);
  host._persistedModelSelection = host._buildPersistedModelSelection({
    modelConfigName,
    modelProvider: newModelConfig.provider,
    modelSelectionKey: newModelConfig.model,
    modelId: newModelConfig.model,
  });
  host._thinkingLevel = host._preferredThinkingLevel || "off";
}

export function reloadCurrentModelConfig(host: ModelSettingsHost): void {
  const modelConfigName = host.currentModelConfigName;
  host.config.invalidateModel(modelConfigName);
  const newModelConfig = host.config.getModel(modelConfigName);
  host.primaryAgent.replaceModelConfig(newModelConfig);
  host._persistedModelSelection = host._buildPersistedModelSelection({
    modelConfigName,
    modelProvider: newModelConfig.provider,
    modelSelectionKey: newModelConfig.model,
    modelId: newModelConfig.model,
  });
  host._thinkingLevel = host._preferredThinkingLevel || "off";
}

export function applyGlobalPreferences(host: ModelSettingsHost, preferences: GlobalTuiPreferences): void {
  const prefs = createGlobalTuiPreferences(preferences);
  host._preferredThinkingLevel = prefs.thinkingLevel;
  host._preferredAccentColor = prefs.accentColor;
  host._thinkingLevel = prefs.thinkingLevel || "off";

  // Restore disabled skills
  if (prefs.disabledSkills && prefs.disabledSkills.length > 0) {
    host._disabledSkills = new Set(prefs.disabledSkills);
    host.reloadSkills();
  }

  // Restore permission mode
  if (prefs.permissionMode && ["read_only", "reversible", "yolo"].includes(prefs.permissionMode)) {
    host._permissionAdvisor.sessionMode = prefs.permissionMode as PermissionMode;
  }
}

/**
 * 应用 settings.json 中的启动设置。
 *
 * thinkingLevel 由启动解析器从 currentProvider.currentModel 取得；
 * 缺失时回退 settings.thinking_level，再回退 off。
 */
export function applySettings(host: ModelSettingsHost, settings: SwarmflowSettings, opts?: { thinkingLevel?: string }): void {
  const thinkingLevel = opts?.thinkingLevel || settings.thinking_level || "";
  host._preferredThinkingLevel = thinkingLevel;
  host._preferredAccentColor = settings.accent_color;
  host._thinkingLevel = thinkingLevel || "off";
  if (settings.context_budget_percent !== undefined) {
    host._contextManager.setBudgetPercent(settings.context_budget_percent);
  }

  // Restore disabled skills
  if (settings.disabled_skills && settings.disabled_skills.length > 0) {
    host._disabledSkills = new Set(settings.disabled_skills);
    host.reloadSkills();
    // skills 列表属于 system 快照；启动时应用 disabled_skills 后必须同步重建，
    // 否则首轮 system 仍会列出已禁用的 skill。
    host._rebuildSystemPrompt();
  }

  // Restore permission mode
  if (settings.permission_mode && ["read_only", "reversible", "yolo"].includes(settings.permission_mode)) {
    host._permissionAdvisor.sessionMode = settings.permission_mode as PermissionMode;
  }
}

export function getGlobalPreferences(host: ModelSettingsHost): GlobalTuiPreferences {
  return createGlobalTuiPreferences({
    modelConfigName: host._persistedModelSelection.modelConfigName ?? undefined,
    modelProvider: host._persistedModelSelection.modelProvider ?? undefined,
    modelSelectionKey: host._persistedModelSelection.modelSelectionKey ?? undefined,
    modelId: host._persistedModelSelection.modelId ?? undefined,
    thinkingLevel: host._preferredThinkingLevel,
    accentColor: host._preferredAccentColor,
    disabledSkills: host._disabledSkills.size > 0
      ? [...host._disabledSkills]
      : undefined,
    permissionMode: host._permissionAdvisor.sessionMode,
  });
}

/** 当前会话按角色保存的子代理模型配置。 */
export function getSubagentSettings(host: ModelSettingsHost): SubagentSettings | undefined {
  const sessionDir = typeof host._store?.sessionDir === "string" ? host._store.sessionDir : "";
  if (!sessionDir) return undefined;
  return loadSubagentSettings(subagentSettingsPath(host._projectRoot, sessionDir));
}

/** 保存当前会话按角色保存的子代理模型配置。 */
export function setSubagentSettings(host: ModelSettingsHost, settings: SubagentSettings): void {
  host._ensureSessionStorageReady();
  const sessionDir = typeof host._store?.sessionDir === "string" ? host._store.sessionDir : "";
  if (!sessionDir) throw new Error("Session directory is unavailable.");
  saveSubagentSettings(subagentSettingsPath(host._projectRoot, sessionDir), settings);
  host.onSaveRequest?.();
}
