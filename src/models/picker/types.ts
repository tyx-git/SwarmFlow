/** 模型/凭据选择器的节点类型与上下文契约。 */
﻿import { hasOAuthTokens } from "../../auth/openai/token-store.js";

import type { ModelPickerSessionView } from "../../session/contract.js";

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
  session: ModelPickerSessionView;
  currentSelection?: {
    configName?: string;
    provider: string;
    selectionKey: string;
    modelId: string;
  };
  allowedProviderIds?: Iterable<string>;
  includeAddProviderAction?: boolean;
  includeLocalDiscoverActions?: boolean;
}

export interface CredentialEndpointTreeContext {
  session: ModelPickerSessionView;
}

export interface CredentialEndpointTreeOptions {
  /**
   * 包含 OAuth 和本地服务器提供者作为可选叶节点。初始化
   * 向导设置此项（您可以选择任何提供者类型作为您的模型）；`/provider`
   * 子流程保持关闭（OAuth 也从 /provider 进入；本地不需要密钥）。
   */
  includeOAuthAndLocal?: boolean;
}
