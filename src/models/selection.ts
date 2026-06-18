import { hasOAuthTokens } from "./auth/openai-oauth.js";
import { hasGitHubTokens } from "./auth/github-copilot-oauth.js";
import {
  PROVIDER_PRESETS,
  buildProviderPresetRawConfig,
  findProviderPreset,
  findProviderPresetModel,
} from "./providers/presets.js";
import { isManagedProvider } from "./config/managed-provider-credentials.js";
import { describeModel } from "./models/presentation.js";
import { getThinkingLevels, getTierEligibleThinkingLevels } from "./config/config.js";
import type { AgentModelEntry, ModelTierEntry } from "./config/persistence.js";

export type ModelEntryLike = {
  name: string;
  provider: string;
  model: string;
  apiKeyRaw: string;
  hasResolvedApiKey: boolean;
};

export interface PersistedModelSelection {
  modelConfigName?: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
}

export interface ResolvedModelSelection {
  selectedConfigName: string;
  selectedHint: string;
  modelProvider: string;
  modelSelectionKey: string;
  modelId: string;
}

export interface ResolvedRuntimeModel extends ResolvedModelSelection {
  modelConfig: any;
  thinkingLevel?: string;
}

export interface StableModelIdentity {
  provider: string;
  selectionKey: string;
  modelId: string;
}

export function readModelEntries(config: any): ModelEntryLike[] {
  if (typeof config?.listModelEntries === "function") {
    try {
      const entries = config.listModelEntries();
      if (Array.isArray(entries)) return entries as ModelEntryLike[];
    } catch {
      // Fall through to compatibility mode.
    }
  }

  const out: ModelEntryLike[] = [];
  for (const name of (config?.modelNames as string[]) ?? []) {
    try {
      const mc = config.getModel(name);
      out.push({
        name,
        provider: String(mc.provider ?? ""),
        model: String(mc.model ?? ""),
        apiKeyRaw: String(mc.apiKey ?? ""),
        hasResolvedApiKey: Boolean(mc.apiKey),
      });
    } catch {
      // Ignore invalid entries.
    }
  }
  return out;
}

export function hasEnvApiKey(envVar: string | undefined): boolean {
  if (!envVar) return false;
  const raw = process.env[envVar];
  return typeof raw === "string" && raw.trim() !== "";
}

function getProviderKeySource(
  entries: ModelEntryLike[],
  provider: string,
): string | undefined {
  // Local servers: use stored key from existing config entry, or default "local".
  const presetForKey = findProviderPreset(provider);
  if (presetForKey?.localServer) {
    const localEntry = entries.find((e) =>
      e.provider === provider && e.hasResolvedApiKey && e.apiKeyRaw.trim() !== "",
    );
    return localEntry?.apiKeyRaw ?? "local";
  }

  if (isManagedProvider(provider)) {
    const fromConfig = entries.find((entry) =>
      entry.provider === provider
        && entry.hasResolvedApiKey
        && entry.apiKeyRaw.trim() !== "",
    );
    if (fromConfig) return fromConfig.apiKeyRaw;

    const preset = findProviderPreset(provider);
    if (preset && hasEnvApiKey(preset.envVar)) return `\${${preset.envVar}}`;
    return undefined;
  }

  // Exact provider match in existing config entries.
  const fromConfig = entries.find((entry) =>
    entry.provider === provider
      && entry.hasResolvedApiKey
      && entry.apiKeyRaw.trim() !== "",
  );
  if (fromConfig) return fromConfig.apiKeyRaw;

  // Provider-specific env var 鈥?no cross-site fallback.
  const preset = findProviderPreset(provider);
  if (preset && hasEnvApiKey(preset.envVar)) return `\${${preset.envVar}}`;

  if (provider === "openai-codex") {
    try {
      if (hasOAuthTokens()) return "oauth:openai-codex";
    } catch {
      // Ignore auth lookup failures here.
    }
  }

  if (provider === "copilot") {
    try {
      if (hasGitHubTokens()) return "oauth:copilot";
    } catch {
      // Ignore auth lookup failures here.
    }
  }

  return undefined;
}

export function parseProviderModelTarget(target: string): { provider: string; model: string } | null {
  const idx = target.indexOf(":");
  if (idx <= 0 || idx >= target.length - 1) return null;
  return {
    provider: target.slice(0, idx),
    model: target.slice(idx + 1),
  };
}

export function runtimeModelName(provider: string, model: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `runtime-${slug(provider)}-${slug(model)}`;
}

export function toStableModelIdentity(
  selection: Pick<ResolvedModelSelection, "modelProvider" | "modelSelectionKey" | "modelId">,
): StableModelIdentity {
  return {
    provider: selection.modelProvider,
    selectionKey: selection.modelSelectionKey,
    modelId: selection.modelId,
  };
}

