/**
 * Agent 模板加载器。
 *
 * 提供用于 agent 模板的 `loadTemplate` / `loadTemplates`。
 *
 * 模板文件夹布局：
 *
 *   prompts/templates/
 *   +-- main/
 *   |   +-- agent.yaml          # 必需
 *   |   +-- system_prompt.md    # 由 system_prompt_file 引用
 *   |   +-- tools.md            # 由 tools_prompt_file 引用
 *   |   +-- knowledge/          # 可选 — 追加到系统提示的文件
 *   |       +-- style_guide.md
 *
 * 提示组装（每个模板）：
 *
 *   agent.prompt = roleBody + toolPromptContent + knowledge
 *
 *   1. roleBody      — system_prompt_file（必需）
 *   2. toolPrompt    — tools_prompt_file（首选）或 层级默认（回退）
 *   3. knowledge     — knowledge/ 下的所有文件（可选）
 *
 * 会话级层（AGENTS.md 内存、agent 模型固定、未来钩子）
 * 由 `src/prompt-assembler.ts` 在 agent.prompt 之上单独添加。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as yaml from "js-yaml";

import { Agent } from "../agents/agent.js";
import type { Config } from "../config/config.js";
import type { ToolDef } from "../providers/base.js";
import { BASIC_TOOLS, BASIC_TOOLS_MAP } from "../tools/basic.js";
import type { MCPClientManager } from "../clients/mcp-client.js";

// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------

const AGENT_YAML = "agent.yaml";
const REQUIRED_TEMPLATE_TYPE = "agent";
const MIN_TEMPLATE_MAX_TOOL_ROUNDS = 100;

/**
 * 工具包 — 相关工具的命名组。
 * 用于 agent.yaml 的 `tools` 字段：`tools: [read, shell, util]`
 * 工具包名称和单独工具名称可以自由混合。
 */
export const TOOL_PACKS: Record<string, string[]> = {
  read: ["read_file", "list_dir", "glob", "grep"],
  edit: ["write_file", "edit_file"],
  shell: ["bash", "bash_background", "bash_output", "kill_shell"],
  util: ["time", "web_search", "web_fetch"],
};

// ------------------------------------------------------------------
// 工具层级（swarmflow 风格）
// ------------------------------------------------------------------

export type ToolTier = "read_only" | "reversible" | "all";

/** 将 tool_tier 映射到该层级暴露的工具名称。 */
export const TOOL_TIER_TOOLS: Record<ToolTier, string[]> = {
  read_only: [...TOOL_PACKS.read, ...TOOL_PACKS.util],
  reversible: [...TOOL_PACKS.read, ...TOOL_PACKS.edit, ...TOOL_PACKS.shell, ...TOOL_PACKS.util],
  all: "all" as unknown as string[], // sentinel — handled specially
};

/**
 * 从 agent spec 中解析 tool_tier。无效值抛出异常。
 * 如果未指定则返回 null（调用方应回退到 `tools` 列表）。
 */
export function resolveToolTier(spec: Record<string, unknown>): ToolTier | null {
  const raw = spec["tool_tier"];
  if (raw === undefined) return null;
  if (raw === "read_only" || raw === "reversible" || raw === "all") return raw;
  throw new Error(
    `无效的 tool_tier '${String(raw)}'。必须是以下之一：${Object.keys(TOOL_TIER_TOOLS).join(", ")}`,
  );
}

/** 解析层级默认工具提示。如果没有捆绑提示则返回 null。 */
function resolveTierDefaultPrompt(_spec: Record<string, unknown>): string | null {
  // 层级默认提示是未来扩展点。
  // 当前所有捆绑模板都声明了 tools_prompt_file，所以这
  // 只在省略了它的自定义模板上触发。返回 null 以跳过。
  return null;
}

/**
 * 用于动态系统提示重新组合的配方。
 * 存储在 Agent 上，以便 Session 在重新加载时可以重建缓存的提示。
 */
