/**
 * 设置和运行时模型选择器使用的共享提供者/模型目录。
 *
 * PROVIDER_PRESETS 现在从提供者注册表派生
 *（assets/model-registry/providers.json 通过 FACTORY_PROVIDER_SPECS）。此文件
 * 保留使用者依赖的预设形状 + 查找辅助函数；数据位于
 * 注册表中。参见 Docs/provider-model-maintainability-plan.md。
 */

import {
  type ProviderSpec,
  credentialEnvVar,
  modelSpecIds,
  providerModelEffectiveId,
  providerModelKey,
} from "../models/registry.js";
import {
  EFFECTIVE_MODEL_SPECS,
  EFFECTIVE_PROVIDER_SPECS,
} from "../providers/registry-effective.js";

export interface ProviderPresetModel {
  /** `/model` 和 init 选项使用的稳定选择器。 */
  key: string;
  /** 发送给提供者的实际 API 模型 ID。 */
  id: string;
  /** 文档和 init 中使用的人类友好标签。 */
  label: string;
  /** 追加到 `/model` 选择器标签中的可选说明。 */
  optionNote?: string;
  /** 向后兼容的选择器别名。 */
  aliases?: string[];
  /** 合并到生成/运行时模型配置中的原始配置覆盖。 */
  config?: Record<string, unknown>;
}

export interface ProviderPreset {
  id: string;
  name: string;
  envVar: string;
  models: ProviderPresetModel[];
  /** 三层选择器分组的 group key。 */
  group?: string;
  /** 选择器中组父节点的显示标签。 */
  groupLabel?: string;
  /** 该预设在其组内（中间层）的显示标签。 */
  subLabel?: string;
  /** 是否为本地推理服务器。 */
  localServer?: boolean;
  /** 本地服务器的默认 base URL。 */
  defaultBaseUrl?: string;
}

/** model id（包括别名拼写）→ displayName，用于在 spec 引用上继承标签。 */
const DISPLAY_NAME_BY_ID: ReadonlyMap<string, string> = new Map(
  EFFECTIVE_MODEL_SPECS.flatMap((s) => modelSpecIds(s).map((id) => [id, s.displayName] as const)),
);

/**
 * 将 ProviderSpec[] 投影为使用者期望的旧 ProviderPreset[] 形状。
 * 可选字段按条件添加（绝不设为 undefined），以确保形状与旧的手写字面量逐字节一致。
 */
export function deriveProviderPresets(specs: readonly ProviderSpec[]): ProviderPreset[] {
  return specs.map((s) => {
    const models = s.models.map((ref) => {
      const m: ProviderPresetModel = {
        key: providerModelKey(ref),
        id: providerModelEffectiveId(ref),
        label: ref.label ?? DISPLAY_NAME_BY_ID.get(ref.spec ?? "") ?? providerModelEffectiveId(ref),
      };
      if (ref.optionNote !== undefined) m.optionNote = ref.optionNote;
      if (ref.aliases !== undefined) m.aliases = [...ref.aliases];
      if (ref.config !== undefined) m.config = ref.config;
      return m;
    });
    const preset: ProviderPreset = {
      id: s.id,
      name: s.name,
      envVar: credentialEnvVar(s.credential),
      models,
    };
    if (s.group) {
      preset.group = s.group.id;
      preset.groupLabel = s.group.label;
      preset.subLabel = s.group.subLabel;
    }
    if (s.localServer) {
      preset.localServer = true;
      if (s.defaultBaseUrl !== undefined) preset.defaultBaseUrl = s.defaultBaseUrl;
    }
    return preset;
  });
}

export const PROVIDER_PRESETS: ProviderPreset[] = deriveProviderPresets(EFFECTIVE_PROVIDER_SPECS);

export function findProviderPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId);
}

export function findProviderPresetModel(
  providerId: string,
  selection: string,
): ProviderPresetModel | undefined {
  const preset = findProviderPreset(providerId);
  if (!preset) return undefined;
  return preset.models.find((model) =>
    model.key === selection
      || model.id === selection
      || Boolean(model.aliases?.includes(selection))
  );
}

export function buildProviderPresetRawConfig(
  providerId: string,
  model: ProviderPresetModel,
  apiKey: string,
): Record<string, unknown> {
  return {
    provider: providerId,
    model: model.id,
    api_key: apiKey,
    ...(model.config ?? {}),
  };
}
