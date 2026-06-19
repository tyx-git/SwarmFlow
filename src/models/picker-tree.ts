import { hasOAuthTokens } from "../auth/openai-oauth.js";
import { hasGitHubTokens } from "../auth/github-copilot-oauth.js";
import { isModelVisibleForCurrentPlan } from "../providers/copilot-models-cache.js";
import {
  PROVIDER_PRESETS,
  findProviderPreset,
} from "../providers/presets.js";
import {
  hasEnvApiKey,
  readModelEntries,
  runtimeModelName,
} from "../models/selection.js";
import { isManagedProvider, providerCredentialKind } from "../config/managed-provider-credentials.js";
import { describeModel } from "../models/presentation.js";
import {
  currentCredentialKey,
  isCredentialConfigured,
  maskKey,
  resolveCredentialSlot,
} from "../providers/credential-flow.js";
import { loadGlobalSettings } from "../config/persistence.js";

export type ModelPickerNodeKind =
  | "group"
  | "provider"
  | "vendor"
  | "model"
  | "action";

export type ModelCredentialState =
  | "configured"
  | "missing"
  | "oauth_missing"
  | "not_required";

export interface ModelPickerTreeNode {
  kind: ModelPickerNodeKind;
  id: string;
  value: string;
  label: string;
  note?: string;
  isCurrent: boolean;
  credentialState: ModelCredentialState;
  credentialHint?: string;
  keyMissing: boolean;
  keyHint?: string;
  brandKey?: string;
  brandLabel?: string;
  providerId?: string;
  selectionKey?: string;
  modelId?: string;
  children?: ModelPickerTreeNode[];
}

export interface ModelPickerTreeContext {
  session: any;
  allowedProviderIds?: Iterable<string>;
  includeAddProviderAction?: boolean;
  includeLocalDiscoverActions?: boolean;
}

const OPENROUTER_VENDOR_ORDER = ["anthropic", "openai", "qwen", "moonshotai", "minimax", "z-ai"];

function modelCredentialInfo(providerId: string, providerHasKey: Map<string, boolean>): {
  credentialState: ModelCredentialState;
  credentialHint?: string;
} {
  const preset = findProviderPreset(providerId);
  if (preset?.localServer) {
    return { credentialState: "not_required" };
  }
  if (providerHasKey.get(providerId)) {
    return { credentialState: "configured" };
  }
  if (providerId === "openai-codex") {
    return {
      credentialState: "oauth_missing",
      credentialHint: "not logged in: run swarmflow oauth",
    };
  }
  if (providerId === "copilot") {
    return {
      credentialState: "oauth_missing",
      credentialHint: "not logged in: run swarmflow oauth",
    };
  }
  if (isManagedProvider(providerId)) {
    return {
      credentialState: "missing",
      credentialHint: "key missing: select to configure",
    };
  }
  return {
    credentialState: "missing",
    credentialHint: "key missing: run swarmflow init",
  };
}

function isCurrentSelection(
  session: any,
  providerId: string,
  selectionKey: string,
  modelId: string,
  currentProvider: string,
  currentModel: string,
): boolean {
  const stableSelectionName = `${providerId}:${selectionKey}`;
  const runtimeSelectionName = runtimeModelName(providerId, selectionKey);
  return session.currentModelConfigName === stableSelectionName
    || session.currentModelConfigName === runtimeSelectionName
    || (
      selectionKey === modelId
      && providerId === currentProvider
      && modelId === currentModel
    );
}

function buildLeafLabel(node: ModelPickerTreeNode): string {
  let label = node.label;
  if (node.note) {
    label = `${label}  (${node.note})`;
  }
  if (node.isCurrent && node.credentialState !== "configured" && node.credentialState !== "not_required" && node.credentialHint) {
    return `${label}  (current, ${node.credentialHint})`;
  }
  if (node.isCurrent) {
    return `${label}  (current)`;
  }
  if (node.credentialState !== "configured" && node.credentialState !== "not_required" && node.credentialHint) {
    return `${label}  (${node.credentialHint})`;
  }
  return label;
}

function buildBranchLabel(node: ModelPickerTreeNode): string {
  // 分支节点不显示 (current) — 个体模型子节点有自己的标记
  return node.label;
}