export interface PromptRecipe {
  templateDir: string;
  spec: Record<string, unknown>;
  promptsDirs: string[];
}

// ------------------------------------------------------------------
// 公共 API
// ------------------------------------------------------------------

/**
 * 从 `templateDir` 加载单个 agent 模板。
 *
 * @param templateDir  模板文件夹路径（必须包含 `agent.yaml`）。
 * @param config       全局 Config 实例（提供模型解析）。
 * @param nameOverride 如果提供，替换 YAML 中的 `name` 字段。
 * @param mcpManager   可选的 MCP 客户端管理器，用于 MCP 工具解析。
 * @param promptsDirs  有序的 `prompts/` 目录列表（用户覆盖优先，捆绑次之）。
 *                     如果省略或为空，则不组装工具/章节提示。
 * @returns            完全构造好的 Agent，可直接使用。
 */
/**
 * 从模板配方组装系统提示。
 *
 * 这是核心组装管道，被提取出来以便 Session 在模板、AGENTS.md、
 * 技能或配置重新加载时可以重建缓存的提示。
 */
/** 连接前的各个提示层级。 */
export interface PromptLayers {
  /** system_prompt.md 中的角色主体（核心行为指令）。 */
  roleBody: string;
  /** tools.md 中的工具文档（每个工具的详细使用文档）。 */
  toolDocs: string;
  /** 知识文件（可选，连接在一起）。 */
  knowledge: string;
}

/**
 * 返回 assembleSystemPrompt 将连接的各个提示层级。
 * 由使用面板用于估算每部分的 token 成本。
 */
export function getPromptLayers(recipe: PromptRecipe): PromptLayers {
  const { templateDir, spec } = recipe;
  const roleBody = resolveSystemPrompt(spec, templateDir);

  let toolDocs = "";
  const toolsPromptFile = spec["tools_prompt_file"] as string | undefined;
  if (toolsPromptFile) {
    const toolsPath = join(templateDir, toolsPromptFile);
    if (existsSync(toolsPath)) {
      toolDocs = readFileSync(toolsPath, "utf-8").trimEnd();
    }
  } else {
    toolDocs = resolveTierDefaultPrompt(spec) ?? "";
  }

  let knowledge = "";
  const knowledgeDir = join(templateDir, "knowledge");
  if (existsSync(knowledgeDir) && statSync(knowledgeDir).isDirectory()) {
    const parts: string[] = [];
    const entries = readdirSync(knowledgeDir).sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(knowledgeDir, entry);
      try {
        if (!statSync(fullPath).isFile()) continue;
      } catch { continue; }
      parts.push(readFileSync(fullPath, "utf-8"));
    }
    knowledge = parts.join("\n\n");
  }

  return { roleBody, toolDocs, knowledge };
}

export function assembleSystemPrompt(recipe: PromptRecipe): string {
  const { templateDir, spec } = recipe;

  // --- 1. 角色主体（核心系统提示） ---
  let systemPrompt = resolveSystemPrompt(spec, templateDir);

  // --- 2. 工具提示（自定义文件 > 层级默认） ---
  const toolsPromptFile = spec["tools_prompt_file"] as string | undefined;
  if (toolsPromptFile) {
    const toolsPath = join(templateDir, toolsPromptFile);
    if (existsSync(toolsPath)) {
      const toolsContent = readFileSync(toolsPath, "utf-8").trimEnd();
      if (toolsContent) {
        systemPrompt = systemPrompt.trimEnd() + "\n\n" + toolsContent;
      }
    }
  } else {
    const tierPrompt = resolveTierDefaultPrompt(spec);
    if (tierPrompt) {
      systemPrompt = systemPrompt.trimEnd() + "\n\n" + tierPrompt;
    }
  }

  // --- 3. 知识文件（可选目录） ---
  const knowledgeDir = join(templateDir, "knowledge");
  if (existsSync(knowledgeDir) && statSync(knowledgeDir).isDirectory()) {
    const knowledgeParts: string[] = [];
    const entries = readdirSync(knowledgeDir).sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(knowledgeDir, entry);
      try {
        if (!statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }
      knowledgeParts.push(readFileSync(fullPath, "utf-8"));
    }
    if (knowledgeParts.length > 0) {
      systemPrompt =
        systemPrompt.trimEnd() + "\n\n" + knowledgeParts.join("\n\n");
    }
  }

  return systemPrompt;
}

