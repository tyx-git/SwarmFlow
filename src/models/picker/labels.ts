/** 选择器节点的标签渲染与凭据状态判定。 */
﻿import { hasOAuthTokens } from "../../auth/openai/token-store.js";

import {
  findProviderPreset,
} from "../../providers/presets.js";
import {
  runtimeModelName,
} from "../../models/selection.js";
import { isManagedProvider } from "../../config/managed-provider-credentials.js";

import { type ModelCredentialState, type ModelPickerTreeNode } from "./types.js";

export function modelCredentialInfo(providerId: string, providerHasKey: Map<string, boolean>): {
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

export function isCurrentSelection(
  session: any,
  currentConfigName: string,
  providerId: string,
  selectionKey: string,
  modelId: string,
  currentProvider: string,
  currentModel: string,
): boolean {
  const stableSelectionName = `${providerId}:${selectionKey}`;
  const runtimeSelectionName = runtimeModelName(providerId, selectionKey);
  return currentConfigName === stableSelectionName
    || currentConfigName === runtimeSelectionName
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
