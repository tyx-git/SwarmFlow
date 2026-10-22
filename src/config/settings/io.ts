/**
 * settings.json 的加载、合并、命令行覆盖解析与保存。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSwarmflowHomeDir } from "../home-dir.js";
import { parseJsonc } from "../../lib/jsonc.js";
import type { MCPServerConfig } from "../types.js";
import type { LocalModelEntry, LocalProviderConfig, SwarmflowSettings } from "./types.js";

/** 设置文件名 */
const SETTINGS_FILE = "settings.json";

// ------------------------------------------------------------------
// 新设置 API
// ------------------------------------------------------------------

/** 从 ~/.swarmflow/settings.json（JSONC）加载全局设置 */
export function loadGlobalSettings(homeDir?: string): SwarmflowSettings {
  const dir = homeDir ?? getSwarmflowHomeDir();
  const path = join(dir, SETTINGS_FILE);
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf-8");
    return parseJsonc<SwarmflowSettings>(text) ?? {};
  } catch {
    return {};
  }
}

/**
 * 加载项目本地设置。
 *
 * 两层（project-store < workspace，冲突时 workspace 胜出）：
 *   1. ~/.swarmflow/projects/<slug>/.swarmflow/settings.json  （系统管理）
 *   2. {projectPath}/.swarmflow/settings.json             （用户编写）
 *
 * 省略 projectStoreDir 时，仅加载 workspace 层
 * （与尚无 slug 的调用者向后兼容）。
 */
export function loadLocalSettings(projectPath: string, projectStoreDir?: string): SwarmflowSettings {
  let base: SwarmflowSettings = {};

  if (projectStoreDir) {
    const storePath = join(projectStoreDir, ".swarmflow", SETTINGS_FILE);
    if (existsSync(storePath)) {
      try {
        base = parseJsonc<SwarmflowSettings>(readFileSync(storePath, "utf-8")) ?? {};
      } catch { /* ignore */ }
    }
  }

  const workspacePath = join(projectPath, ".swarmflow", SETTINGS_FILE);
  if (!existsSync(workspacePath)) return base;
  try {
    const workspace = parseJsonc<SwarmflowSettings>(readFileSync(workspacePath, "utf-8")) ?? {};
    return Object.keys(base).length > 0 ? mergeSettings(base, workspace) : workspace;
  } catch {
    return base;
  }
}

/**
 * 合并全局和本地设置。
 *
 * 规则：
 * - 标量：本地覆盖全局
 * - 对象（mcp_servers）：按键合并（本地键覆盖）
 * - 数组（disabled_skills）：本地替换全局
 * - `providers`：仅全局——本地值被忽略
 */
export function mergeSettings(global: SwarmflowSettings, local: SwarmflowSettings): SwarmflowSettings {
  const merged: SwarmflowSettings = { ...global };

  // 标量——如果存在则本地覆盖
  if (local.default_model !== undefined) merged.default_model = local.default_model;
  if (local.currentProvider !== undefined) merged.currentProvider = local.currentProvider;
  if (local.thinking_level !== undefined) merged.thinking_level = local.thinking_level;
  if (local.thinking_levels !== undefined) merged.thinking_levels = local.thinking_levels;
  if (local.context_budget_percent !== undefined) merged.context_budget_percent = local.context_budget_percent;
  if (local.accent_color !== undefined) merged.accent_color = local.accent_color;
  if (local.theme_mode !== undefined) merged.theme_mode = local.theme_mode;
  if (local.ui_language !== undefined) merged.ui_language = local.ui_language;
  if (local.permission_mode !== undefined) merged.permission_mode = local.permission_mode;
  if (local.sub_agent_inherit_mcp !== undefined) merged.sub_agent_inherit_mcp = local.sub_agent_inherit_mcp;
  if (local.sub_agent_inherit_hooks !== undefined) merged.sub_agent_inherit_hooks = local.sub_agent_inherit_hooks;
  if (local.fork_inherit_prompt_cache_key !== undefined) {
    merged.fork_inherit_prompt_cache_key = local.fork_inherit_prompt_cache_key;
  }

  // 数组——本地替换
  if (local.disabled_skills !== undefined) merged.disabled_skills = local.disabled_skills;

  // 对象——按键合并
  if (local.mcp_servers) {
    merged.mcp_servers = { ...merged.mcp_servers, ...local.mcp_servers };
  }

  // providers：仅全局——不合并 local.providers
  return merged;
}