export function loadTemplate(
  templateDir: string,
  config: Config,
  nameOverride?: string,
  mcpManager?: MCPClientManager,
  promptsDirs?: string[],
  fallbackModel?: string,
): Agent {
  const yamlPath = join(templateDir, AGENT_YAML);
  if (!existsSync(yamlPath)) {
    throw new Error(`找不到模板配置：${yamlPath}`);
  }

  const raw = readFileSync(yamlPath, "utf-8");
  const spec = (yaml.load(raw) as Record<string, unknown>) ?? {};
  const typeError = validateTemplateType(spec);
  if (typeError) {
    throw new Error(typeError);
  }

  const name =
    nameOverride ??
    (spec["name"] as string | undefined) ??
    basename(templateDir);
  const model = (spec["model"] as string | undefined) ?? fallbackModel;

  const resolvedPromptsDirs = promptsDirs && promptsDirs.length > 0
    ? promptsDirs
    : [];

  const recipe: PromptRecipe = { templateDir, spec, promptsDirs: resolvedPromptsDirs };
  const systemPrompt = assembleSystemPrompt(recipe);

  const agent = buildAgent(
    spec,
    name,
    model,
    systemPrompt,
    config,
    mcpManager,
  );

  // 存储配方以便动态重新组装
  agent.promptRecipe = recipe;

  return agent;
}

/**
 * 扫描模板目录并加载所有模板，支持分层覆盖。
 *
 * 三层模板加载，支持分层覆盖：
 *
 * 1. **捆绑** — 始终从包中加载。
 * 2. **用户全局**（`~/.swarmflow/prompts/templates/`）— 仅添加新模板；
 *    不能覆盖捆绑模板（其提示组装假设特定格式）。
 * 3. **项目本地**（`{project}/.swarmflow/prompts/templates/`）— 最高优先级；
 *    可以覆盖捆绑模板和用户全局模板。
 *
 * @param bundledRoot  捆绑模板根目录（始终可从包中获取）。
 * @param config       全局 Config 实例。
 * @param mcpManager   可选的 MCP 客户端管理器。
 * @param promptsDirs  有序的 prompts 目录（用户优先，捆绑次之）。
 * @param userRoot     可选的用户覆盖模板根目录（~/.swarmflow/prompts/templates/）。
 * @param projectRoot  可选的項目本地模板根目录（{project}/.swarmflow/prompts/templates/）。
 * @returns `{ name: agent }` 记录。
 */
