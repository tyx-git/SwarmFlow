/**
 * 启动时的模型/思考深度解析。
 *
 * 唯一数据源：settings.json。
 *
 * 优先级：
 *   1. 显式 selectedModel（CLI/GUI 覆盖）
 *   2. currentProvider → providers[currentProvider].currentModel
 *   3. settings.default_model
 *
 * thinking depth 必须跟随实际选中的 currentModel；不再读取
 * state/model-selection.json，也不使用供应商内部的推导默认值。
 */

import type { Config } from "../config/config.js";
import type { SwarmflowSettings } from "../config/persistence.js";

export interface StartupModelSelection {
  modelConfigName?: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
  /** 未设置时由 Session.applySettings 回退到 off。 */
  thinkingLevel?: string;
}

type ModelCatalog = Pick<Config, "modelNames" | "findModelConfigName">;

/**
 * 解析新会话启动时应使用的模型与思考深度。
 *
 * `selectedModel` 是显式的 CLI/GUI 覆盖，优先级最高；此时不沿用
 * currentModel 的 thinking depth，避免把上一个模型的档位带到新模型上。
 */
export function resolveStartupModelSelection(
  config: ModelCatalog,
  settings: SwarmflowSettings,
  opts?: { selectedModel?: string },
): StartupModelSelection {
  const selectedModel = opts?.selectedModel?.trim();
  const currentProvider = settings.currentProvider?.trim();
  const currentModel = currentProvider
    ? settings.providers?.[currentProvider]?.currentModel
    : undefined;

  const currentConfigName = currentModel?.configName && config.modelNames.includes(currentModel.configName)
    ? currentModel.configName
    : undefined;
  const currentByModel = currentProvider && currentModel?.model
    ? config.findModelConfigName(currentProvider, currentModel.model)
    : undefined;
  const currentResolved = Boolean(currentModel && (currentConfigName || currentByModel));

  const useCurrentModel = !selectedModel && currentResolved;
  const modelConfigName = selectedModel
    ?? (useCurrentModel ? currentConfigName ?? currentByModel : undefined)
    ?? settings.default_model;

  const thinkingLevel = useCurrentModel
    ? currentModel?.thinkingDepth || settings.thinking_level
    : settings.thinking_level;

  if (useCurrentModel && currentModel && currentProvider) {
    return {
      modelConfigName,
      modelProvider: currentProvider,
      modelSelectionKey: currentModel.model,
      modelId: currentModel.model,
      thinkingLevel,
    };
  }

  return {
    modelConfigName,
    thinkingLevel,
  };
}

/** 模板实例化时的回退模型配置名（仅当配置确实存在时）。 */
export function resolveTemplateFallbackModel(
  config: ModelCatalog,
  selection: StartupModelSelection,
): string | undefined {
  if (selection.modelConfigName && config.modelNames.includes(selection.modelConfigName)) {
    return selection.modelConfigName;
  }
  const provider = selection.modelProvider?.trim();
  const model = selection.modelId?.trim() || selection.modelSelectionKey?.trim();
  if (!provider || !model) return undefined;
  return config.findModelConfigName(provider, model);
}
