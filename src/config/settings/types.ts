/**
 * settings.json 的数据形状。
 */

import type { MCPServerConfig } from "../types.js";
import type { ThemeMode } from "../theme.js";
import type { UiLanguage } from "../../ui/text.js";

/** 自定义/本地提供商下的单个模型（解析后的运行时形状） */
export interface LocalModelEntry {
  /** 模型 ID */
  id: string;
  /** 上下文长度（token 数） */
  contextLength: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
  /** 是否支持多模态输入 */
  multimodal?: boolean;
  /** 是否支持网络搜索 */
  webSearch?: boolean;
}

/**
 * 自定义/本地提供商：一个端点，一个或多个模型。
 * 涵盖用户定义的自定义提供商和旧版单模型本地服务器
 * （后者解析为单元素 `models`）。
 */
export interface LocalProviderConfig {
  /** API 基础 URL */
  baseUrl: string;
  /** 是否来自 settings.json 中标记为 custom 的用户定义提供商 */
  custom?: boolean;
  /** 传输协议。默认 "openai-chat" */
  protocol?: "openai-chat" | "anthropic" | "openai-responses" | "gemini" | "anthropic-messages" | "openai-chat-completions" | "gemini-generate-content";
  /** 需要认证的端点的 API 密钥。省略时默认为 "local" */
  apiKey?: string;
  /** 选择器中显示的名称 */
  label?: string;
  /** 模型列表 */
  models: LocalModelEntry[];
}

// ------------------------------------------------------------------
// 新设置类型（替代 GlobalTuiPreferences）
// ------------------------------------------------------------------

/** 用户可编辑的设置。存储在 settings.json（JSONC）中 */
export interface SwarmflowSettings {
  // -- 模型 --
  /** 声明式默认模型；仅在 currentProvider.currentModel 不可用时使用。 */
  default_model?: string;
  /** 上次退出时使用的供应商。 */
  currentProvider?: string;
  /** 主代理的默认思维链级别 */
  thinking_level?: string;
  /** /model 最后一步显示的思考深度选项；不配置时使用内置默认列表 */
  thinking_levels?: string[];
  /** 主会话上下文预算百分比（1-100） */
  context_budget_percent?: number;

  // -- 提供商（仅全局，不被本地设置覆盖）--
  /** 云提供商 → 环境变量名，或本地提供商 → 完整配置 */
  providers?: Record<string, ProviderEntry>;

  // -- 显示 --
  /** 强调色 */
  accent_color?: string;
  /** 主题模式：brief（默认）| "dark" | "light"。"auto" 视为未设置，归一化为 brief。 */
  theme_mode?: ThemeMode;
  /** 界面语言：zh（默认）| en。安装向导中选择，供 UI 文案表使用。 */
  ui_language?: UiLanguage;
  /** 内联写入/编辑差异显示模式。默认："compact" */
  diff_display?: "compact" | "full";

  // -- 权限 --
  /** 默认权限模式："read_only" | "reversible" | "yolo" */
  permission_mode?: string;

  // -- 子代理继承 --
  /** 子代理继承父代理的 MCP 服务器/工具。默认：true */
  sub_agent_inherit_mcp?: boolean;
  /** 子代理继承父代理的钩子。默认：true */
  sub_agent_inherit_hooks?: boolean;
  /**
   * fork 时默认继承父会话的 prompt cache 亲和键。
   *
   * - false（默认）：路由隔离，适合长期并行开发；
   * - true：适合轻量级探索/短期实验，分支可复用父前缀缓存。
   *
   * session.fork 的显式 inheritPromptCacheKey 参数优先于本设置。
   */
  fork_inherit_prompt_cache_key?: boolean;

  // -- 技能 --
  /** 禁用的技能列表 */
  disabled_skills?: string[];

  // -- MCP 服务器（全局 + 本地合并）--
  mcp_servers?: Record<string, MCPServerSettingsEntry>;

  // -- 诊断 --
  /**
   * 详细诊断日志。默认：false。
   * - true：把 OpenTUI 的 JSONL 诊断写到 ~/.swarmflow/opentui-diag.jsonl
   *   （上次运行自动归档为 .1 ~ .5）
   * - false：不写
   * 环境变量 OPENTUI_DIAG=1 优先级更高，可临时覆盖。
   */
  diagnostics?: boolean;

}

/**
 * settings.json 中的提供商条目。
 * 云提供商使用 `api_key_env` 加用户提供的 `models` 列表；
 * 本地/自定义提供商使用 `base_url` 加 `model` 或 `models`。
 */
export interface ProviderEntry {
  /** 持有 API 密钥的环境变量名（云提供商） */
  api_key_env?: string;
  /** 基础 URL（本地提供商/自定义端点） */
  base_url?: string;
  /** 模型标识符（旧版单模型本地提供商） */
  model?: string;
  /** 上下文窗口大小（旧版单模型本地提供商） */
  context_length?: number;
  /** 需要认证的本地服务器/自定义端点的可选 API 密钥 */
  api_key?: string;
  /** 标记为用户定义的自定义提供商（任意名称 + 端点） */
  custom?: boolean;
  /** 选择器中显示的名称（自定义提供商） */
  label?: string;
  /** 自定义端点的传输协议。默认 "openai-chat" */
  protocol?: "openai-chat" | "anthropic" | "openai-responses" | "gemini" | "anthropic-messages" | "openai-chat-completions" | "gemini-generate-content";
  /** 一个自定义提供商下的多个模型（优先于单个 `model`） */
  models?: CustomModelEntry[];
  /** 用户上次在该供应商下使用的模型和思考深度。 */
  currentModel?: {
    model: string;
    thinkingDepth?: string;
    configName?: string;
  };
}

/** 自定义提供商下的单个模型（settings.json 形状） */
export interface CustomModelEntry {
  /** 发送到端点的 API 模型 ID */
  id: string;
  /** 上下文窗口。必填——UI 不保存没有它的条目 */
  context_length: number;
  /** 最大输出 token 数（用作请求 max_tokens 上限） */
  max_output_tokens?: number;
  /** 图像/多模态输入。默认 false */
  multimodal?: boolean;
  /** 原生网络搜索。默认 false */
  web_search?: boolean;
}

/** settings.json 中的 MCP 服务器条目。与旧版 mcp.json 值形状相同 */
export interface MCPServerSettingsEntry {
  /** 传输类型 */
  transport?: "stdio" | "sse";
  /** 启动命令 */
  command?: string;
  /** 命令行参数 */
  args?: string[];
  /** SSE URL */
  url?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 环境变量白名单 */
  env_allowlist?: string[];
  /** 敏感工具列表 */
  sensitive_tools?: string[];
  /** 是否禁用 */
  disabled?: boolean;
}
