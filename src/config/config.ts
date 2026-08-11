/**
 * 配置管理——解析环境变量、从已知查找表自动检测模型能力、根据偏好构建 Config。
 */

import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOAuthAccessToken, hasOAuthTokens } from "../auth/openai-oauth.js";
import { loadGitHubTokens, hasGitHubTokens } from "../auth/github-copilot-oauth.js";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { getProviderDefaultBaseUrl } from "../providers/defaults.js";
import {
  findProviderPreset,
} from "../providers/presets.js";
import {
  MANAGED_PROVIDER_CREDENTIAL_SPECS,
  isManagedProvider,
} from "../config/managed-provider-credentials.js";
import type { AgentModelEntry, LocalProviderConfig, ModelTierEntry } from "../config/persistence.js";
import {
  type SealedSchema,
  type ThinkingEncryption,
  type TransportProtocol,
  resolveSealedSchema,
  resolveThinkingEncryption,
  resolveTransportProtocol,
} from "../lib/thinking-artifact.js";
import { LEGACY_EXTENDED_CACHE_IDS } from "../models/registry.js";
import { EFFECTIVE_MODEL_TABLES } from "../providers/registry-effective.js";

export { SWARMFLOW_HOME_DIR } from "../lib/home-path.js";

// ------------------------------------------------------------------
// 数据接口定义
// ------------------------------------------------------------------

/** 完整的模型配置——包含 API 凭据、能力标志、传输协议等运行时所需全部信息 */
export interface ModelConfig {
  /** 模型配置名称，格式为 "provider:modelKey" */
  name: string;
  /** 服务提供商标识符 */
  provider: string;
  /** 模型 ID（API 请求中的 model 参数） */
  model: string;
  /** API 密钥（可能是明文、环境变量引用 ${ENV}、或 OAuth 标记） */
  apiKey: string;
  /** 自定义 API 基础 URL（可选，为空则使用提供商默认值） */
  baseUrl?: string;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token 数 */
  maxTokens: number;
  /** 上下文窗口长度（token 数） */
  contextLength: number;
  /** 是否支持多模态输入（图像等） */
  supportsMultimodal: boolean;
  /** 是否支持思维链/推理模式 */
  supportsThinking: boolean;
  /** 思维链预算（token 数，0 表示不限制） */
  thinkingBudget: number;
  /** 是否支持原生网络搜索 */
  supportsWebSearch: boolean;
  /** 传输协议（chat / responses / anthropic） */
  transportProtocol: TransportProtocol;
  /** 思维链加密方式 */
  thinkingEncryption: ThinkingEncryption;
  /**
   * 密封思维链负载的线格式标签。具有相同标签的两个提供商可以
   * 在彼此之间往返密封推理；null 表示该提供商不发出或接受密封负载。
   */
  sealedSchema: SealedSchema | null;
  /** 未在已知字段中定义的额外配置项 */
  extra: Record<string, unknown>;
}

/** 模型配置的简化条目——用于 UI 展示，不解析 API 密钥 */
export interface ModelConfigEntry {
  /** 模型配置名称 */
  name: string;
  /** 服务提供商 */
  provider: string;
  /** 模型 ID */
  model: string;
  /** 原始 API 密钥值（可能包含 ${ENV} 引用） */
  apiKeyRaw: string;
  /** 该 API 密钥是否可以成功解析（环境变量已设置或 OAuth 令牌存在） */
  hasResolvedApiKey: boolean;
}

/** MCP 服务器配置——定义如何连接和与 MCP 服务器通信 */
export interface MCPServerConfig {
  /** 服务器名称 */
  name: string;
  /** 传输类型：stdio（标准输入输出）或 sse（Server-Sent Events） */
  transport: "stdio" | "sse";
  /** stdio 模式下的启动命令 */
  command: string;
  /** stdio 模式下的命令行参数 */
  args: string[];
  /** SSE 模式下的服务器 URL */
  url: string;
  /** 传递给子进程的环境变量 */
  env: Record<string, string>;
  /** 允许传递的环境变量白名单（可选） */
  envAllowlist?: string[];
  /** 需要用户确认才执行的敏感工具列表（可选） */
  sensitiveTools?: string[];
}

