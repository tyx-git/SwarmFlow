/**
 * Config——解析环境变量、合并用户配置，产出运行时 ModelConfig 与 MCP 服务器配置。
 */

import { join } from "node:path";
import { normalizeEndpointUrl } from "../commands/provider/endpoint.js";
import { readOAuthAccessToken, hasOAuthTokens } from "../auth/openai/token-store.js";
import { loadGitHubTokens, hasGitHubTokens } from "../auth/github-copilot-oauth.js";
import { getProviderDefaultBaseUrl } from "../providers/defaults.js";
import { findProviderPreset } from "../providers/presets.js";
import {
  MANAGED_PROVIDER_CREDENTIAL_SPECS,
  isManagedProvider,
} from "./managed-provider-credentials.js";
import type { LocalModelEntry, LocalProviderConfig } from "./settings/types.js";
import {
  resolveSealedSchema,
  resolveThinkingEncryption,
  resolveTransportProtocol,
} from "../thinking/artifact.js";
import type { ModelConfig, ModelConfigEntry, MCPServerConfig } from "./types.js";
import {
  getContextLength,
  getMultimodalSupport,
  getWebSearchSupport,
  runtimeTransportProtocol,
} from "./model-capabilities.js";


/** 解析 ${ENV_VAR} 格式的环境变量引用，返回变量名或 null */
function parseEnvRef(value: string): string | null {
  if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
    return value.slice(2, -1);
  }
  return null;
}

/** 检查 API 密钥值是否可以成功解析（OAuth 令牌存在或环境变量已设置） */
function hasResolvableApiKey(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  // OAuth 令牌检查
  if (value === "oauth:openai-codex") return hasOAuthTokens();
  if (value === "oauth:copilot") return hasGitHubTokens();
  if (value.startsWith("${") && value.endsWith("}")) {
    const envName = value.slice(2, -1);
    const resolved = process.env[envName];
    return typeof resolved === "string" && resolved.trim() !== "";
  }
  return true;
}

/** 要求配置中必须存在指定的字符串字段，缺失或为空则抛出错误 */
function requireConfigStringField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): string {
  const raw = cfg[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `Invalid model config '${modelConfigName}': missing required string field '${field}'`,
    );
  }
  return raw;
}

/** 读取可选的字符串字段，未定义返回 undefined，类型错误则抛出异常 */
function optionalConfigStringField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): string | undefined {
  const raw = cfg[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(
      `Invalid model config '${modelConfigName}': field '${field}' must be a string`,
    );
  }
  return raw;
}

/** 读取可选的数值字段，未定义返回 undefined，类型错误则抛出异常 */
function optionalConfigNumberField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): number | undefined {
  const raw = cfg[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new Error(
      `Invalid model config '${modelConfigName}': field '${field}' must be a number`,
    );
  }
  return raw;
}

/** 读取可选的布尔字段，未定义返回 undefined，类型错误则抛出异常 */
function optionalConfigBooleanField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const raw = cfg[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new Error(
      `Invalid model config '${modelConfigName}': field '${field}' must be a boolean`,
    );
  }
  return raw;
}

/** 读取可选的枚举字段，值必须在 allowed 列表中，否则抛出异常 */
function optionalConfigEnumField<T extends string>(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const raw = cfg[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    throw new Error(
      `Invalid model config '${modelConfigName}': field '${field}' must be one of ${allowed.join(", ")}`,
    );
  }
  return raw as T;
}

// ------------------------------------------------------------------
// 配置路径解析
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Config 类——核心配置管理
// ------------------------------------------------------------------

export class Config {
  private _rawModels: Record<string, Record<string, unknown>> = {};
  private _models: Map<string, ModelConfig> = new Map();
  private _mcpServers: MCPServerConfig[];
  private _subAgentInheritMcp: boolean;
  private _subAgentInheritHooks: boolean;

  constructor(opts: {
    providerEnvVars?: Record<string, string>;
    /** 用户为云端提供商声明的模型；内置注册表不再提供模型条目。 */
    providerModels?: Record<string, LocalModelEntry[]>;
    localProviders?: Record<string, LocalProviderConfig>;
    mcpServers?: MCPServerConfig[];
    subAgentInheritMcp?: boolean;
    subAgentInheritHooks?: boolean;
  }) {
    this._mcpServers = opts.mcpServers ?? [];
    this._subAgentInheritMcp = opts.subAgentInheritMcp ?? true;
    this._subAgentInheritHooks = opts.subAgentInheritHooks ?? true;
    this._populateFromPreferences(
      opts.providerEnvVars ?? {},
      opts.providerModels ?? {},
      opts.localProviders ?? {},
    );
  }