export function createModelTierEntry(
  identity: StableModelIdentity,
  thinkingLevel: string,
): ModelTierEntry {
  validateThinkingLevelForModel(identity.modelId, thinkingLevel, "Tier entry");
  return {
    provider: identity.provider,
    selection_key: identity.selectionKey,
    model_id: identity.modelId,
    thinking_level: thinkingLevel,
  };
}

export function resolveConfigNameForModelIdentity(
  config: any,
  identity: StableModelIdentity,
): string | undefined {
  const stableConfigName = `${identity.provider}:${identity.selectionKey}`;
  const knownNames = new Set<string>((config?.modelNames as string[]) ?? []);
  if (knownNames.has(stableConfigName)) {
    return stableConfigName;
  }

  if (typeof config?.findModelConfigName === "function") {
    return config.findModelConfigName(identity.provider, identity.modelId)
      ?? config.findModelConfigName(identity.provider, identity.selectionKey);
  }

  return undefined;
}

export function resolveModelIdentity(
  session: any,
  identity: StableModelIdentity,
): ResolvedModelSelection {
  const config = session.config;
  const existingConfigName = resolveConfigNameForModelIdentity(config, identity);
  if (existingConfigName) {
    const existing = config.getModel(existingConfigName);
    const descriptor = describeModel({
      configName: existingConfigName,
      providerId: identity.provider,
      selectionKey: identity.selectionKey,
      modelId: existing.model || identity.modelId,
    });
    return {
      selectedConfigName: existingConfigName,
      selectedHint: descriptor.scopedDetailedLabel,
      modelProvider: identity.provider,
      modelSelectionKey: identity.selectionKey,
      modelId: existing.model || identity.modelId,
    };
  }

  return resolveModelSelection(session, `${identity.provider}:${identity.selectionKey || identity.modelId}`);
}

/**
 * Validate that `thinking_level` is a valid sub-agent tier value for the model.
 *
 * Rules:
 *   - Non-thinking model (no native levels): must be exactly "none" (sentinel).
 *   - Thinking-capable model: must be one of `getTierEligibleThinkingLevels(model)`,
 *     i.e. the native list with "off" / "none" filtered out. Tiers always have
 *     thinking enabled 鈥?main-agent thinking-off is a separate, main-only choice.
 *
 * Source label is included in the error so callers know which entry point
 * produced the bad value. Used by createModelTierEntry (save path) and
 * resolveModelTierEntry / resolveAgentModelEntry (resolve path). Direct
 * settings.json edits are caught at resolve time.
 */
export function validateThinkingLevelForModel(modelId: string, thinkingLevel: string, source: string): void {
  if (!thinkingLevel) {
    throw new Error(`${source}: missing thinking_level. Re-configure the entry.`);
  }
  const native = getThinkingLevels(modelId);
  if (native.length === 0) {
    if (thinkingLevel !== "none") {
      throw new Error(
        `${source}: model '${modelId}' does not support thinking, but thinking_level is '${thinkingLevel}'.`,
      );
    }
    return;
  }
  const eligible = getTierEligibleThinkingLevels(modelId);
  if (!eligible.includes(thinkingLevel)) {
    throw new Error(
      `${source}: thinking_level '${thinkingLevel}' is not a valid sub-agent thinking level for model '${modelId}'. ` +
      `Valid: ${eligible.join(", ")}.`,
    );
  }
}

export function resolveModelTierEntry(
  session: any,
  entry: ModelTierEntry,
): ResolvedRuntimeModel {
  const resolved = resolveModelIdentity(session, {
    provider: entry.provider,
    selectionKey: entry.selection_key || entry.model_id,
    modelId: entry.model_id,
  });
  const modelConfig = session.config.getModel(resolved.selectedConfigName);
  validateThinkingLevelForModel(
    modelConfig.model || entry.model_id,
    entry.thinking_level,
    `Model tier`,
  );
  return {
    ...resolved,
    modelConfig,
    thinkingLevel: entry.thinking_level,
  };
}

export function resolveAgentModelEntry(
  session: any,
  entry: AgentModelEntry,
): ResolvedRuntimeModel {
  const resolved = resolveModelIdentity(session, {
    provider: entry.provider,
    selectionKey: entry.selection_key || entry.model_id,
    modelId: entry.model_id,
  });
  const modelConfig = session.config.getModel(resolved.selectedConfigName);
  validateThinkingLevelForModel(
    modelConfig.model || entry.model_id,
    entry.thinking_level,
    `Agent model pin`,
  );
  return {
    ...resolved,
    modelConfig,
    thinkingLevel: entry.thinking_level,
  };
}