// ------------------------------------------------------------------
// 已知模型查找表（从 registry-effective 自动派生）
// ------------------------------------------------------------------

/** 有效模型表的别名，从 providers/registry-effective.js 导入 */
const _MODEL_TABLES = EFFECTIVE_MODEL_TABLES;

/** 已知模型的上下文长度映射（模型 ID → token 数） */
export const KNOWN_CONTEXT_LENGTHS: Record<string, number> = _MODEL_TABLES.contextLengths;

/** 已知支持多模态的模型集合 */
export const KNOWN_MULTIMODAL_MODELS: Set<string> = _MODEL_TABLES.multimodal;

/** 已知支持思维链的模型集合 */
export const KNOWN_THINKING_MODELS: Set<string> = _MODEL_TABLES.thinking;

/** 已知不支持网络搜索的模型集合 */
export const KNOWN_NO_WEB_SEARCH_MODELS: Set<string> = _MODEL_TABLES.noWebSearch;

/**
 * 支持 OpenAI 扩展 24 小时提示缓存保留的模型
 * （`prompt_cache_retention: "24h"`）。从标记为 extendedCache 的规格派生，
 * 并与已退役但仍可配置的旧 ID 联合（见 model-registry）。
 */
export const KNOWN_EXTENDED_CACHE_MODELS: Set<string> = new Set([
  ..._MODEL_TABLES.extendedCache,
  ...LEGACY_EXTENDED_CACHE_IDS,
]);

// ------------------------------------------------------------------
// 每个模型的最大输出 token 数
// ------------------------------------------------------------------

/** 已知模型的最大输出 token 数映射 */
export const KNOWN_MAX_OUTPUT_TOKENS: Record<string, number> = _MODEL_TABLES.maxOutputTokens;

/** 解析模型的最大输出 token 数。优先级：已知查找（精确匹配 > 标准化匹配）> undefined */
export function getModelMaxOutputTokens(model: string): number | undefined {
  return KNOWN_MAX_OUTPUT_TOKENS[model]
    ?? KNOWN_MAX_OUTPUT_TOKENS[normalizeModelId(model)];
}

// ------------------------------------------------------------------
// 每个模型的思维链级别
// ------------------------------------------------------------------

/** 已知模型的思维链级别映射（模型 ID → 可用级别列表） */
export const KNOWN_THINKING_LEVELS: Record<string, string[]> = _MODEL_TABLES.thinkingLevels;

/** 返回模型可用的思维链级别列表，非思维链模型返回空数组 */
export function getThinkingLevels(model: string): string[] {
  return KNOWN_THINKING_LEVELS[model]
    ?? KNOWN_THINKING_LEVELS[normalizeModelId(model)]
    ?? [];
}

/**
 * 子代理层级可用的思维链级别：过滤掉 "off" 的原生级别。
 *
 * 子代理层级必须始终启用思维链——"off" 违背了为层级提供
 * 独立配置的目的。主代理流程仍可通过 getThinkingLevels 选择 "off"
 * （用户覆盖在那里的优先级最高）。
 */
export function getTierEligibleThinkingLevels(model: string): string[] {
  return getThinkingLevels(model).filter((l) => l !== "off");
}

/** 返回模型最高（最后一个）思维链级别，非思维链模型返回 undefined */
export function getHighestThinkingLevel(model: string): string | undefined {
  const levels = getThinkingLevels(model);
  return levels.length > 0 ? levels[levels.length - 1] : undefined;
}

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

/**
 * 去除 OpenRouter 风格模型 ID 的供应商前缀。
 * 例如 "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
 * 如果模型 ID 不包含 "/"，则原样返回。
 */