  get subAgentInheritMcp(): boolean {
    return this._subAgentInheritMcp;
  }

  get subAgentInheritHooks(): boolean {
    return this._subAgentInheritHooks;
  }

  /**
   * 从提供商环境变量映射和本地服务器配置填充原始模型映射。
   * 对于每个已配置的提供商，只注册用户提供的模型。
   * 对于每个本地服务器，注册用户配置的模型条目。
   */
  private _populateFromPreferences(
    providerEnvVars: Record<string, string>,
    providerModels: Record<string, LocalModelEntry[]>,
    localProviders: Record<string, LocalProviderConfig>,
  ): void {
    const preferenceApiKey = (providerId: string, source: string): string => {
      if (
        providerId === "openai-codex"
        && (source === "_OPENAI_CODEX_OAUTH" || source === "oauth:openai-codex")
      ) {
        return "oauth:openai-codex";
      }
      if (
        providerId === "copilot"
        && (source === "_COPILOT_OAUTH" || source === "oauth:copilot")
      ) {
        return "oauth:copilot";
      }
      if (source.startsWith("${") && source.endsWith("}")) {
        return source;
      }
      return `\${${source}}`;
    };

    const registerModels = (providerId: string, apiKeyRaw: string, models: LocalModelEntry[]): void => {
      for (const model of models) {
        const name = `${providerId}:${model.id}`;
        this._rawModels[name] = {
          provider: providerId,
          model: model.id,
          api_key: apiKeyRaw,
          context_length: model.contextLength,
          ...(model.maxOutputTokens !== undefined ? { max_tokens: model.maxOutputTokens } : {}),
          ...(model.multimodal !== undefined ? { supports_multimodal: model.multimodal } : {}),
          ...(model.webSearch !== undefined ? { supports_web_search: model.webSearch } : {}),
        };
      }
    };

    // 云端/标准提供商。模型条目来自 settings.json，不从 provider 元数据生成。
    const configuredProviderIds = new Set([
      ...Object.keys(providerEnvVars),
      ...Object.keys(providerModels),
    ]);
    for (const providerId of configuredProviderIds) {
      const preset = findProviderPreset(providerId);
      if (preset?.localServer || isManagedProvider(providerId)) continue;
      const envVar = providerEnvVars[providerId];
      let apiKeyRaw = envVar ? preferenceApiKey(providerId, envVar) : undefined;
      if (!apiKeyRaw && preset && typeof process.env[preset.envVar] === "string" && process.env[preset.envVar]!.trim()) {
        apiKeyRaw = preferenceApiKey(providerId, preset.envVar);
      }
      if (!apiKeyRaw && providerId === "openai-codex") {
        apiKeyRaw = "oauth:openai-codex";
      }
      if (!apiKeyRaw && providerId === "copilot") {
        apiKeyRaw = "oauth:copilot";
      }
      if (apiKeyRaw) registerModels(providerId, apiKeyRaw, providerModels[providerId] ?? []);
    }

    // 托管云提供商：直接从固定的 swarmflow 环境变量槽解析。
    for (const spec of MANAGED_PROVIDER_CREDENTIAL_SPECS) {
      const raw = process.env[spec.internalEnvVar];
      if (typeof raw !== "string" || raw.trim() === "") continue;
      const preset = findProviderPreset(spec.providerId);
      if (preset?.localServer) continue;

      registerModels(
        spec.providerId,
        preferenceApiKey(spec.providerId, spec.internalEnvVar),
        providerModels[spec.providerId] ?? [],
      );
    }

    // 自定义/本地提供商：一个端点，一个或多个模型。
    for (const [providerId, local] of Object.entries(localProviders)) {
      for (const m of local.models) {
        const name = `${providerId}:${m.id}`;
        this._rawModels[name] = {
          provider: providerId,
          model: m.id,
          api_key: local.apiKey ?? "local",
          base_url: local.baseUrl,
          context_length: m.contextLength,
          transport_protocol: runtimeTransportProtocol(local.protocol) ?? "chat",
          custom: local.custom,
          supports_multimodal: m.multimodal ?? false,
          supports_web_search: m.webSearch ?? false,
          ...(m.maxOutputTokens ? { max_tokens: m.maxOutputTokens } : {}),
        };
      }
    }
  }

