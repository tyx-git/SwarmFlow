import {
  findProviderPreset,
} from "../providers/presets.js";
import { OPENROUTER_VENDOR_BRAND } from "../models/registry.js";
import {
  EFFECTIVE_PROVIDER_SPECS,
} from "../providers/registry-effective.js";
import { loadGlobalSettings } from "../config/persistence.js";
import { getSwarmflowHomeDir } from "../lib/home-path.js";

function normalizeModelId(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function titleCaseWords(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanizeProviderId(providerId: string): string {
  return titleCaseWords(
    providerId
      .replace(/[-_]+/g, " ")
      .trim(),
  );
}

function humanizePresetSubLabel(label: string): string {
  return label.replace(/-/g, " ").trim();
}

// 品牌/提供者/厂商标签表，从提供者注册表派生。
const BRAND_LABEL_OVERRIDES: Record<string, string> = Object.fromEntries(
  EFFECTIVE_PROVIDER_SPECS.map((s) => [s.id, s.brand]),
);

const PROVIDER_LABEL_OVERRIDES: Record<string, string> = Object.fromEntries(
  EFFECTIVE_PROVIDER_SPECS
    .filter((s) => s.providerLabel !== undefined)
    .map((s) => [s.id, s.providerLabel as string]),
);

const OPENROUTER_VENDOR_LABELS: Record<string, string> = OPENROUTER_VENDOR_BRAND;

export interface ModelPresentation {
  brandKey: string;
  brandLabel: string;
  providerLabel: string;
  modelLabel: string;
  modelDetailedLabel: string;
  compactModelLabel: string;
  compactModelDetailedLabel: string;
  scopedLabel: string;
  scopedDetailedLabel: string;
  compactScopedLabel: string;
  compactScopedDetailedLabel: string;
  groupId?: string;
  groupLabel?: string;
  vendorId?: string;
  vendorLabel?: string;
}

export interface ModelDescriptor extends ModelPresentation {
  configName?: string;
  providerId: string;
  selectionKey: string;
  modelId: string;
}

function humanizeUnknownModel(model: string): string {
  const normalized = normalizeModelId(model).trim();

  const words = normalized
    .replace(/^runtime-/i, "")
    .replace(/^openrouter-/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "glm") return "GLM";
      if (lower === "api") return "API";
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.slice(0, 1).toUpperCase() + part.slice(1);
    });
  return words.join(" ").trim() || normalized;
}

function compactBrandLabel(raw: string): string {
  if (/\(([^)]+)\)/.test(raw)) {
    const match = raw.match(/\(([^)]+)\)/);
    if (match?.[1]) return match[1].split("/")[0]!.trim();
  }
  return raw.replace(/\s+\(.*\)\s*/g, "").replace(/\s+\(Local\)\s*/g, "").trim();
}

function resolveBrandKey(providerId: string): string {
  const preset = findProviderPreset(providerId);
  if (preset?.group) return preset.group;
  if (providerId === "openai-codex") return "openai";
  return providerId;
}

function resolveBrandLabel(providerId: string): string {
  const override = BRAND_LABEL_OVERRIDES[providerId];
  if (override) return override;
  const preset = findProviderPreset(providerId);
  if (preset?.groupLabel) return compactBrandLabel(preset.groupLabel);
  if (preset?.name) return compactBrandLabel(preset.name);
  return humanizeProviderId(providerId);
}

function resolveProviderLabel(providerId: string): string {
  const override = PROVIDER_LABEL_OVERRIDES[providerId];
  if (override) return override;
  const preset = findProviderPreset(providerId);
  if (preset?.subLabel) return humanizePresetSubLabel(preset.subLabel);
  if (preset?.name) return compactBrandLabel(preset.name);
  return humanizeProviderId(providerId);
}

function resolveVendorLabel(selectionKey: string, modelId: string): { vendorId?: string; vendorLabel?: string } {
  const source = selectionKey || modelId;
  const slashIdx = source.indexOf("/");
  if (slashIdx <= 0) return {};
  const vendorId = source.slice(0, slashIdx);
  return {
    vendorId,
    vendorLabel: OPENROUTER_VENDOR_LABELS[vendorId] ?? humanizeProviderId(vendorId),
  };
}

