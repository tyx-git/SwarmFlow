/** /provider 的凭据（API key / OAuth / 本地端点）选择树构建。 */
﻿import { hasOAuthTokens } from "../../auth/openai/token-store.js";
import { hasGitHubTokens } from "../../auth/github-copilot-oauth.js";

import {
  PROVIDER_PRESETS,
  findProviderPreset,
} from "../../providers/presets.js";
import {
  readModelEntries,
} from "../../models/selection.js";
import { isManagedProvider, providerCredentialKind } from "../../config/managed-provider-credentials.js";
import { describeModel } from "../../models/presentation.js";
import {
  currentCredentialKey,
  isCredentialConfigured,
  maskKey,
  resolveCredentialSlot,
} from "../../providers/credential-flow.js";
import { loadGlobalSettings } from "../../config/settings/io.js";
import { type CredentialEndpointTreeContext, type CredentialEndpointTreeOptions, type ModelPickerTreeNode } from "./types.js";

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