export function labelModelPickerNode(node: ModelPickerTreeNode): string {
  return node.kind === "model" || node.kind === "action"
    ? buildLeafLabel(node)
    : buildBranchLabel(node);
}

export function toCommandPickerOptions(nodes: ModelPickerTreeNode[]): Array<{ label: string; value: string; children?: any[] }> {
  return nodes.map((node) => ({
    label: labelModelPickerNode(node),
    value: node.value,
    children: node.children ? toCommandPickerOptions(node.children) : undefined,
  }));
}

export function buildModelPickerTree(ctx: ModelPickerTreeContext): ModelPickerTreeNode[] {
  const session = ctx.session;
  const config = session.config;
  if (!config) return [];
  const allowedProviderIds = ctx.allowedProviderIds
    ? new Set(Array.from(ctx.allowedProviderIds))
    : null;
  const includeAddProviderAction = ctx.includeAddProviderAction !== false;
  const includeLocalDiscoverActions = ctx.includeLocalDiscoverActions !== false;

  const entries = readModelEntries(config);
  const currentProvider = String(session.primaryAgent?.modelConfig?.provider ?? "");
  const currentModel = String(session.primaryAgent?.modelConfig?.model ?? "");

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

  for (const preset of PROVIDER_PRESETS) {
    for (const model of preset.models) {
      addModel(preset.id, model.key, model.id);
    }
  }

  for (const entry of entries) {
    addModel(entry.provider, entry.model, entry.model);
  }

  const providerHasKey = new Map<string, boolean>();
  for (const entry of entries) {
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
          note: descriptor.note,
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
        return (a.note ?? "").localeCompare(b.note ?? "");
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
    if (!preset) {
      // Custom (non-preset) provider —offer management.
      children.push({
        kind: "action",
        id: `${providerId}:__manage__`,
        value: `manage:${providerId}`,
        label: "Manage / remove...",
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

  for (const preset of PROVIDER_PRESETS) {
    if (!preset.localServer || processed.has(preset.id)) continue;
    if (allowedProviderIds && !allowedProviderIds.has(preset.id)) continue;
    const descriptor = describeModel({
      providerId: preset.id,
      selectionKey: preset.id,
      modelId: preset.id,
    });
    nodes.push({
      kind: "provider",
      id: preset.id,
      value: preset.id,
      label: descriptor.providerLabel,
      isCurrent: false,
      credentialState: "not_required",
      keyMissing: false,
      brandKey: descriptor.brandKey,
      brandLabel: descriptor.brandLabel,
      providerId: preset.id,
      children: includeLocalDiscoverActions ? [{
        kind: "action",
        id: `${preset.id}:__discover__`,
        value: `${preset.id}:__discover__`,
        label: "Discover models...",
        isCurrent: false,
        credentialState: "not_required",
        keyMissing: false,
        brandKey: descriptor.brandKey,
        brandLabel: descriptor.brandLabel,
        providerId: preset.id,
      }] : [],
    });
  }

  // "添加提供者..." 操作在树的底部
  if (includeAddProviderAction) {
    nodes.push({
      kind: "action",
      id: "__add_provider__",
      value: "__add_provider__",
      label: "Add custom provider...",
      isCurrent: false,
      credentialState: "not_required",
      keyMissing: false,
    });
  }

  return nodes;
}

// ------------------------------------------------------------------
// 凭据端点树 — 叶节点是*端点*（密钥所在位置），不是模型。
// 由 `/key` 命令和初始化向导共享。覆盖注册表提供者中的
// `credential.kind: {env, managed}` 以及自定义提供者；
// 不包括 OAuth 和本地。分组提供者（Kimi/GLM/Qwen/MiniMax）向下
// 展开到各自的子提供者，每个都是一个独立的密钥槽。
// ------------------------------------------------------------------

export interface CredentialEndpointTreeContext {
  session: any;
}

export interface CredentialEndpointTreeOptions {
  /**
   * 包含 OAuth 和本地服务器提供者作为可选叶节点。初始化
   * 向导设置此项（您可以选择任何提供者类型作为您的模型）；`/key`
   * 命令保持关闭（OAuth 使用 /codex /copilot；本地不需要密钥）。
   */
  includeOAuthAndLocal?: boolean;
}

function credentialEndpointLeaf(providerId: string, label: string): ModelPickerTreeNode {
  const slot = resolveCredentialSlot(providerId, { label });
  const configured = slot ? isCredentialConfigured(slot) : false;
  const key = slot ? currentCredentialKey(slot) : undefined;
  return {
    kind: "model",
    id: providerId,
    value: providerId,
    label,
    note: configured && key ? maskKey(key) : undefined,
    isCurrent: false,
    credentialState: configured ? "configured" : "missing",
    credentialHint: configured ? undefined : "key missing",
    keyMissing: !configured,
    keyHint: configured ? undefined : "key missing",
    providerId,
  };
}

function isKeyedPreset(preset: { id: string; localServer?: boolean }): boolean {
  if (preset.localServer) return false;
  const kind = providerCredentialKind(preset.id);
  return kind === "env" || kind === "managed";
}

function endpointLabel(providerId: string): string {
  return describeModel({ providerId, selectionKey: providerId, modelId: providerId }).providerLabel
    ?? findProviderPreset(providerId)?.name
    ?? providerId;
}

function oauthEndpointLeaf(providerId: string): ModelPickerTreeNode {
  let loggedIn = false;
  try {
    loggedIn = providerId === "openai-codex" ? hasOAuthTokens()
      : providerId === "copilot" ? hasGitHubTokens()
      : false;
  } catch {
    loggedIn = false;
  }
  return {
    kind: "model",
    id: providerId,
    value: providerId,
    label: endpointLabel(providerId),
    isCurrent: false,
    credentialState: loggedIn ? "configured" : "oauth_missing",
    credentialHint: loggedIn ? undefined : "login required",
    keyMissing: !loggedIn,
    keyHint: loggedIn ? undefined : "login required",
    providerId,
  };
}

function localEndpointLeaf(providerId: string): ModelPickerTreeNode {
  return {
    kind: "model",
    id: providerId,
    value: providerId,
    label: endpointLabel(providerId),
    isCurrent: false,
    credentialState: "not_required",
    keyMissing: false,
    providerId,
  };
}

export function buildCredentialEndpointTree(
  ctx: CredentialEndpointTreeContext,
  opts?: CredentialEndpointTreeOptions,
): ModelPickerTreeNode[] {
  const session = ctx.session;
  const config = session?.config;
  const nodes: ModelPickerTreeNode[] = [];
  const processed = new Set<string>();

  for (const preset of PROVIDER_PRESETS) {
    if (processed.has(preset.id)) continue;
    if (!isKeyedPreset(preset)) {
      processed.add(preset.id);
      continue;
    }

    if (preset.group) {
      const members = PROVIDER_PRESETS.filter(
        (candidate) => candidate.group === preset.group && isKeyedPreset(candidate),
      );
      for (const member of members) processed.add(member.id);
      const children = members.map((member) =>
        credentialEndpointLeaf(member.id, member.subLabel ?? endpointLabel(member.id)),
      );
      nodes.push({
        kind: "group",
        id: preset.group,
        value: preset.group,
        label: preset.groupLabel ?? preset.group,
        isCurrent: false,
        credentialState: children.every((child) => child.credentialState === "configured")
          ? "configured"
          : "missing",
        keyMissing: children.some((child) => child.keyMissing),
        children,
      });
      continue;
    }

    processed.add(preset.id);
    nodes.push(credentialEndpointLeaf(preset.id, endpointLabel(preset.id)));
  }

  if (opts?.includeOAuthAndLocal) {
    for (const preset of PROVIDER_PRESETS) {
      if (providerCredentialKind(preset.id) === "oauth") nodes.push(oauthEndpointLeaf(preset.id));
    }
    for (const preset of PROVIDER_PRESETS) {
      if (preset.localServer) nodes.push(localEndpointLeaf(preset.id));
    }
  }

  // 来自 settings/config 的自定义（非注册表）提供者
  const settings = loadGlobalSettings();
  const customLabels = new Map<string, string>();
  if (config) {
    for (const entry of readModelEntries(config)) {
      const id = entry.provider;
      if (!id || customLabels.has(id)) continue;
      if (findProviderPreset(id) || isManagedProvider(id)) continue;
      customLabels.set(id, settings.providers?.[id]?.label ?? id);
    }
  }
  for (const [id, label] of customLabels) {
    nodes.push(credentialEndpointLeaf(id, label));
  }

  return nodes;
}
