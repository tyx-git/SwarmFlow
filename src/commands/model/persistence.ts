/** 模型与思考深度选择的持久化写回，以及思考级别选择提示。 */

import type { ProviderEntry } from "../../config/settings/types.js";

import { saveGlobalSettingsPatch, loadGlobalSettings, persistCurrentModelSelection } from "../../config/settings/io.js";

import { findProviderPreset } from "../../providers/presets.js";
import { type ResolvedModelSelection } from "../../models/selection.js";

import { getCurrentModelDescriptor } from "../../models/presentation.js";

import { THINKING_LEVEL_LIST } from "../../config/thinking.js";
import { createUiText, getUiLanguage } from "../../ui/text.js";

import { persistSettingsPatch } from "../settings-patch.js";
import { type CommandContext } from "../types.js";
import type { SessionLike } from "../../session/contract.js";

export function currentSessionModelDisplayName(session: SessionLike): string {
  return getCurrentModelDescriptor(session)?.compactScopedDetailedLabel ?? "";
}

/**
 * 将会话的模型/思考深度持久化到 settings.json。
 *
 * 唯一数据源：currentProvider + providers[currentProvider].currentModel。
 * 不再写 state/model-selection.json。
 */
export function persistModelSelection(ctx: CommandContext): void {
  try {
    const session = ctx.session;
    const prefs = typeof session.getGlobalPreferences === "function"
      ? session.getGlobalPreferences()
      : undefined;
    if (!prefs) return;

    const provider = prefs.modelProvider?.trim();
    const model = prefs.modelId?.trim() || prefs.modelSelectionKey?.trim();
    const thinkingDepth = prefs.thinkingLevel && prefs.thinkingLevel !== "none"
      ? prefs.thinkingLevel
      : undefined;

    if (provider && model) {
      persistCurrentModelSelection({
        provider,
        model,
        configName: prefs.modelConfigName,
        thinkingDepth,
      }, ctx.swarmflowHomeDir);
    } else if (thinkingDepth) {
      // 模型身份缺失时仍保留用户刚选择的思考深度。
      saveGlobalSettingsPatch({ thinking_level: thinkingDepth }, ctx.swarmflowHomeDir);
    }
  } catch {
    // 忽略命令执行期间的持久性失败。
  }
}

/** 将通过 provider:model 临时创建的模型保存到用户目录，避免重启后丢失。 */
export function persistRuntimeModelConfig(ctx: CommandContext, selection: ResolvedModelSelection): boolean {
  if (!selection.selectedConfigName.startsWith("runtime-")) return true;
  // UI 运行时总会注入明确的 homeDir；缺失时通常是无持久化能力的
  // 测试/嵌入调用，不能把临时模型写进当前用户的全局配置。
  if (!ctx.swarmflowHomeDir) return true;

  const providerId = selection.modelProvider;
  const settings = loadGlobalSettings(ctx.swarmflowHomeDir);
  const existing = settings.providers?.[providerId];
  const preset = findProviderPreset(providerId);

  // 未知 provider 没有端点信息时不能凭空生成 settings 条目。
  if (!existing && !preset) return false;

  const provider: ProviderEntry = { ...(existing ?? {}) };
  if (!provider.api_key_env && preset && providerId !== "openai-codex" && providerId !== "copilot") {
    provider.api_key_env = preset.envVar;
  }

  const model = (() => {
    try {
      return ctx.session.config?.getModel?.(selection.selectedConfigName);
    } catch {
      return undefined;
    }
  })();
  const contextLength = typeof model?.contextLength === "number" && model.contextLength > 0
    ? model.contextLength
    : 128_000;
  const models = [...(provider.models ?? [])];
  if (!models.some((item) => item.id === selection.modelId)) {
    models.push({ id: selection.modelId, context_length: contextLength });
  }
  provider.models = models;

  return persistSettingsPatch({
    providers: {
      ...(settings.providers ?? {}),
      [providerId]: provider,
    },
  }, ctx.swarmflowHomeDir);
}

/**
 * 提示用户为当前模型选择思考深度。
 * 在模型切换后调用（取代已移除的 /thinking 命令）。
 *
 * 返回选中的深度字符串；用户取消时返回 undefined。
 */
export async function promptThinkingLevel(
  ctx: CommandContext,
  config?: { current?: string; applyToSession?: boolean },
): Promise<string | undefined> {
  const session = ctx.session;
  const t = createUiText(getUiLanguage(ctx.swarmflowHomeDir));
  // 让注册模型与自定义模型的最后一步保持一致；对于本地不了解能力的模型，
  // 不受支持的值由 session/provider 层归一化。
  const configuredLevels = loadGlobalSettings(ctx.swarmflowHomeDir).thinking_levels;
  const levels = Array.isArray(configuredLevels)
    ? [...new Set(configuredLevels.map((level) => String(level).trim()).filter(Boolean))]
    : [];
  const availableLevels = levels.length > 0 ? levels : [...THINKING_LEVEL_LIST];

  if (!ctx.promptCommandPicker) {
    // 非交互式环境保持当前思考深度。
    return undefined;
  }

  const current = config?.current ?? session.thinkingLevel ?? "";
  const pickerOptions = availableLevels.map((level) => {
    const currentMark = current === level ? `  ${t.get(["Views", "commandPicker", "current"])}` : "";
    return { label: `${level}${currentMark}`, value: level };
  });

  const choice = (await ctx.promptCommandPicker(pickerOptions, {
    title: t.get(["Views", "commandPicker", "thinkingTitle"]),
    inputArea: true,
  }))?.value;
  if (!choice) return undefined;

  if (config?.applyToSession !== false) session.thinkingLevel = choice;
  return choice;
}

// ------------------------------------------------------------------
// /模式命令
// ------------------------------------------------------------------
