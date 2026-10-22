/**
 * 初始化向导与初始化 RPC 共享的数据形状。
 */

export interface ProviderPresetInfo {
  id: string;
  name: string;
  envVar: string;
  configured: boolean;
  isOAuth: boolean;
  isLocal: boolean;
  isManaged: boolean;
  models: Array<{ key: string; id: string; label: string }>;
}

export interface ModelPickerNode {
  id: string;
  label: string;
  value?: string;
  children?: ModelPickerNode[];
}

export interface ModelSelection {
  configName: string;
  providerId: string;
  selectionKey: string;
  modelId: string;
}

export interface ConfigStatus {
  configured: boolean;
  hasProviders: boolean;
  providers: ProviderPresetInfo[];
}

export interface SearchApiOption {
  env: string;
  name: string;
  url: string;
  free: string;
  configured: boolean;
}