function compactModelLabelForDisplay(providerId: string, modelLabel: string): string {
  if (providerId === "anthropic" || providerId === "openrouter" || providerId === "copilot") {
    return modelLabel.replace(/^Claude\s+/i, "").trim();
  }
  if (providerId.startsWith("glm")) {
    return modelLabel.replace(/^GLM[-\s]+/i, "GLM ").trim();
  }
  return modelLabel.trim();
}

export function describeModel(params: {
  providerId: string;
  selectionKey?: string;
  modelId?: string;
  configName?: string;
  /**
   * 任意 provider id 的显示名（自定义/本地供应商在设置里填写的 label）。
   * 传了就优先使用原文字符串，不再对 id 做大小写归一——否则用户写的
   * "JuCode" 会被改写成 "Jucode"。
   */
  providerLabelOverride?: string;
}): ModelDescriptor {
  const providerId = String(params.providerId ?? "").trim();
  const selectionKey = String(params.selectionKey ?? params.modelId ?? "").trim();
  const modelId = String(params.modelId ?? params.selectionKey ?? "").trim();
  const configName = params.configName?.trim() || undefined;

  const preset = findProviderPreset(providerId);
  const modelLabel = humanizeUnknownModel(modelId || selectionKey);
  const compactModelLabel = compactModelLabelForDisplay(providerId, modelLabel);

  const modelDetailedLabel = modelLabel;
  const compactModelDetailedLabel = compactModelLabel;
  const brandKey = resolveBrandKey(providerId);
  const brandLabel = resolveBrandLabel(providerId);
  const providerLabel = params.providerLabelOverride?.trim() || resolveProviderLabel(providerId);
  const scopedLabel = providerLabel && modelLabel ? `${providerLabel}/${modelLabel}` : modelLabel || providerLabel;
  const scopedDetailedLabel = scopedLabel;
  const compactScopedLabel = providerLabel && compactModelLabel
    ? `${providerLabel}/${compactModelLabel}`
    : compactModelLabel || providerLabel;
  const compactScopedDetailedLabel = compactScopedLabel;
  const vendor = providerId === "openrouter"
    ? resolveVendorLabel(selectionKey, modelId)
    : {};

  return {
    configName,
    providerId,
    selectionKey,
    modelId,
    brandKey,
    brandLabel,
    providerLabel,
    modelLabel,
    modelDetailedLabel,
    compactModelLabel,
    compactModelDetailedLabel,
    scopedLabel,
    scopedDetailedLabel,
    compactScopedLabel,
    compactScopedDetailedLabel,
    groupId: preset?.group,
    groupLabel: preset?.groupLabel,
    vendorId: vendor.vendorId,
    vendorLabel: vendor.vendorLabel,
  };
}

export function getCurrentModelDescriptor(session: any): ModelDescriptor | null {
  const modelConfig = session?.primaryAgent?.modelConfig;
  if (!modelConfig) return null;

  const prefs = typeof session?.getGlobalPreferences === "function"
    ? session.getGlobalPreferences()
    : undefined;

  const providerId = String(prefs?.modelProvider ?? modelConfig.provider ?? "").trim();
  // home 目录只用于读取自定义供应商的显示名，取不到时回落到默认位置。
  let homeDir: string | undefined;
  try {
    homeDir = getSwarmflowHomeDir();
  } catch {
    homeDir = undefined;
  }

  return describeModel({
    configName: prefs?.modelConfigName ?? session.currentModelConfigName ?? modelConfig.name,
    providerId,
    selectionKey: prefs?.modelSelectionKey ?? modelConfig.model,
    modelId: prefs?.modelId ?? session.currentModelName ?? modelConfig.model,
    providerLabelOverride: customProviderLabel(homeDir, providerId),
  });
}

/**
 * 取自定义/本地供应商在设置里填写的显示名（原文字符串，不归一化大小写）。
 *
 * 自定义供应商在 settings.providers[id].label 里保存用户输入的大小写
 * （例如 "JuCode"），而 provider id 会小写成 "jucode" 用于内部寻址；
 * 显示时必须用前者，否则用户看到的名称和自己输入的差一个大小写。
 */
function customProviderLabel(homeDir: string | undefined, providerId: string): string | undefined {
  try {
    const label = loadGlobalSettings(homeDir).providers?.[providerId]?.label;
    return typeof label === "string" && label.trim() ? label : undefined;
  } catch {
    // 读取失败不该影响模型标签渲染，退回 id 归一化结果。
    return undefined;
  }
}
