/**
 * 模型选择解析和验证逻辑。
 *
 * 处理从配置名称或 provider:model 目标解析模型选择，
 * 以及思考级别的验证。
 */

import { hasOAuthTokens } from "../auth/openai-oauth.js";
import { hasGitHubTokens } from "../auth/github-copilot-oauth.js";
import {
  findProviderPreset,
} from "../providers/presets.js";
import { isManagedProvider } from "../config/managed-provider-credentials.js";
import { describeModel } from "../models/presentation.js";
import { runtimeTransportProtocol } from "../config/config.js";

/** 模型条目接口 */
export type ModelEntryLike = {
  name: string;
  provider: string;
  model: string;
  apiKeyRaw: string;
  hasResolvedApiKey: boolean;
};

/** 持久化的模型选择 */
export interface PersistedModelSelection {
  modelConfigName?: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
}

/** 解析后的模型选择 */
export interface ResolvedModelSelection {
  selectedConfigName: string;
  selectedHint: string;
  modelProvider: string;
  modelSelectionKey: string;
  modelId: string;
}

/**
 * 从配置中读取模型条目列表。
 */
export function readModelEntries(config: any): ModelEntryLike[] {
  if (typeof config?.listModelEntries === "function") {
    try {
      const entries = config.listModelEntries();
      if (Array.isArray(entries)) return entries as ModelEntryLike[];
    } catch {
      // 回退到兼容模式
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
      // 忽略无效条目
    }
  }
  return out;
}

/**
 * 检查环境变量中是否有 API 密钥。
 */
export function hasEnvApiKey(envVar: string | undefined): boolean {
  if (!envVar) return false;
  const raw = process.env[envVar];
  return typeof raw === "string" && raw.trim() !== "";
}

/**
 * 获取提供者密钥来源。
 */
function getProviderKeySource(
  entries: ModelEntryLike[],
  provider: string,
): string | undefined {
  // 本地服务器：使用现有配置条目中存储的密钥，或默认 "local"
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

  // 现有配置条目中的精确提供者匹配
  const fromConfig = entries.find((entry) =>
    entry.provider === provider
      && entry.hasResolvedApiKey
      && entry.apiKeyRaw.trim() !== "",
  );
  if (fromConfig) return fromConfig.apiKeyRaw;

  // 提供者特定环境变量 — 无跨站回退
  const preset = findProviderPreset(provider);
  if (preset && hasEnvApiKey(preset.envVar)) return `\${${preset.envVar}}`;

  if (provider === "openai-codex") {
    try {
      if (hasOAuthTokens()) return "oauth:openai-codex";
    } catch {
      // 忽略此处的 auth 查找失败
    }
  }

  if (provider === "copilot") {
    try {
      if (hasGitHubTokens()) return "oauth:copilot";
    } catch {
      // 忽略此处的 auth 查找失败
    }
  }

  return undefined;
}

/**
 * 解析 provider:model 格式的目标字符串。
 */
export function parseProviderModelTarget(target: string): { provider: string; model: string } | null {
  const idx = target.indexOf(":");
  if (idx <= 0 || idx >= target.length - 1) return null;
  return {
    provider: target.slice(0, idx),
    model: target.slice(idx + 1),
  };
}

/**
 * 生成运行时模型名称。
 */
export function runtimeModelName(provider: string, model: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `runtime-${slug(provider)}-${slug(model)}`;
}

/**
 * 解析模型选择。
 * 支持配置名称或 provider:model 格式。
 */
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

  const resolvedModel = parsed.model;
  const selectionKey = parsed.model;

  const entries = readModelEntries(config);
  const exactEntries = entries.filter((entry) =>
    entry.provider === parsed.provider && entry.model === resolvedModel,
  );
  const exactWithKey = exactEntries.find((entry) => entry.hasResolvedApiKey);

  if (exactWithKey) {
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
    const rawConfig: Record<string, unknown> = {
      provider: parsed.provider,
      model: resolvedModel,
      api_key: keySource,
      // 没有本地模型目录可供推断时使用保守默认值；用户可在 settings.json 覆盖。
      context_length: 128_000,
    };
    if (rawConfig.transport_protocol !== undefined) {
      rawConfig.transport_protocol = runtimeTransportProtocol(String(rawConfig.transport_protocol))
        ?? runtimeTransportProtocol(parsed.provider)
        ?? "chat";
    }
    config.upsertModelRaw(runtimeName, rawConfig);
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

/**
 * 解析持久化的模型选择。
 */
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