  /** 从原始配置构建完整的 ModelConfig 对象，解析 API 密钥、能力标志等 */
  private _buildModel(name: string, cfg: Record<string, unknown>): ModelConfig {
    const provider = requireConfigStringField(name, cfg, "provider");
    const modelName = requireConfigStringField(name, cfg, "model");
    const apiKeyRaw = requireConfigStringField(name, cfg, "api_key");
    const configuredBaseUrl = optionalConfigStringField(name, cfg, "base_url");
    const apiKeyEnv = parseEnvRef(apiKeyRaw);
    const resolvedApiKey = (() => {
      // OAuth 令牌解析
      if (apiKeyRaw === "oauth:openai-codex") {
        const token = readOAuthAccessToken();
        if (!token) {
          throw new Error(
            `Missing OAuth token for model config '${name}' (${provider}/${modelName}): ` +
            "no OpenAI OAuth credentials stored.\n" +
            "Run 'swarmflow oauth' to log in with your ChatGPT account.",
          );
        }
        return token;
      }
      if (apiKeyRaw === "oauth:copilot") {
        // CopilotProvider 在运行时忽略此值（它通过 copilotTokenManager 铸造短期令牌）。
        // 我们只需要一个非空字符串，这样下游 SDK 构造就不会失败。
        // 使用存储的 GitHub OAuth 令牌，与 Codex 分支保持一致。
        const gh = loadGitHubTokens();
        if (!gh) {
          throw new Error(
            `Missing OAuth token for model config '${name}' (${provider}/${modelName}): ` +
            "no GitHub Copilot credentials stored.\n" +
            "Run 'swarmflow oauth' to log in with your GitHub account.",
          );
        }
        return gh.access_token;
      }
      if (!apiKeyEnv) return apiKeyRaw;
      const fromEnv = process.env[apiKeyEnv];
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        return fromEnv;
      }
      throw new Error(
        `Missing API key for model config '${name}' (${provider}/${modelName}): ` +
        `environment variable '${apiKeyEnv}' is not set.\n` +
        "Run 'swarmflow init' to configure API keys, or export that variable and retry.",
      );
    })();