export function loadTemplates(
  bundledRoot: string,
  config: Config,
  mcpManager?: MCPClientManager,
  promptsDirs?: string[],
  userRoot?: string,
  projectRoot?: string,
  fallbackModel?: string,
): Record<string, Agent> {
  if (!existsSync(bundledRoot) || !statSync(bundledRoot).isDirectory()) {
    throw new Error(`捆绑模板根目录不存在：${bundledRoot}`);
  }

  // 第一遍：捆绑模板（基础层）
  const templateDirs: Record<string, string> = {};
  const bundledNames = new Set<string>();
  for (const child of readdirSync(bundledRoot).sort()) {
    const childPath = join(bundledRoot, child);
    if (isTemplateDir(childPath)) {
      templateDirs[child] = childPath;
      bundledNames.add(child);
    }
  }

  // 第二遍：用户全局补充（不能覆盖捆绑模板）
  if (userRoot && existsSync(userRoot) && statSync(userRoot).isDirectory()) {
    for (const child of readdirSync(userRoot).sort()) {
      if (bundledNames.has(child)) continue; // 永远不覆盖捆绑模板
      if (child.startsWith("_")) continue; // _ 前缀的目录是示例，不加载
      const childPath = join(userRoot, child);
      if (isTemplateDir(childPath)) {
        templateDirs[child] = childPath;
      }
    }
  }

  // 第三遍：项目本地模板（可以覆盖捆绑模板和用户全局模板）
  if (projectRoot && existsSync(projectRoot) && statSync(projectRoot).isDirectory()) {
    for (const child of readdirSync(projectRoot).sort()) {
      if (child.startsWith("_")) continue;
      const childPath = join(projectRoot, child);
      if (isTemplateDir(childPath)) {
        templateDirs[child] = childPath;
      }
    }
  }

  const resolvedPromptsDirs = promptsDirs && promptsDirs.length > 0
    ? promptsDirs
    : [resolvePromptsDir(bundledRoot)].filter((d): d is string => !!d);

  const agents: Record<string, Agent> = {};
  for (const name of Object.keys(templateDirs).sort()) {
    const agent = loadTemplate(
      templateDirs[name],
      config,
      undefined,
      mcpManager,
      resolvedPromptsDirs,
      fallbackModel,
    );
    agents[agent.name] = agent;
  }

  return agents;
}

function isTemplateDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, AGENT_YAML));
  } catch {
    return false;
  }
}

/**
 * 验证模板目录而不加载它。
 * 如果有效则返回 null，如果无效则返回错误消息字符串。
 */
export function validateTemplate(templateDir: string): string | null {
  const yamlPath = join(templateDir, AGENT_YAML);
  if (!existsSync(yamlPath)) {
    return `${templateDir} 中缺少 agent.yaml`;
  }

  let spec: Record<string, unknown>;
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    spec = (yaml.load(raw) as Record<string, unknown>) ?? {};
  } catch (e) {
    return `agent.yaml 中的 YAML 无效：${e}`;
  }

  const typeError = validateTemplateType(spec);
  if (typeError) {
    return typeError;
  }

  if (!spec["system_prompt"] && !spec["system_prompt_file"]) {
    return "agent.yaml 必须包含 'system_prompt' 或 'system_prompt_file'";
  }

  if (typeof spec["system_prompt_file"] === "string") {
    const promptPath = join(templateDir, spec["system_prompt_file"]);
    if (!existsSync(promptPath)) {
      return `system_prompt_file 未找到：${spec["system_prompt_file"]}`;
    }
  }

  if (typeof spec["tools_prompt_file"] === "string") {
    const toolsPromptPath = join(templateDir, spec["tools_prompt_file"]);
    if (!existsSync(toolsPromptPath)) {
      return `tools_prompt_file 未找到：${spec["tools_prompt_file"]}`;
    }
  }

  const tierSpec = spec["tool_tier"];
  if (tierSpec !== undefined) {
    if (typeof tierSpec !== "string" || !(tierSpec in TOOL_TIER_TOOLS)) {
      const valid = Object.keys(TOOL_TIER_TOOLS).join(", ");
      return `无效的 tool_tier '${String(tierSpec)}'。必须是以下之一：${valid}`;
    }
  }

  const toolsSpec = spec["tools"];
  if (toolsSpec != null && toolsSpec !== "all" && !Array.isArray(toolsSpec)) {
    return `无效的 tools 规格：必须是 "all"、工具/包名称列表或省略`;
  }
  if (Array.isArray(toolsSpec)) {
    for (const entry of toolsSpec) {
      if (typeof entry !== "string") {
        return `无效的 tools 条目：期望字符串，得到 ${typeof entry}`;
      }
      if (!TOOL_PACKS[entry] && !BASIC_TOOLS_MAP[entry]) {
        return `未知的工具或包 '${entry}'。可用工具：${Object.keys(BASIC_TOOLS_MAP).join(", ")}；包：${Object.keys(TOOL_PACKS).join(", ")}`;
      }
    }
  }

  if (tierSpec === undefined && toolsSpec == null) {
    return `agent.yaml 必须指定 'tool_tier'（首选）或 'tools'`;
  }

  const maxRoundsError = validateTemplateMaxToolRounds(spec);
  if (maxRoundsError) {
    return maxRoundsError;
  }

  return null;
}