export function normalizeModelId(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/** 格式化简短的用户可见模型标签，用于状态栏等 UI 界面 */
export function formatDisplayModelName(provider: string | undefined, model: string | undefined): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();
  if (!safeModel) return safeProvider;
  if (safeProvider === "openrouter") {
    return `openrouter/${normalizeModelId(safeModel)}`;
  }
  return safeModel;
}

/** 格式化带提供商前缀的用户可见模型标签，用于状态消息 */
export function formatScopedModelName(provider: string | undefined, model: string | undefined): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();
  if (!safeProvider) return formatDisplayModelName(undefined, safeModel);
  if (!safeModel) return safeProvider;
  if (safeProvider === "openrouter") {
    return `openrouter/${normalizeModelId(safeModel)}`;
  }
  return `${safeProvider}/${safeModel}`;
}

/** 解析有效的上下文长度。优先级：显式指定 > 已知查找（精确 > 标准化）> 0 */
export function getContextLength(model: string, contextLength = 0): number {
  if (contextLength > 0) return contextLength;
  return KNOWN_CONTEXT_LENGTHS[model]
    ?? KNOWN_CONTEXT_LENGTHS[normalizeModelId(model)]
    ?? 0;
}

/** 解析多模态支持。优先级：显式指定 > 已知查找（精确 > 标准化）> false */
export function getMultimodalSupport(model: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return KNOWN_MULTIMODAL_MODELS.has(model)
    || KNOWN_MULTIMODAL_MODELS.has(normalizeModelId(model));
}

/** 解析思维链/推理支持。优先级：显式指定 > 已知查找（精确 > 标准化）> false */
export function getThinkingSupport(model: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return KNOWN_THINKING_MODELS.has(model)
    || KNOWN_THINKING_MODELS.has(normalizeModelId(model));
}

/** 检查模型是否支持 OpenAI 的扩展 24 小时提示缓存保留 */
export function getExtendedCacheSupport(model: string): boolean {
  return KNOWN_EXTENDED_CACHE_MODELS.has(model)
    || KNOWN_EXTENDED_CACHE_MODELS.has(normalizeModelId(model));
}

/** 解析原生网络搜索支持。优先级：显式指定 > 提供商默认值 > 黑名单 > true */
export function getWebSearchSupport(model: string, explicit?: boolean, provider?: string): boolean {
  if (explicit !== undefined) return explicit;
  // OpenRouter：网络搜索是付费附加功能，默认为 false。
  // 用户可通过配置中 supports_web_search: true 显式启用。
  if (provider === "openrouter") return false;
  if (KNOWN_NO_WEB_SEARCH_MODELS.has(model)
    || KNOWN_NO_WEB_SEARCH_MODELS.has(normalizeModelId(model))) return false;
  return true;
}

// ------------------------------------------------------------------
// 环境变量解析
// ------------------------------------------------------------------

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

/**
 * 四层扩展发现路径（优先级从高到低）：
 *
 *   workspace  → {cwd}/.swarmflow/         （检入仓库，团队共享）
 *   project    → ~/.swarmflow/projects/<hash>/.swarmflow/  （每项目独立，不在仓库中）
 *   global     → ~/.swarmflow/             （用户级默认值）
 *   bundled    → package assets        （随 swarmflow 一起发布）
 */
/** 解析后的路径配置——包含所有扩展发现根目录 */
export interface ResolvedPaths {
  /** 模板目录路径 */
  templatesPath: string | null;
  /** 提示词目录路径 */
  promptsPath: string | null;
  /** SwarmFlow 主目录（~/.swarmflow） */
  homeDir: string;