    const knownKeys = new Set([
      "provider", "model", "api_key", "base_url",
      "temperature", "max_tokens", "context_length",
      "supports_multimodal", "thinking_budget",
      "supports_web_search",
      "transport_protocol", "thinking_encryption", "sealed_schema", "custom",
    ]);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!knownKeys.has(k)) extra[k] = v;
    }

    const explicitCtxLen = optionalConfigNumberField(name, cfg, "context_length") ?? 0;
    const temperature = optionalConfigNumberField(name, cfg, "temperature") ?? 0.7;
    const maxTokens = optionalConfigNumberField(name, cfg, "max_tokens") ?? 32_000;
    const thinkingBudget = optionalConfigNumberField(name, cfg, "thinking_budget") ?? 0;
    const supportsMultimodalOverride = optionalConfigBooleanField(name, cfg, "supports_multimodal");
    const supportsWebSearchOverride = optionalConfigBooleanField(name, cfg, "supports_web_search");
    const custom = optionalConfigBooleanField(name, cfg, "custom");
    const transportProtocol = optionalConfigEnumField(
      name,
      cfg,
      "transport_protocol",
      ["responses", "anthropic", "chat", "gemini"] as const,
    ) ?? resolveTransportProtocol(provider, modelName);
    // 端点只在这里归一化：provider 拿到的永远是所选协议需要的 base URL，
    // 不论配置来自 settings、初始化选择器还是运行时注册。
    const baseUrl = configuredBaseUrl
      ? normalizeEndpointUrl(configuredBaseUrl, transportProtocol).baseUrl
      : getProviderDefaultBaseUrl(provider);
    const thinkingEncryption = optionalConfigEnumField(
      name,
      cfg,
      "thinking_encryption",
      ["openai", "anthropic", "none"] as const,
    ) ?? resolveThinkingEncryption(provider, modelName);
    const sealedSchemaOverride = optionalConfigStringField(name, cfg, "sealed_schema");
    const sealedSchema =
      sealedSchemaOverride !== undefined
        ? (sealedSchemaOverride === "" ? null : sealedSchemaOverride)
        : resolveSealedSchema(provider, modelName);

    return {
      name,
      provider,
      model: modelName,
      apiKey: resolvedApiKey,
      baseUrl,
      custom,
      temperature,
      maxTokens,
      contextLength: getContextLength(modelName, explicitCtxLen),
      supportsMultimodal: getMultimodalSupport(
        modelName,
        supportsMultimodalOverride,
      ),
      thinkingBudget,
      supportsWebSearch: getWebSearchSupport(
        modelName,
        supportsWebSearchOverride,
        provider,
      ),
      transportProtocol,
      thinkingEncryption,
      sealedSchema,
      extra,
    };
  }

  /** 获取指定名称的模型配置，带缓存；未找到时抛出错误 */
  getModel(name: string): ModelConfig {
    const cached = this._models.get(name);
    if (cached) return cached;

    const raw = this._rawModels[name];
    if (!raw) {
      const available = Object.keys(this._rawModels).join(", ") || "(none)";
      throw new Error(`Model config '${name}' not found. Available: ${available}`);
    }

    const model = this._buildModel(name, raw);
    this._models.set(name, model);
    return model;
  }

  /** 使指定模型的缓存失效，下次 getModel 时会重新构建 */
  invalidateModel(name: string): void {
    this._models.delete(name);
  }

  /** 使指定提供商的所有模型缓存失效 */
  invalidateModelsByProvider(provider: string): void {
    for (const [name, cfg] of Object.entries(this._rawModels)) {
      if (cfg["provider"] === provider) {
        this._models.delete(name);
      }
    }
  }

  /** 返回所有已注册的模型配置名称列表 */
  get modelNames(): string[] {
    return Object.keys(this._rawModels);
  }

  /**
   * 返回未解析环境变量的原始模型条目。
   * 用于 UI 需要显示缺失的 API 密钥而不是抛出错误的场景。
   */
  listModelEntries(): ModelConfigEntry[] {
    const out: ModelConfigEntry[] = [];
    for (const [name, cfg] of Object.entries(this._rawModels)) {
      const provider = typeof cfg["provider"] === "string" ? cfg["provider"] : "";
      const model = typeof cfg["model"] === "string" ? cfg["model"] : "";
      const apiKeyRaw = typeof cfg["api_key"] === "string" ? cfg["api_key"] : "";
      const entry: ModelConfigEntry = {
        name,
        provider,
        model,
        apiKeyRaw,
        hasResolvedApiKey: hasResolvableApiKey(apiKeyRaw),
      };
      out.push(entry);
    }
    return out;
  }

  /** 查找第一个精确匹配提供商 + 模型 ID 的模型配置名称 */
  findModelConfigName(provider: string, model: string): string | undefined {
    for (const [name, cfg] of Object.entries(this._rawModels)) {
      if (cfg["provider"] === provider && cfg["model"] === model) {
        return name;
      }
    }
    return undefined;
  }

  /**
   * 在运行时插入或替换原始模型配置（仅内存中）。
   */
  upsertModelRaw(name: string, cfg: Record<string, unknown>): void {
    const normalized = { ...cfg };
    const protocol = typeof normalized.transport_protocol === "string"
      ? runtimeTransportProtocol(normalized.transport_protocol)
      : undefined;
    if (protocol) normalized.transport_protocol = protocol;
    this._rawModels[name] = normalized;
    this._models.delete(name);
  }

  /** 从运行时配置中移除模型（自定义提供商管理） */
  removeModel(name: string): void {
    delete this._rawModels[name];
    this._models.delete(name);
  }

  /**
   * 返回最佳默认模型名称。
   * 优先级：第一个具有可解析 API 密钥的 > 第一个模型。
   */
  get defaultModel(): string | undefined {
    for (const [name, cfg] of Object.entries(this._rawModels)) {
      const apiKeyRaw = (cfg["api_key"] as string) ?? "";
      if (typeof apiKeyRaw === "string" && apiKeyRaw.startsWith("${") && apiKeyRaw.endsWith("}")) {
        const envName = apiKeyRaw.slice(2, -1);
        if (process.env[envName]) return name;
      } else if (apiKeyRaw) {
        return name;
      }
    }
    const names = Object.keys(this._rawModels);
    return names.length > 0 ? names[0] : undefined;
  }

  /** 获取所有 MCP 服务器配置 */
  get mcpServerConfigs(): MCPServerConfig[] {
    return this._mcpServers;
  }

}