// ------------------------------------------------------------------
// 提示组装
// ------------------------------------------------------------------

/**
 * 将 prompts/ 目录解析为模板根目录的兄弟目录。
 * 如果找到则返回路径，否则返回 undefined。
 */
export function resolvePromptsDir(templatesRoot: string): string | undefined {
  const candidate = join(dirname(templatesRoot), "prompts");
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return candidate;
  }
  return undefined;
}

/**
 * 从 agent.yaml 的 `tools` 字段解析工具名称。
 *
 * - `"all"` → TOOL_PROMPT_ORDER 中的所有工具
 * - 名称/工具包数组 → 展开工具包，去重
 * - 缺失/null → EXECUTOR_DEFAULT_TOOLS（用于自定义模板）
 *
 * 工具包名称和单独工具名称可以自由混合：
 *   tools: [read, bash, time]   → read_file, list_dir, glob, grep, bash, time
 */
/**
 * 将工具规格数组（工具包名称和/或单独工具名称）
 * 展开为去重后的单独工具名称列表。
 */
function expandToolSpecs(specs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const spec of specs) {
    const packTools = TOOL_PACKS[spec];
    if (packTools) {
      for (const tool of packTools) {
        if (!seen.has(tool)) {
          seen.add(tool);
          result.push(tool);
        }
      }
    } else {
      if (!seen.has(spec)) {
        seen.add(spec);
        result.push(spec);
      }
    }
  }
  return result;
}

// ------------------------------------------------------------------
// 内部辅助函数
// ------------------------------------------------------------------

/**
 * 从内联文本或外部文件返回系统提示字符串。
 */
function resolveSystemPrompt(
  spec: Record<string, unknown>,
  templateDir: string,
): string {
  if (typeof spec["system_prompt"] === "string") {
    return spec["system_prompt"];
  }
  if (typeof spec["system_prompt_file"] === "string") {
    const promptPath = join(templateDir, spec["system_prompt_file"]);
    if (!existsSync(promptPath)) {
      throw new Error(`system_prompt_file 未找到：${promptPath}`);
    }
    return readFileSync(promptPath, "utf-8");
  }
  return "";
}

function validateTemplateType(spec: Record<string, unknown>): string | null {
  const type = spec["type"];
  if (typeof type !== "string" || !type.trim()) {
    return `agent.yaml 必须设置 type: ${REQUIRED_TEMPLATE_TYPE}`;
  }
  if (type !== REQUIRED_TEMPLATE_TYPE) {
    return `无效的模板类型 '${type}'：期望 '${REQUIRED_TEMPLATE_TYPE}'`;
  }
  return null;
}

function validateTemplateMaxToolRounds(spec: Record<string, unknown>): string | null {
  const raw = spec["max_tool_rounds"];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return `agent.yaml 必须设置整数 max_tool_rounds >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS}`;
  }
  if (raw < MIN_TEMPLATE_MAX_TOOL_ROUNDS) {
    return `max_tool_rounds 必须 >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS}（得到 ${raw}）`;
  }
  return null;
}

/**
 * 解析 `tools` 字段为 ToolDef 对象列表。
 *
 * - `"all"` => 所有内置工具
 * - 包/工具名称列表 => 展开包，从 BASIC_TOOLS_MAP 解析每个
 * - 缺失 / null => 空列表（自定义模板通过 resolveToolNames 获取默认值）
 */