/**
 * 解析进程本地的 `-c key=value` 覆盖项。这些有意限制为上下文预算，
 * 永远不会被持久化。
 */
export function parseSettingsOverrides(overrides: readonly string[] = []): SwarmflowSettings {
  const settings: SwarmflowSettings = {};

  for (const override of overrides) {
    const eq = override.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid -c override '${override}'. Expected key=value.`);
    }

    const key = override.slice(0, eq).trim();
    const rawValue = override.slice(eq + 1).trim();

    switch (key) {
      case "context_budget_percent": {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) {
          throw new Error("context_budget_percent override must be a number.");
        }
        settings.context_budget_percent = value;
        break;
      }
      default:
        throw new Error(`Unsupported -c override '${key}'.`);
    }
  }

  return settings;
}

/**
 * 保存 settings.json（全局或本地）。原子写入。
 * 仅写入已定义的字段——undefined 字段会被省略。
 */
export function saveSettings(settings: SwarmflowSettings, filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  // 构建不含 undefined 值的干净对象
  const clean: Record<string, unknown> = {};
  if (settings.default_model !== undefined) clean.default_model = settings.default_model;
  if (settings.currentProvider !== undefined) clean.currentProvider = settings.currentProvider;
  if (settings.thinking_level !== undefined) clean.thinking_level = settings.thinking_level;
  if (settings.thinking_levels !== undefined) clean.thinking_levels = settings.thinking_levels;
  if (settings.context_budget_percent !== undefined) clean.context_budget_percent = settings.context_budget_percent;
  if (settings.providers !== undefined) clean.providers = settings.providers;
  if (settings.accent_color !== undefined) clean.accent_color = settings.accent_color;
  if (settings.theme_mode !== undefined) clean.theme_mode = settings.theme_mode;
  if (settings.ui_language !== undefined) clean.ui_language = settings.ui_language;
  if (settings.diff_display !== undefined) clean.diff_display = settings.diff_display;
  if (settings.permission_mode !== undefined) clean.permission_mode = settings.permission_mode;
  if (settings.disabled_skills !== undefined) clean.disabled_skills = settings.disabled_skills;
  if (settings.mcp_servers !== undefined) clean.mcp_servers = settings.mcp_servers;
  if (settings.sub_agent_inherit_mcp !== undefined) clean.sub_agent_inherit_mcp = settings.sub_agent_inherit_mcp;
  if (settings.sub_agent_inherit_hooks !== undefined) clean.sub_agent_inherit_hooks = settings.sub_agent_inherit_hooks;
  if (settings.fork_inherit_prompt_cache_key !== undefined) {
    clean.fork_inherit_prompt_cache_key = settings.fork_inherit_prompt_cache_key;
  }
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, filePath);
}

/** 将部分更新合并到全局 settings.json 文件 */
export function saveGlobalSettingsPatch(patch: Partial<SwarmflowSettings>, homeDir?: string): void {
  const existing = loadGlobalSettings(homeDir);
  saveSettings({ ...existing, ...patch }, globalSettingsPath(homeDir));
}

/** 保存当前供应商及其最近使用的模型/思考深度。 */
export function persistCurrentModelSelection(
  selection: {
    provider: string;
    model: string;
    configName?: string;
    thinkingDepth?: string;
  },
  homeDir?: string,
): void {
  const provider = selection.provider.trim();
  const model = selection.model.trim();
  if (!provider || !model) return;

  const settings = loadGlobalSettings(homeDir);
  const existingProvider = settings.providers?.[provider] ?? {};
  saveGlobalSettingsPatch({
    currentProvider: provider,
    providers: {
      ...(settings.providers ?? {}),
      [provider]: {
        ...existingProvider,
        currentModel: {
          model,
          ...(selection.configName ? { configName: selection.configName } : {}),
          ...(selection.thinkingDepth ? { thinkingDepth: selection.thinkingDepth } : {}),
        },
      },
    },
  }, homeDir);
}

/** 获取全局 settings.json 路径 */
export function globalSettingsPath(homeDir?: string): string {
  return join(homeDir ?? getSwarmflowHomeDir(), SETTINGS_FILE);
}

/** 获取项目本地 settings.json 路径 */
export function localSettingsPath(projectPath: string): string {
  return join(projectPath, ".swarmflow", SETTINGS_FILE);
}

/**
 * 将 SwarmflowSettings 的 providers + mcp_servers 转换为
 * Config 和 MCPClientManager 期望的格式。
 */
export function settingsToConfigInputs(settings: SwarmflowSettings): {
  providerEnvVars: Record<string, string>;
  /** 云端提供商的用户模型目录；模型不会从程序内置注册表注入。 */
  providerModels: Record<string, LocalModelEntry[]>;
  localProviders: Record<string, LocalProviderConfig>;
  mcpServers: MCPServerConfig[];
} {
  const providerEnvVars: Record<string, string> = {};
  const providerModels: Record<string, LocalModelEntry[]> = {};
  const localProviders: Record<string, LocalProviderConfig> = {};

  if (settings.providers) {
    for (const [id, entry] of Object.entries(settings.providers)) {
      if (entry.api_key_env || (!entry.base_url && (entry.models?.length || entry.currentModel?.model))) {
        // 无 base_url 的条目属于内置 provider；凭据可来自 API key、托管槽或 OAuth 登录。
        if (entry.api_key_env) providerEnvVars[id] = entry.api_key_env;
        if (entry.models?.length || entry.currentModel?.model) {
          const models: LocalModelEntry[] = (entry.models ?? []).map((m) => ({
            id: m.id,
            contextLength: m.context_length ?? 128_000,
            maxOutputTokens: m.max_output_tokens,
            multimodal: m.multimodal,
            webSearch: m.web_search,
          }));
          if (entry.currentModel?.model && !models.some((m) => m.id === entry.currentModel?.model)) {
            models.push({ id: entry.currentModel.model, contextLength: 128_000 });
          }
          providerModels[id] = models;
        }
      } else if (entry.base_url && (entry.models?.length || entry.model || entry.currentModel?.model)) {
        // 自定义/本地提供商：优先使用 models[]；回退到旧版单模型。
        const models: LocalModelEntry[] = entry.models?.length
          ? entry.models.map((m) => ({
              id: m.id,
              contextLength: m.context_length ?? 128_000,
              maxOutputTokens: m.max_output_tokens,
              multimodal: m.multimodal,
              webSearch: m.web_search,
            }))
            : [{
                id: entry.model ?? entry.currentModel!.model,
                contextLength: entry.context_length ?? 128_000,
              }];
        if (entry.currentModel?.model && !models.some((m) => m.id === entry.currentModel?.model)) {
          models.push({ id: entry.currentModel.model, contextLength: 128_000 });
        }
        localProviders[id] = {
          baseUrl: entry.base_url,
          custom: entry.custom,
          protocol: entry.protocol ?? "openai-chat",
          apiKey: entry.api_key,
          label: entry.label,
          models,
        };
      }
    }
  }

  const mcpServers: MCPServerConfig[] = [];
  if (settings.mcp_servers) {
    for (const [name, cfg] of Object.entries(settings.mcp_servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      if (cfg.disabled) continue;
      const env: Record<string, string> = {};
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          // 解析 ${ENV_VAR} 引用
          if (typeof v === "string" && v.startsWith("${") && v.endsWith("}")) {
            const envName = v.slice(2, -1);
            const resolved = process.env[envName];
            if (resolved !== undefined) env[k] = resolved;
          } else {
            env[k] = v;
          }
        }
      }
      mcpServers.push({
        name,
        transport: cfg.transport ?? "stdio",
        command: cfg.command ?? "",
        args: cfg.args ?? [],
        url: cfg.url ?? "",
        env,
        envAllowlist: cfg.env_allowlist,
        sensitiveTools: cfg.sensitive_tools,
      });
    }
  }

  return { providerEnvVars, providerModels, localProviders, mcpServers };
}
