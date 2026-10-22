/** /model 的模型选择树构建（两级/分组/厂商前缀）。 */
﻿import { hasOAuthTokens } from "../../auth/openai/token-store.js";
import { hasGitHubTokens } from "../../auth/github-copilot-oauth.js";
import { isModelVisibleForCurrentPlan } from "../../providers/copilot-models-cache.js";
import {
  PROVIDER_PRESETS,
} from "../../providers/presets.js";
import {
  hasEnvApiKey,
  readModelEntries,
} from "../../models/selection.js";

import { describeModel } from "../../models/presentation.js";

import { isCurrentSelection, modelCredentialInfo } from "./labels.js";
import { type ModelPickerTreeContext, type ModelPickerTreeNode } from "./types.js";

const OPENROUTER_VENDOR_ORDER = ["anthropic", "openai", "qwen", "moonshotai", "minimax", "z-ai"];

export function buildModelPickerTree(ctx: ModelPickerTreeContext): ModelPickerTreeNode[] {
  const session = ctx.session;
  const config = session.config;
  if (!config) return [];
  const allowedProviderIds = ctx.allowedProviderIds
    ? new Set(Array.from(ctx.allowedProviderIds))
    : null;
  const includeLocalDiscoverActions = ctx.includeLocalDiscoverActions !== false;

  const allEntries = readModelEntries(config);
  const entries = allEntries;
  const currentProvider = String(ctx.currentSelection?.provider ?? session.primaryAgent?.modelConfig?.provider ?? "");
  const currentModel = String(ctx.currentSelection?.modelId ?? session.primaryAgent?.modelConfig?.model ?? "");
  const currentConfigName = String(ctx.currentSelection?.configName ?? session.currentModelConfigName ?? "");

  // ── Build providerHasKey FIRST (before adding models) ──
  const providerHasKey = new Map<string, boolean>();
  for (const entry of allEntries) {
    if (entry.hasResolvedApiKey) {
      providerHasKey.set(entry.provider, true);
    }
  }
  for (const preset of PROVIDER_PRESETS) {
    if (preset.localServer) continue;
    if (hasEnvApiKey(preset.envVar)) {
      providerHasKey.set(preset.id, true);
    }
  }
  try {
    if (hasOAuthTokens()) providerHasKey.set("openai-codex", true);
  } catch {
    // Ignore auth lookup failures here.
  }
  try {
    if (hasGitHubTokens()) providerHasKey.set("copilot", true);
  } catch {
    // Ignore auth lookup failures here.
  }
  if (currentProvider && session.primaryAgent?.modelConfig?.apiKey) {
    providerHasKey.set(currentProvider, true);
  }

  // Populate only models that are registered in the current configuration.
  // Provider presets remain metadata for grouping, labels, and credentials;
  // their built-in model catalog must not be injected into `/model`.
  const byProvider = new Map<string, Map<string, { modelId: string }>>();
  const providerOrder: string[] = [];

  const addModel = (providerId: string, selectionKey: string, modelId: string) => {
    if (!providerId || !selectionKey || !modelId) return;
    if (allowedProviderIds && !allowedProviderIds.has(providerId)) return;
    if (!byProvider.has(providerId)) {
      byProvider.set(providerId, new Map());
      providerOrder.push(providerId);
    }
    const providerMap = byProvider.get(providerId)!;
    if (!providerMap.has(selectionKey)) {
      providerMap.set(selectionKey, { modelId });
    }
  };

  // Config entries are the source of truth for the model picker. This keeps
  // `/model` limited to models the user has actually added or registered.
  for (const entry of entries) {
    addModel(entry.provider, entry.model, entry.model);
  }

  const presetById = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset] as const));
  const nodes: ModelPickerTreeNode[] = [];
  const processed = new Set<string>();

  const buildModelChildren = (providerId: string): ModelPickerTreeNode[] => {
    const providerMap = byProvider.get(providerId) ?? new Map();
    const filteredEntries =
      providerId === "copilot"
        ? Array.from(providerMap.entries()).filter(([, item]) =>
            isModelVisibleForCurrentPlan(item.modelId),
          )
        : Array.from(providerMap.entries());
    const items = filteredEntries
      .map(([selectionKey, item]) => {
        const descriptor = describeModel({
          providerId,
          selectionKey,
          modelId: item.modelId,
        });
        const current = isCurrentSelection(
          session,
          currentConfigName,
          providerId,
          selectionKey,
          item.modelId,
          currentProvider,
          currentModel,
        );
        const credential = modelCredentialInfo(providerId, providerHasKey);
        return {
          kind: "model" as const,
          id: `${providerId}:${selectionKey}`,
          value: `${providerId}:${selectionKey}`,
          label: descriptor.modelLabel,
          isCurrent: current,
          credentialState: credential.credentialState,
          credentialHint: credential.credentialHint,
          keyMissing: credential.credentialState !== "configured" && credential.credentialState !== "not_required",
          keyHint: credential.credentialHint,
          brandKey: descriptor.brandKey,
          brandLabel: descriptor.brandLabel,
          providerId,
          selectionKey,
          modelId: item.modelId,
        };
      })
      .sort((a, b) => {
        const labelCmp = a.label.localeCompare(b.label);
        if (labelCmp !== 0) return labelCmp;
        return a.value.localeCompare(b.value);
      });

    return items;
  };

  for (const providerId of providerOrder) {
    if (processed.has(providerId)) continue;
    processed.add(providerId);

    const preset = presetById.get(providerId);

    if (preset?.group) {
      const groupMembers = providerOrder.filter((candidate) => presetById.get(candidate)?.group === preset.group);
      for (const member of groupMembers) processed.add(member);

      const subProviders = groupMembers.map((memberId) => {
        const descriptor = describeModel({
          providerId: memberId,
          selectionKey: currentProvider === memberId ? currentModel : undefined,
          modelId: currentProvider === memberId ? currentModel : undefined,
        });
        const children = buildModelChildren(memberId);
        return {
          kind: "provider" as const,
          id: memberId,
          value: memberId,
          label: descriptor.providerLabel,
          isCurrent: children.some((child) => child.isCurrent),
          credentialState: children.every((child) => child.credentialState === "configured" || child.credentialState === "not_required")
            ? "configured"
            : modelCredentialInfo(memberId, providerHasKey).credentialState,
          credentialHint: modelCredentialInfo(memberId, providerHasKey).credentialHint,
          keyMissing: children.some((child) => child.keyMissing),
          keyHint: modelCredentialInfo(memberId, providerHasKey).credentialHint,
          brandKey: descriptor.brandKey,
          brandLabel: descriptor.brandLabel,
          providerId: memberId,
          children,
        };
      });

      const groupLabel = preset.groupLabel ?? preset.group;
      nodes.push({
        kind: "group",
        id: preset.group,
        value: preset.group,
        label: groupLabel,
        isCurrent: subProviders.some((node) => node.isCurrent),
        credentialState: subProviders.every((node) => node.credentialState === "configured" || node.credentialState === "not_required")
          ? "configured"
          : "missing",
        keyMissing: subProviders.some((node) => node.keyMissing),
        brandKey: describeModel({
          providerId,
          selectionKey: currentModel || providerId,
          modelId: currentModel || providerId,
        }).brandKey,
        brandLabel: describeModel({
          providerId,
          selectionKey: currentModel || providerId,
          modelId: currentModel || providerId,
        }).brandLabel,
        children: subProviders,
      });
      continue;
    }

    if (providerId === "openrouter") {
      const providerDescriptor = describeModel({
        providerId,
        selectionKey: currentModel || providerId,
        modelId: currentModel || providerId,
      });
      const children = buildModelChildren(providerId);
      const vendorBuckets = new Map<string, ModelPickerTreeNode[]>();

      for (const child of children) {
        const vendorId = describeModel({
          providerId,
          selectionKey: child.selectionKey,
          modelId: child.modelId,
        }).vendorId ?? "other";
        if (!vendorBuckets.has(vendorId)) {
          vendorBuckets.set(vendorId, []);
        }
        vendorBuckets.get(vendorId)!.push(child);
      }

      const vendorOrder = [
        ...OPENROUTER_VENDOR_ORDER.filter((vendorId) => vendorBuckets.has(vendorId)),
        ...Array.from(vendorBuckets.keys()).filter((vendorId) => !OPENROUTER_VENDOR_ORDER.includes(vendorId)),
      ];

      const vendors = vendorOrder.map((vendorId) => {
        const vendorChildren = vendorBuckets.get(vendorId)!;
        const descriptor = describeModel({
          providerId,
          selectionKey: `${vendorId}/${vendorChildren[0]?.modelId ?? vendorId}`,
          modelId: `${vendorId}/${vendorChildren[0]?.modelId ?? vendorId}`,
        });
        return {
          kind: "vendor" as const,
          id: `openrouter-${vendorId}`,
          value: `openrouter-${vendorId}`,
          label: descriptor.vendorLabel ?? vendorId,
          isCurrent: vendorChildren.some((child) => child.isCurrent),
          credentialState: modelCredentialInfo(providerId, providerHasKey).credentialState,
          credentialHint: modelCredentialInfo(providerId, providerHasKey).credentialHint,
          keyMissing: vendorChildren.some((child) => child.keyMissing),
          keyHint: modelCredentialInfo(providerId, providerHasKey).credentialHint,
          brandKey: descriptor.brandKey,
          brandLabel: descriptor.brandLabel,
          providerId,
          children: vendorChildren,
        };
      });

      nodes.push({
        kind: "provider",
        id: providerId,
        value: providerId,
        label: providerDescriptor.providerLabel,
        isCurrent: vendors.some((node) => node.isCurrent),
        credentialState: modelCredentialInfo(providerId, providerHasKey).credentialState,
        credentialHint: modelCredentialInfo(providerId, providerHasKey).credentialHint,
        keyMissing: vendors.some((node) => node.keyMissing),
        keyHint: modelCredentialInfo(providerId, providerHasKey).credentialHint,
        brandKey: providerDescriptor.brandKey,
        brandLabel: providerDescriptor.brandLabel,
        providerId,
        children: vendors,
      });
      continue;
    }

    if (preset?.localServer) {
      const descriptor = describeModel({
        providerId,
        selectionKey: currentProvider === providerId ? currentModel : providerId,
        modelId: currentProvider === providerId ? currentModel : providerId,
      });
      const children = buildModelChildren(providerId);
      if (includeLocalDiscoverActions) {
        children.push({
          kind: "action",
          id: `${providerId}:__discover__`,
          value: `${providerId}:__discover__`,
          label: "Discover models...",
          isCurrent: false,
          credentialState: "not_required",
          keyMissing: false,
          brandKey: descriptor.brandKey,
          brandLabel: descriptor.brandLabel,
          providerId,
        });
      }
      nodes.push({
        kind: "provider",
        id: providerId,
        value: providerId,
        label: descriptor.providerLabel,
        isCurrent: children.some((child) => child.isCurrent),
        credentialState: "not_required",
        keyMissing: false,
        brandKey: descriptor.brandKey,
        brandLabel: descriptor.brandLabel,
        providerId,
        children,
      });
      continue;
    }

    const descriptor = describeModel({
      providerId,
      selectionKey: currentProvider === providerId ? currentModel : providerId,
      modelId: currentProvider === providerId ? currentModel : providerId,
    });
    const children = buildModelChildren(providerId);
    nodes.push({
      kind: "provider",
      id: providerId,
      value: providerId,
      label: descriptor.providerLabel,
      isCurrent: children.some((child) => child.isCurrent),
      credentialState: modelCredentialInfo(providerId, providerHasKey).credentialState,
      credentialHint: modelCredentialInfo(providerId, providerHasKey).credentialHint,
      keyMissing: children.some((child) => child.keyMissing),
      keyHint: modelCredentialInfo(providerId, providerHasKey).credentialHint,
      brandKey: descriptor.brandKey,
      brandLabel: descriptor.brandLabel,
      providerId,
      children,
    });
  }

  return nodes;
}

// ------------------------------------------------------------------
// 凭据端点树 — 叶节点是*端点*（密钥所在位置），不是模型。
// 由 `/provider` 子流程和初始化向导共享。覆盖注册表提供者中的
// `credential.kind: {env, managed}` 以及自定义提供者；
// 不包括 OAuth 和本地。分组提供者（Kimi/GLM/Qwen/MiniMax）向下
// 展开到各自的子提供者，每个都是一个独立的密钥槽。
// ------------------------------------------------------------------