function resolveTools(spec: Record<string, unknown>): ToolDef[] {
  // 主要方式：tool_tier（swarmflow 风格）。无效值抛出异常。
  const tier = resolveToolTier(spec);
  if (tier !== null) {
    if (tier === "all") return [...BASIC_TOOLS];
    const resolved: ToolDef[] = [];
    for (const name of TOOL_TIER_TOOLS[tier]) {
      const tool = BASIC_TOOLS_MAP[name];
      if (tool) resolved.push(tool);
    }
    return resolved;
  }

  // 回退：显式工具列表（自定义模板的向后兼容）
  const toolsSpec = spec["tools"];
  if (toolsSpec == null) return [];

  if (toolsSpec === "all") {
    return [...BASIC_TOOLS];
  }

  if (Array.isArray(toolsSpec)) {
    const toolNames = expandToolSpecs(toolsSpec as string[]);
    const resolved: ToolDef[] = [];
    for (const name of toolNames) {
      const tool = BASIC_TOOLS_MAP[name];
      if (!tool) {
        throw new Error(
          `未知工具 '${name}'。可用：${Object.keys(BASIC_TOOLS_MAP).join(", ")}，包：${Object.keys(TOOL_PACKS).join(", ")}`,
        );
      }
      resolved.push(tool);
    }
    return resolved;
  }

  throw new Error(`无效的 tools 规格：${JSON.stringify(toolsSpec)}`);
}

/**
 * 解析 `mcp_tools` 字段为 MCP ToolDef 对象。
 */
function resolveMcpTools(
  spec: Record<string, unknown>,
  mcpManager?: MCPClientManager,
): ToolDef[] {
  if (!mcpManager) return [];

  const mcpSpec = spec["mcp_tools"];
  if (!mcpSpec || mcpSpec === "none") return [];

  if (mcpSpec === "all") {
    return mcpManager.getAllTools();
  }

  if (Array.isArray(mcpSpec)) {
    const tools: ToolDef[] = [];
    for (const serverName of mcpSpec) {
      const serverTools = mcpManager.getToolsForServer(serverName as string);
      if (serverTools.length === 0) {
        console.warn(
          `MCP 服务器 '${serverName}' 没有工具或未连接`,
        );
      }
      tools.push(...serverTools);
    }
    return tools;
  }

  return [];
}

/**
 * 从解析的 YAML spec 构建完全配置的 Agent。
 */
function buildAgent(
  spec: Record<string, unknown>,
  name: string,
  model: string | undefined,
  systemPrompt: string,
  config: Config,
  mcpManager?: MCPClientManager,
): Agent {
  const typeError = validateTemplateType(spec);
  if (typeError) {
    throw new Error(typeError);
  }
  const maxRoundsError = validateTemplateMaxToolRounds(spec);
  if (maxRoundsError) {
    throw new Error(maxRoundsError);
  }

  const resolvedModel = model ?? config.defaultModel;
  if (!resolvedModel) {
    throw new Error(
      `模板 '${name}' 未指定模型，且配置中没有默认模型。`,
    );
  }

  const tools = [...resolveTools(spec), ...resolveMcpTools(spec, mcpManager)];

  const opts: {
    name: string;
    role: string;
    model: string;
    config: Config;
    tools: ToolDef[];
    maxToolRounds?: number;
    description?: string;
  } = {
    name,
    role: systemPrompt,
    model: resolvedModel,
    config,
    tools,
  };

  opts.maxToolRounds = spec["max_tool_rounds"] as number;
  if (typeof spec["description"] === "string") {
    opts.description = spec["description"];
  }

  const agent = new Agent(opts);

  // 保留 MCP 选择意图，供 Session._ensureMcp() 在运行时延迟连接使用。
  (agent as any)._mcpToolsSpec = spec["mcp_tools"] ?? undefined;

  return agent;
}