  // 四层扩展发现根目录（目录不存在时为 null）
  extensions: {
    /** {cwd}/.swarmflow/ — workspace 层（最高优先级） */
    workspace: string | null;
    /** ~/.swarmflow/projects/<hash>/.swarmflow/ — project 层 */
    project: string | null;
    /** ~/.swarmflow/ — global 层 */
    global: string;
    /** 内置资源目录 — bundled 层（最低优先级） */
    bundled: string | null;
  };

  // 便捷字段：展平的扩展类型路径
  /** 技能根目录列表，按优先级排序：[bundled, global, project, workspace] */
  skillRoots: string[];
  /** 钩子根目录列表，按优先级排序：[global, project, workspace] */
  hookRoots: { dir: string; scope: "global" | "project" | "workspace" }[];
  /** 模板根目录列表：[bundled, global, project, workspace] — 用于 loadTemplates 分层加载 */
  templateRoots: string[];
  /** 项目 .mcp.json 路径（workspace 层） */
  projectMcpConfigPath: string | null;

  // 旧版兼容（cli.ts 模板加载使用）
  projectTemplatesPath: string | null;
  projectSkillsPath: string | null;
}

/**
 * 跨四层发现扩展路径。
 *
 * 层级优先级（从高到低）：
 *   workspace  → {cwd}/.swarmflow/
 *   project    → ~/.swarmflow/projects/<hash>/.swarmflow/
 *   global     → ~/.swarmflow/
 *   bundled    → package assets（通过 getBundledAssetsDir 单独解析）
 */
export function resolveAssetPaths(opts?: {
  templatesFlag?: string;
  projectPath?: string;
  homeDir?: string;
}): ResolvedPaths {
  const home = opts?.homeDir ?? getSwarmflowHomeDir();
  const projectPath = opts?.projectPath ?? process.cwd();

  // 计算项目哈希目录：~/.swarmflow/projects/<name>_<hash>/
  const slug = makeProjectSlug(projectPath);
  const projectStoreDir = join(home, "projects", slug);

  // 四个扩展层根目录
  const workspaceRoot = join(projectPath, ".swarmflow");
  const projectRoot = join(projectStoreDir, ".swarmflow");
  const globalRoot = home;

  const extensions = {
    workspace: isDir(workspaceRoot) ? workspaceRoot : null,
    project: isDir(projectRoot) ? projectRoot : null,
    global: globalRoot,
    bundled: null as string | null, // set by caller from getBundledAssetsDir()
  };

  // --- 模板（旧版：CLI 标志 > global > cwd）---
  let templatesPath: string | null = null;
  if (opts?.templatesFlag) {
    templatesPath = isDir(opts.templatesFlag) ? opts.templatesFlag : null;
  } else {
    const homeTemplates = join(home, "prompts", "templates");
    const cwdTemplates = join(process.cwd(), "prompts", "templates");
    if (isDir(homeTemplates)) {
      templatesPath = homeTemplates;
    } else if (isDir(cwdTemplates)) {
      templatesPath = cwdTemplates;
    }
  }

  // --- 提示词 ---
  let promptsPath: string | null = null;
  if (templatesPath) {
    const siblingPrompts = join(dirname(templatesPath), "prompts");
    if (isDir(siblingPrompts)) promptsPath = siblingPrompts;
  }
  if (!promptsPath) {
    const homePrompts = join(home, "prompts");
    const cwdPrompts = join(process.cwd(), "prompts");
    if (isDir(homePrompts)) promptsPath = homePrompts;
    else if (isDir(cwdPrompts)) promptsPath = cwdPrompts;
  }

  // --- 技能根目录（bundled > global > project > workspace）---
  const skillRoots: string[] = [];
  // bundled 由调用者添加
  const globalSkills = join(globalRoot, "skills");
  if (isDir(globalSkills)) skillRoots.push(globalSkills);
  const projectSkills = join(projectStoreDir, ".swarmflow", "skills");
  if (isDir(projectSkills)) skillRoots.push(projectSkills);
  const workspaceSkills = join(workspaceRoot, "skills");
  if (isDir(workspaceSkills)) skillRoots.push(workspaceSkills);

  // --- 钩子根目录（global > project > workspace）---
  const hookRoots: { dir: string; scope: "global" | "project" | "workspace" }[] = [];
  const globalHooks = join(globalRoot, "hooks");
  if (isDir(globalHooks)) hookRoots.push({ dir: globalHooks, scope: "global" });
  const projectHooks = join(projectStoreDir, ".swarmflow", "hooks");
  if (isDir(projectHooks)) hookRoots.push({ dir: projectHooks, scope: "project" });
  const workspaceHooks = join(workspaceRoot, "hooks");
  if (isDir(workspaceHooks)) hookRoots.push({ dir: workspaceHooks, scope: "workspace" });

  // --- 模板根目录（用于 loadTemplates 分层加载）---
  const templateRoots: string[] = [];
  // bundled 由调用者添加
  if (templatesPath) templateRoots.push(templatesPath);
  const projectTemplates = join(projectStoreDir, ".swarmflow", "prompts", "templates");
  if (isDir(projectTemplates)) templateRoots.push(projectTemplates);
  const workspaceTemplates = join(workspaceRoot, "prompts", "templates");
  if (isDir(workspaceTemplates)) templateRoots.push(workspaceTemplates);

  // --- 项目 MCP 配置 ---
  const mcpPath = join(projectPath, ".mcp.json");
  const projectMcpConfigPath = existsSync(mcpPath) ? mcpPath : null;

  // 旧版兼容字段
  const projectTemplatesPath = isDir(workspaceTemplates) ? workspaceTemplates : null;
  const projectSkillsPath = isDir(workspaceSkills) ? workspaceSkills : null;

  return {
    templatesPath,
    promptsPath,
    homeDir: home,
    extensions,
    skillRoots,
    hookRoots,
    templateRoots,
    projectMcpConfigPath,
    projectTemplatesPath,
    projectSkillsPath,
  };
}

