import {
  findProviderPreset,
  findProviderPresetModel,
} from "./providers/presets.js";
import { OPENROUTER_VENDOR_BRAND } from "./models/registry.js";
import {
  EFFECTIVE_MODEL_TABLES,
  EFFECTIVE_PROVIDER_SPECS,
} from "./providers/registry-effective.js";

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

/**
 * 规范化 id → displayName，从模型注册表派生（单一真实来源）。
 * 替换旧的手动维护的 MODEL_LABEL_OVERRIDES 和
 * 对顺序敏感的 SLUG_FRAGMENTS 正则回退：每个注册的模型
 *（包括别名拼写）现在通过精确规范查找解析，因此正则
 * 表已消失。未注册的 id 沿用 humanizeUnknownModel 的
 * 单词启发式，与以前相同。
 */
const MODEL_LABEL_OVERRIDES: Record<string, string> = EFFECTIVE_MODEL_TABLES.labelOverrides;

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
  note?: string;
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

function canonicalizeModelKey(model: string): string {
  return normalizeModelId(model)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanizeUnknownModel(model: string): string {
  const normalized = normalizeModelId(model).trim();
  const canonical = canonicalizeModelKey(normalized);
  const override = MODEL_LABEL_OVERRIDES[canonical];
  if (override) return override;

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
}): ModelDescriptor {
  const providerId = String(params.providerId ?? "").trim();
  const selectionKey = String(params.selectionKey ?? params.modelId ?? "").trim();
  const modelId = String(params.modelId ?? params.selectionKey ?? "").trim();
  const configName = params.configName?.trim() || undefined;

  const preset = findProviderPreset(providerId);
  const presetModel = findProviderPresetModel(providerId, selectionKey || modelId);
  const note = presetModel?.optionNote;
  let modelLabel = presetModel?.label
    ? presetModel.label.trim()
    : humanizeUnknownModel(modelId || selectionKey);
  if (note && modelLabel.endsWith(`(${note})`)) {
    modelLabel = modelLabel.slice(0, modelLabel.length - note.length - 2).trim();
  }
  const compactModelLabel = compactModelLabelForDisplay(providerId, modelLabel);

  const modelDetailedLabel = note ? `${modelLabel} (${note})` : modelLabel;
  const compactModelDetailedLabel = note ? `${compactModelLabel} (${note})` : compactModelLabel;
  const brandKey = resolveBrandKey(providerId);
  const brandLabel = resolveBrandLabel(providerId);
  const providerLabel = resolveProviderLabel(providerId);
  const scopedLabel = providerLabel && modelLabel ? `${providerLabel}/${modelLabel}` : modelLabel || providerLabel;
  const scopedDetailedLabel = note ? `${scopedLabel} (${note})` : scopedLabel;
  const compactScopedLabel = providerLabel && compactModelLabel
    ? `${providerLabel}/${compactModelLabel}`
    : compactModelLabel || providerLabel;
  const compactScopedDetailedLabel = note ? `${compactScopedLabel} (${note})` : compactScopedLabel;
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
    note,
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

  return describeModel({
    configName: prefs?.modelConfigName ?? session.currentModelConfigName ?? modelConfig.name,
    providerId: prefs?.modelProvider ?? modelConfig.provider,
    selectionKey: prefs?.modelSelectionKey ?? modelConfig.model,
    modelId: prefs?.modelId ?? session.currentModelName ?? modelConfig.model,
  });
}

export function formatCurrentModelScopedLabel(session: any): string {
  return getCurrentModelDescriptor(session)?.scopedLabel ?? "";
}