export function resolveModelSelection(
  session: any,
  target: string,
): ResolvedModelSelection {
  const config = session.config;
  let selectedConfigName = target;

  const knownNames = new Set<string>((config?.modelNames as string[]) ?? []);
  if (knownNames.has(selectedConfigName)) {
    const existing = config.getModel(selectedConfigName);
    const descriptor = describeModel({
      configName: selectedConfigName,
      providerId: existing.provider,
      selectionKey: existing.model,
      modelId: existing.model,
    });
    return {
      selectedConfigName,
      selectedHint: descriptor.scopedDetailedLabel,
      modelProvider: existing.provider,
      modelSelectionKey: existing.model,
      modelId: existing.model,
    };
  }

  const parsed = parseProviderModelTarget(target);
  if (!parsed) {
    throw new Error(
      "Invalid model target. Use config name or provider:model (e.g. openai:gpt-5.4).",
    );
  }

  const presetModel = findProviderPresetModel(parsed.provider, parsed.model);
  const resolvedModel = presetModel?.id ?? parsed.model;
  const selectionKey = presetModel?.key ?? parsed.model;
  const presetRequiresDedicatedConfig = Boolean(
    presetModel && (
      presetModel.key !== presetModel.id
      || presetModel.optionNote
      || presetModel.config
      || (presetModel.aliases && presetModel.aliases.length > 0)
    ),
  );

  const entries = readModelEntries(config);
  const exactEntries = entries.filter((entry) =>
    entry.provider === parsed.provider && entry.model === resolvedModel,
  );
  const exactWithKey = exactEntries.find((entry) => entry.hasResolvedApiKey);

  if (exactWithKey && !presetRequiresDedicatedConfig) {
    selectedConfigName = exactWithKey.name;
  } else {
    const keySource = getProviderKeySource(entries, parsed.provider)
      ?? (session.primaryAgent?.modelConfig?.provider === parsed.provider
        && session.primaryAgent?.modelConfig?.apiKey
        ? session.primaryAgent.modelConfig.apiKey
        : undefined);

    if (!keySource) {
      if (parsed.provider === "openai-codex") {
        throw new Error(
          "Not logged in to OpenAI (ChatGPT).\n" +
          "Run 'swarmflow oauth' to log in with your ChatGPT account.",
        );
      }
      if (parsed.provider === "copilot") {
        throw new Error(
          "Not logged in to GitHub Copilot.\n" +
          "Run 'swarmflow oauth' to log in with your GitHub account.",
        );
      }
      const preset = findProviderPreset(parsed.provider);
      const envHint = preset
        ? `\nSet the environment variable:\n\n  export ${preset.envVar}=YOUR_API_KEY\n`
        : "";
      throw new Error(
        `Missing API key for provider '${parsed.provider}'${preset ? ` (${preset.name})` : ""}.` +
        envHint +
        `\nOr run 'swarmflow init' to configure.` +
        `\nTip: select ${parsed.provider}:${parsed.model} in /model to import or paste a key.`,
      );
    }

    if (typeof config?.upsertModelRaw !== "function") {
      throw new Error("Runtime model creation is not supported by this config object.");
    }

    const runtimeName = runtimeModelName(parsed.provider, selectionKey);
    config.upsertModelRaw(
      runtimeName,
      presetModel
        ? buildProviderPresetRawConfig(parsed.provider, presetModel, keySource)
        : {
            provider: parsed.provider,
            model: resolvedModel,
            api_key: keySource,
          },
    );
    selectedConfigName = runtimeName;
  }

  const descriptor = describeModel({
    configName: selectedConfigName,
    providerId: parsed.provider,
    selectionKey,
    modelId: resolvedModel,
  });
  return {
    selectedConfigName,
    selectedHint: descriptor.scopedDetailedLabel,
    modelProvider: parsed.provider,
    modelSelectionKey: selectionKey,
    modelId: resolvedModel,
  };
}

export function resolvePersistedModelSelection(
  session: any,
  selection: PersistedModelSelection,
): ResolvedModelSelection {
  const configName = selection.modelConfigName?.trim();
  let configResolutionError: unknown;

  if (configName) {
    try {
      const existing = session.config.getModel(configName);
      const descriptor = describeModel({
        configName,
        providerId: existing.provider,
        selectionKey: selection.modelSelectionKey?.trim() || existing.model,
        modelId: existing.model,
      });
      return {
        selectedConfigName: configName,
        selectedHint: descriptor.scopedDetailedLabel,
        modelProvider: existing.provider,
        modelSelectionKey: selection.modelSelectionKey?.trim() || existing.model,
        modelId: existing.model,
      };
    } catch (err) {
      configResolutionError = err;
    }
  }

  const provider = selection.modelProvider?.trim();
  const selectionKey = selection.modelSelectionKey?.trim() || selection.modelId?.trim();
  if (provider && selectionKey) {
    return resolveModelSelection(session, `${provider}:${selectionKey}`);
  }

  if (configResolutionError) {
    throw configResolutionError instanceof Error
      ? configResolutionError
      : new Error(String(configResolutionError));
  }

  throw new Error("Saved session is missing persisted model identity.");
}