/** 检查路径是否存在且为目录 */
function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 生成项目路径的 slug 格式：<name>_<sha256前6位> */
function makeProjectSlug(projectPath: string): string {
  const name = basename(projectPath) || "root";
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 6);
  return `${name}_${h}`;
}

// ------------------------------------------------------------------
// 内置资源路径
// ------------------------------------------------------------------

/** 返回已安装包的根目录（dist/ 的父目录） */
export function getBundledAssetsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..");
}

// ------------------------------------------------------------------
// Config 类——核心配置管理
// ------------------------------------------------------------------

export class Config {
  private _rawModels: Record<string, Record<string, unknown>> = {};
  private _models: Map<string, ModelConfig> = new Map();
  private _mcpServers: MCPServerConfig[];
  private _modelTiers: { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry } = {};
  private _agentModels: Record<string, AgentModelEntry> = {};
  private _subAgentInheritMcp: boolean;
  private _subAgentInheritHooks: boolean;

  constructor(opts: {
    providerEnvVars?: Record<string, string>;
    localProviders?: Record<string, LocalProviderConfig>;
    mcpServers?: MCPServerConfig[];
    modelTiers?: { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry };
    agentModels?: Record<string, AgentModelEntry>;
    subAgentInheritMcp?: boolean;
    subAgentInheritHooks?: boolean;
  }) {
    this._mcpServers = opts.mcpServers ?? [];
    this._agentModels = opts.agentModels ?? {};
    this._modelTiers = opts.modelTiers ?? {};
    this._subAgentInheritMcp = opts.subAgentInheritMcp ?? true;
    this._subAgentInheritHooks = opts.subAgentInheritHooks ?? true;
    this._populateFromPreferences(
      opts.providerEnvVars ?? {},
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
   * 对于每个已配置的提供商，注册所有预设模型。
   * 对于每个本地服务器，注册一个模型条目。
   */
  private _populateFromPreferences(
    providerEnvVars: Record<string, string>,
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

    // 云端/标准提供商
    for (const [providerId, envVar] of Object.entries(providerEnvVars)) {
      const preset = findProviderPreset(providerId);
      if (!preset || preset.localServer || isManagedProvider(providerId)) continue;

      for (const model of preset.models) {
        const name = `${providerId}:${model.key}`;
        this._rawModels[name] = {
          provider: providerId,
          model: model.id,
          api_key: preferenceApiKey(providerId, envVar),
          ...(model.config ?? {}),
        };
      }
    }

    // 托管云提供商：直接从固定的 swarmflow 环境变量槽解析。
    for (const spec of MANAGED_PROVIDER_CREDENTIAL_SPECS) {
      const raw = process.env[spec.internalEnvVar];
      if (typeof raw !== "string" || raw.trim() === "") continue;
      const preset = findProviderPreset(spec.providerId);
      if (!preset || preset.localServer) continue;

      for (const model of preset.models) {
        const name = `${spec.providerId}:${model.key}`;
        this._rawModels[name] = {
          provider: spec.providerId,
          model: model.id,
          api_key: preferenceApiKey(spec.providerId, spec.internalEnvVar),
          ...(model.config ?? {}),
        };
      }
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
          transport_protocol: local.protocol === "anthropic" || local.protocol === "anthropic-messages"
            ? "anthropic"
            : local.protocol === "openai-responses"
              ? "responses"
              : local.protocol === "gemini" || local.protocol === "gemini-generate-content"
                ? "gemini"
                : "chat",
          supports_multimodal: m.multimodal ?? false,
          supports_web_search: m.webSearch ?? false,
          ...(m.maxOutputTokens ? { max_tokens: m.maxOutputTokens } : {}),
          ...(m.thinkingLevels?.length ? { supports_thinking: true } : {}),
        };
      }
    }
  }

