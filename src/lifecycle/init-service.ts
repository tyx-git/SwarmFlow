/**
 * InitService — 初始化向导的纯逻辑层。
 *
 * 提供初始化向导所需的所有数据查询和配置操作，
 * 没有任何 UI 依赖。TUI 向导（inquirer）和
 * 服务器模式 init RPC（用于 GUI）都驱动这个相同的服务。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "../config/home-dir.js";
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../providers/presets.js";
import { fetchModelsFromServer } from "../models/discovery.js";
import { normalizeEndpointUrl } from "../commands/provider/endpoint.js";
import { setDotenvKey } from "../lifecycle/dotenv.js";
import type { SwarmflowSettings, ProviderEntry } from "../config/settings/types.js";
import { saveSettings, globalSettingsPath, loadGlobalSettings } from "../config/settings/io.js";
import {
  hasAnyManagedCredential,
  hasManagedCredential,
  isManagedProvider,
} from "../config/managed-provider-credentials.js";
import { Config } from "../config/loader.js";
import type { ModelPickerSessionView } from "../session/contract.js";
import { getThinkingLevels, getSubAgentThinkingLevels, runtimeTransportProtocol } from "../config/model-capabilities.js";
import { buildModelPickerTree } from "../models/picker/model-tree.js";
import { labelModelPickerNode } from "../models/picker/labels.js";
import type { ModelPickerTreeNode } from "../models/picker/types.js";
import { parseProviderModelTarget } from "../models/selection.js";
import { describeModel } from "../models/presentation.js";

import type {
  ConfigStatus,
  ModelPickerNode,
  ModelSelection,
  ProviderPresetInfo,
  SearchApiOption,
} from "./types.js";

export const SEARCH_API_OPTIONS: readonly SearchApiOption[] = [
  { env: "SERPER_API_KEY", name: "Serper", url: "https://serper.dev", free: "2,500 queries/month", configured: false },
  { env: "TAVILY_API_KEY", name: "Tavily", url: "https://tavily.com", free: "1,000 queries/month", configured: false },
  { env: "EXA_API_KEY", name: "Exa", url: "https://exa.ai", free: "one-time credit", configured: false },
  { env: "BRAVE_SEARCH_API_KEY", name: "Brave Search", url: "https://brave.com/search/api/", free: "$5 credit", configured: false },
];

// ------------------------------------------------------------------
// InitService
// ------------------------------------------------------------------

export class InitService {
  private configuredProviders = new Map<string, ProviderEntry>();
  private readonly homeDir: string;

  constructor() {
    this.homeDir = getSwarmflowHomeDir();
    this.configuredProviders = this.detectConfiguredProviders();
  }

  // ── 配置检测 ──

  checkConfigStatus(): ConfigStatus {
    const existingSettings = loadGlobalSettings(this.homeDir);
    const hasProviders =
      Boolean(existingSettings.providers && Object.keys(existingSettings.providers).length > 0) ||
      hasAnyManagedCredential();

    return {
      configured: hasProviders,
      hasProviders,
      providers: this.listProviderPresets(),
    };
  }

  // ── 提供商预设 ──

  listProviderPresets(): ProviderPresetInfo[] {
    return PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      envVar: preset.envVar,
      configured: this.isProviderConfigured(preset),
      isOAuth: preset.id === "openai-codex" || preset.id === "copilot",
      isLocal: Boolean(preset.localServer),
      isManaged: isManagedProvider(preset.id),
      models: (this.configuredProviders.get(preset.id)?.models ?? []).map((model) => ({
        key: model.id,
        id: model.id,
        label: model.id,
      })),
    }));
  }

  // ── 提供商配置 ──

  configureApiKeyProvider(providerId: string, apiKey: string): { ok: boolean; envVar: string } {
    const preset = PROVIDER_PRESETS.find((p) => p.id === providerId);
    if (!preset) throw new Error(`Unknown provider: ${providerId}`);
    if (preset.localServer) throw new Error(`${providerId} is a local server, use configureLocalProvider`);

    const envVar = preset.envVar;
    if (apiKey.trim()) {
      setDotenvKey(envVar, apiKey.trim());
    }
    this.configuredProviders.set(providerId, {
      ...this.configuredProviders.get(providerId),
      api_key_env: envVar,
    });
    return { ok: true, envVar };
  }

  async configureLocalProvider(
    _providerId: string,
    baseUrl: string,
    apiKey?: string,
  ): Promise<{
    ok: boolean;
    models: Array<{ id: string; contextLength?: number }>;
  }> {
    const effectiveKey = apiKey?.trim() || "local";
    const models = await fetchModelsFromServer(
      normalizeEndpointUrl(baseUrl, "openai-chat").baseUrl,
      5000,
      effectiveKey,
    );
    return { ok: true, models };
  }

  saveLocalProvider(
    providerId: string,
    baseUrl: string,
    modelId: string,
    contextLength?: number,
    apiKey?: string,
  ): void {
    const entry: ProviderEntry = {
      base_url: normalizeEndpointUrl(baseUrl, "openai-chat").baseUrl,
      model: modelId,
      context_length: contextLength,
    };
    if (apiKey && apiKey !== "local") entry.api_key = apiKey;
    this.configuredProviders.set(providerId, entry);
  }

  configureManagedProvider(providerId: string, apiKey: string): { ok: boolean; envVar: string } {
    const preset = PROVIDER_PRESETS.find((p) => p.id === providerId);
    if (!preset) throw new Error(`Unknown provider: ${providerId}`);

    const envVar = preset.envVar;
    if (apiKey.trim()) {
      setDotenvKey(envVar, apiKey.trim());
    }
    this.configuredProviders.set(providerId, {
      ...this.configuredProviders.get(providerId),
      api_key_env: envVar,
    });
    return { ok: true, envVar };
  }

  // ── 模型选择树 ──

  buildModelPickerTree(currentSelection?: ModelSelection): ModelPickerNode[] {
    const session = this.createPickerSession(currentSelection);
    const tree = buildModelPickerTree({
      session,
      includeAddProviderAction: false,
      includeLocalDiscoverActions: true,
    });
    return this.serializeTree(tree);
  }

  resolveModelSelection(target: string): ModelSelection {
    const parsed = parseProviderModelTarget(target);
    if (!parsed) throw new Error(`Invalid model target: ${target}`);

    return {
      configName: `${parsed.provider}:${parsed.model}`,
      providerId: parsed.provider,
      selectionKey: parsed.model,
      modelId: parsed.model,
    };
  }

  describeModelSelection(selection: ModelSelection): string {
    const description = describeModel({
      providerId: selection.providerId,
      selectionKey: selection.selectionKey,
      modelId: selection.modelId,
      configName: selection.configName,
    });
    return description.scopedDetailedLabel || selection.configName;
  }

  // ── 思考深度 ──

  getThinkingLevels(modelId: string): string[] {
    return getThinkingLevels(modelId);
  }

  getSubAgentThinkingLevels(modelId: string): string[] {
    return getSubAgentThinkingLevels(modelId);
  }

  // ── 网络搜索 ──

  getSearchApiOptions(): SearchApiOption[] {
    return SEARCH_API_OPTIONS.map((opt) => ({
      ...opt,
      configured: Boolean(process.env[opt.env]?.trim()),
    }));
  }

  saveSearchApiKey(envVar: string, apiKey: string): void {
    if (apiKey.trim()) {
      setDotenvKey(envVar, apiKey.trim());
    }
  }

  // ── 保存最终配置 ──

  saveConfiguration(opts: {
    modelSelection?: ModelSelection;
    thinkingLevel?: string;
  }): void {
    const providers: Record<string, ProviderEntry> = {};
    this.configuredProviders.forEach((entry, id) => {
      providers[id] = entry;
    });

    // 模型与思考深度只写入 settings.json：currentProvider + currentModel。
    // state/model-selection.json 已废弃，不再生成。
    const selection = opts.modelSelection;
    const selectedProvider = selection?.providerId?.trim();
    const selectedModel = selection?.modelId?.trim() || selection?.selectionKey?.trim();
    let currentProvider: string | undefined;
    if (selection && selectedProvider && selectedModel && providers[selectedProvider]) {
      providers[selectedProvider] = {
        ...providers[selectedProvider],
        currentModel: {
          model: selectedModel,
          ...(selection.configName ? { configName: selection.configName } : {}),
          ...(opts.thinkingLevel ? { thinkingDepth: opts.thinkingLevel } : {}),
        },
      };
      currentProvider = selectedProvider;
    }

    const settings: SwarmflowSettings = {
      currentProvider,
      thinking_level:
        opts.thinkingLevel && opts.thinkingLevel !== "off"
          ? opts.thinkingLevel
          : undefined,
      providers: Object.keys(providers).length > 0 ? providers : undefined,
    };

    saveSettings(settings, globalSettingsPath(this.homeDir));

    mkdirSync(join(this.homeDir, "prompts", "templates"), { recursive: true });
    mkdirSync(join(this.homeDir, "skills"), { recursive: true });

    // 为会话产物创建 workspace 的 .swarmflow 目录占位。
    mkdirSync(join(process.cwd(), ".swarmflow"), { recursive: true });
  }

  // ── 内部辅助函数 ──

  private detectConfiguredProviders(): Map<string, ProviderEntry> {
    const providers = new Map<string, ProviderEntry>();
    const existingProviders = loadGlobalSettings(this.homeDir).providers ?? {};
    for (const preset of PROVIDER_PRESETS) {
      const existing = existingProviders[preset.id];
      if (existing) providers.set(preset.id, existing);
      if (preset.localServer) continue;
      if (isManagedProvider(preset.id)) {
        if (hasManagedCredential(preset.id)) {
          providers.set(preset.id, { ...existing, api_key_env: existing?.api_key_env ?? preset.envVar });
        }
        continue;
      }
      if (process.env[preset.envVar]) {
        providers.set(preset.id, { ...existing, api_key_env: existing?.api_key_env ?? preset.envVar });
      }
    }
    return providers;
  }

  private isProviderConfigured(preset: ProviderPreset): boolean {
    if (this.configuredProviders.has(preset.id)) return true;
    if (preset.localServer) return false;
    if (isManagedProvider(preset.id)) return hasManagedCredential(preset.id);
    return Boolean(process.env[preset.envVar]);
  }

  private createPickerSession(currentSelection?: ModelSelection): ModelPickerSessionView {
    const config = new Config({});

    for (const [providerId, entry] of this.configuredProviders) {
      const models = entry.models?.length
        ? entry.models
        : entry.model
          ? [{ id: entry.model, context_length: entry.context_length ?? 128_000 }]
          : [];
      const placeholderKey = entry.api_key_env
        ? `\${${entry.api_key_env}}`
        :
        providerId === "openai-codex"
          ? "oauth:openai-codex"
          : providerId === "copilot"
            ? "oauth:copilot"
            : entry.api_key ?? "wizard-configured";
      for (const model of models) {
        config.upsertModelRaw(`${providerId}:${model.id}`, {
          provider: providerId,
          model: model.id,
          api_key: placeholderKey,
          ...(entry.base_url ? { base_url: entry.base_url } : {}),
          ...(entry.protocol ? { transport_protocol: runtimeTransportProtocol(entry.protocol) ?? "chat" } : {}),
          context_length: model.context_length,
          ...(model.max_output_tokens ? { max_tokens: model.max_output_tokens } : {}),
          supports_multimodal: model.multimodal ?? false,
          supports_web_search: model.web_search ?? false,
        });
      }
    }

    let currentModelConfig: { provider?: string; model?: string } | undefined;
    if (currentSelection) {
      try {
        currentModelConfig = config.getModel(currentSelection.configName);
      } catch {
        currentModelConfig = { provider: currentSelection.providerId, model: currentSelection.modelId };
      }
    }

    return {
      config,
      currentModelConfigName: currentSelection?.configName,
      primaryAgent: { modelConfig: currentModelConfig ?? { provider: "", model: "" } },
    };
  }

  private serializeTree(nodes: ModelPickerTreeNode[]): ModelPickerNode[] {
    return nodes.map((node) => ({
      id: node.id,
      label: labelModelPickerNode(node),
      value: node.value,
      children: node.children ? this.serializeTree(node.children) : undefined,
    }));
  }
}
