/**
 * InitService — 初始化向导的纯逻辑层。
 *
 * 提供初始化向导所需的所有数据查询和配置操作，
 * 没有任何 UI 依赖。TUI 向导（inquirer）和
 * 服务器模式 init RPC（用于 GUI）都驱动这个相同的服务。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "../lib/home-path.js";
import {
  PROVIDER_PRESETS,
  buildProviderPresetRawConfig,
  type ProviderPreset,
} from "../providers/presets.js";
import { fetchModelsFromServer } from "../models/discovery.js";
import { setDotenvKey } from "../lifecycle/dotenv.js";
import {
  type SwarmflowSettings,
  type ProviderEntry,
  type ModelTierEntry,
  saveSettings,
  globalSettingsPath,
  saveModelSelectionState,
  loadGlobalSettings,
} from "../config/persistence.js";
import {
  hasAnyManagedCredential,
  hasManagedCredential,
  isManagedProvider,
} from "../config/managed-provider-credentials.js";
import { Config, getThinkingLevels, getTierEligibleThinkingLevels } from "../config/config.js";
import {
  buildModelPickerTree,
  labelModelPickerNode,
  type ModelPickerTreeNode,
} from "../models/picker-tree.js";
import { createModelTierEntry, parseProviderModelTarget } from "../models/selection.js";
import { describeModel } from "../models/presentation.js";

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

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

  // ── Config detection ──

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

  // ── Provider presets ──

  listProviderPresets(): ProviderPresetInfo[] {
    return PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      envVar: preset.envVar,
      configured: this.isProviderConfigured(preset),
      isOAuth: preset.id === "openai-codex" || preset.id === "copilot",
      isLocal: Boolean(preset.localServer),
      isManaged: isManagedProvider(preset.id),
      models: preset.models.map((m) => ({ key: m.key, id: m.id, label: m.label })),
    }));
  }

  // ── Provider configuration ──

  configureApiKeyProvider(providerId: string, apiKey: string): { ok: boolean; envVar: string } {
    const preset = PROVIDER_PRESETS.find((p) => p.id === providerId);
    if (!preset) throw new Error(`Unknown provider: ${providerId}`);
    if (preset.localServer) throw new Error(`${providerId} is a local server, use configureLocalProvider`);

    const envVar = preset.envVar;
    if (apiKey.trim()) {
      setDotenvKey(envVar, apiKey.trim());
    }
    this.configuredProviders.set(providerId, { api_key_env: envVar });
    return { ok: true, envVar };
  }

  async configureLocalProvider(
    providerId: string,
    baseUrl: string,
    apiKey?: string,
  ): Promise<{
    ok: boolean;
    models: Array<{ id: string; contextLength?: number }>;
  }> {
    const effectiveKey = apiKey?.trim() || "local";
    const models = await fetchModelsFromServer(baseUrl, 5000, effectiveKey);
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
      base_url: baseUrl,
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
    this.configuredProviders.set(providerId, { api_key_env: envVar });
    return { ok: true, envVar };
  }

  // ── Model picker tree ──

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

    const presetModel = PROVIDER_PRESETS
      .find((preset) => preset.id === parsed.provider)
      ?.models.find((model) => model.key === parsed.model);

    return {
      configName: `${parsed.provider}:${parsed.model}`,
      providerId: parsed.provider,
      selectionKey: parsed.model,
      modelId: presetModel?.id ?? parsed.model,
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

  // ── Thinking levels ──

  getThinkingLevels(modelId: string): string[] {
    return getThinkingLevels(modelId);
  }

  getTierEligibleThinkingLevels(modelId: string): string[] {
    return getTierEligibleThinkingLevels(modelId);
  }

  // ── Web search ──

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

  // ── Save final configuration ──

  saveConfiguration(opts: {
    modelSelection?: ModelSelection;
    thinkingLevel?: string;
    tierConfig?: Record<string, ModelTierEntry>;
  }): void {
    const providers: Record<string, ProviderEntry> = {};
    this.configuredProviders.forEach((entry, id) => {
      providers[id] = entry;
    });

    const settings: SwarmflowSettings = {
      thinking_level:
        opts.thinkingLevel && opts.thinkingLevel !== "off" && opts.thinkingLevel !== "none"
          ? opts.thinkingLevel
          : undefined,
      providers: Object.keys(providers).length > 0 ? providers : undefined,
      model_tiers: opts.tierConfig,
    };

    saveSettings(settings, globalSettingsPath(this.homeDir));

    if (opts.modelSelection) {
      saveModelSelectionState({
        config_name: opts.modelSelection.configName,
        provider: opts.modelSelection.providerId,
        selection_key: opts.modelSelection.selectionKey,
        model_id: opts.modelSelection.modelId,
        thinking_level: opts.thinkingLevel,
      });
    }

    mkdirSync(join(this.homeDir, "prompts", "templates"), { recursive: true });
    mkdirSync(join(this.homeDir, "skills"), { recursive: true });

    // Create workspace .swarmflow directory placeholder for session artifacts.
    mkdirSync(join(process.cwd(), ".swarmflow"), { recursive: true });
  }

  // ── Internal helpers ──

  private detectConfiguredProviders(): Map<string, ProviderEntry> {
    const providers = new Map<string, ProviderEntry>();
    for (const preset of PROVIDER_PRESETS) {
      if (preset.localServer) continue;
      if (isManagedProvider(preset.id)) {
        if (hasManagedCredential(preset.id)) {
          providers.set(preset.id, { api_key_env: preset.envVar });
        }
        continue;
      }
      if (process.env[preset.envVar]) {
        providers.set(preset.id, { api_key_env: preset.envVar });
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

  private createPickerSession(currentSelection?: ModelSelection): any {
    const config = new Config({});

    for (const [providerId, entry] of this.configuredProviders) {
      if (entry.base_url && entry.model) {
        config.upsertModelRaw(`${providerId}:${entry.model}`, {
          provider: providerId,
          model: entry.model,
          api_key: entry.api_key ?? "local",
          base_url: entry.base_url,
          context_length: entry.context_length,
          supports_web_search: false,
        });
        continue;
      }
      const preset = PROVIDER_PRESETS.find((c) => c.id === providerId);
      if (!preset || preset.localServer) continue;
      const placeholderKey =
        providerId === "openai-codex"
          ? "oauth:openai-codex"
          : providerId === "copilot"
            ? "oauth:copilot"
            : "wizard-configured";
      for (const model of preset.models) {
        config.upsertModelRaw(
          `${providerId}:${model.key}`,
          buildProviderPresetRawConfig(providerId, model, placeholderKey),
        );
      }
    }

    let currentModelConfig: Record<string, unknown> | undefined;
    if (currentSelection) {
      try {
        currentModelConfig = config.getModel(currentSelection.configName) as unknown as Record<string, unknown>;
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