  /** 从原始配置构建完整的 ModelConfig 对象，解析 API 密钥、能力标志等 */
  private _buildModel(name: string, cfg: Record<string, unknown>): ModelConfig {
    const provider = requireConfigStringField(name, cfg, "provider");
    const modelName = requireConfigStringField(name, cfg, "model");
    const apiKeyRaw = requireConfigStringField(name, cfg, "api_key");
    const baseUrl = optionalConfigStringField(name, cfg, "base_url") || getProviderDefaultBaseUrl(provider);
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
      "supports_multimodal", "supports_thinking", "thinking_budget",
      "supports_web_search",
      "transport_protocol", "thinking_encryption", "sealed_schema",
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
    const supportsThinkingOverride = optionalConfigBooleanField(name, cfg, "supports_thinking");
    const supportsWebSearchOverride = optionalConfigBooleanField(name, cfg, "supports_web_search");
    const transportProtocol = optionalConfigEnumField(
      name,
      cfg,
      "transport_protocol",
      ["responses", "anthropic", "chat", "gemini"] as const,
    ) ?? resolveTransportProtocol(provider, modelName);
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
      temperature,
      maxTokens,
      contextLength: getContextLength(modelName, explicitCtxLen),
      supportsMultimodal: getMultimodalSupport(
        modelName,
        supportsMultimodalOverride,
      ),
      supportsThinking: getThinkingSupport(
        modelName,
        supportsThinkingOverride,
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
      out.push({
        name,
        provider,
        model,
        apiKeyRaw,
        hasResolvedApiKey: hasResolvableApiKey(apiKeyRaw),
      });
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
    this._rawModels[name] = { ...cfg };
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

  // -- 模型层级 --

  get modelTiers(): { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry } {
    return this._modelTiers;
  }

  /** 替换运行时层级映射（通过设置单独持久化） */
  setModelTiers(tiers: { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry }): void {
    this._modelTiers = tiers;
  }

  // -- 代理模型固定配置 --

  get agentModels(): Record<string, AgentModelEntry> {
    return this._agentModels;
  }
}
