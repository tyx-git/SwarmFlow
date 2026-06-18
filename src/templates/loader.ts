/**
 * Agent template loader.
 *
 * Provides `loadTemplate` / `loadTemplates` for agent templates.
 *
 * Template folder layout:
 *
 *   prompts/templates/
 *   +-- main/
 *   |   +-- agent.yaml          # required
 *   |   +-- system_prompt.md    # referenced by system_prompt_file
 *   |   +-- tools.md            # referenced by tools_prompt_file
 *   |   +-- knowledge/          # optional -- files appended to system prompt
 *   |       +-- style_guide.md
 *
 * Prompt assembly (per template):
 *
 *   agent.prompt = roleBody + toolPromptContent + knowledge
 *
 *   1. roleBody      鈥?system_prompt_file (required)
 *   2. toolPrompt    鈥?tools_prompt_file (preferred) OR tier-default (fallback)
 *   3. knowledge     鈥?all files under knowledge/ (optional)
 *
 * Session-level layers (AGENTS.md memory, agent model pins, future hooks)
 * are added separately by `src/prompt-assembler.ts` on top of agent.prompt.
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
// Constants
// ------------------------------------------------------------------

const AGENT_YAML = "agent.yaml";
const REQUIRED_TEMPLATE_TYPE = "agent";
const MIN_TEMPLATE_MAX_TOOL_ROUNDS = 100;


/**
 * Tool packs 鈥?named groups of related tools.
 * Used in agent.yaml `tools` field: `tools: [read, shell, util]`
 * Pack names and individual tool names can be freely mixed.
 */
export const TOOL_PACKS: Record<string, string[]> = {
  read:  ["read_file", "list_dir", "glob", "grep"],
  edit:  ["write_file", "edit_file"],
  shell: ["bash", "bash_background", "bash_output", "kill_shell"],
  util:  ["time", "web_search", "web_fetch"],
};


// ------------------------------------------------------------------
// Tool tiers (swarmflow-style)
// ------------------------------------------------------------------

export type ToolTier = "read_only" | "reversible" | "all";

/** Map tool_tier to the tool names that tier exposes. */
export const TOOL_TIER_TOOLS: Record<ToolTier, string[]> = {
  read_only: [...TOOL_PACKS.read, ...TOOL_PACKS.util],
  reversible: [...TOOL_PACKS.read, ...TOOL_PACKS.edit, ...TOOL_PACKS.shell, ...TOOL_PACKS.util],
  all: "all" as unknown as string[], // sentinel 鈥?handled specially
};

/**
 * Resolve tool_tier from an agent spec. Throws on invalid values.
 * Returns null if not specified (caller should fall back to the `tools` list).
 */
export function resolveToolTier(spec: Record<string, unknown>): ToolTier | null {
  const raw = spec["tool_tier"];
  if (raw === undefined) return null;
  if (raw === "read_only" || raw === "reversible" || raw === "all") return raw;
  throw new Error(
    `Invalid tool_tier '${String(raw)}'. Must be one of: ${Object.keys(TOOL_TIER_TOOLS).join(", ")}`,
  );
}

/** Resolve a tier-default tool prompt. Returns null if no bundled prompt exists. */
function resolveTierDefaultPrompt(_spec: Record<string, unknown>): string | null {
  // Tier default prompts are a future extension point.
  // Currently all bundled templates declare tools_prompt_file, so this
  // only fires for custom templates that omit it. Return null to skip.
  return null;
}

/**
 * Recipe for dynamic system prompt reassembly.
 * Stored on Agent so Session can rebuild the cached prompt on reload.
 */
export interface PromptRecipe {
  templateDir: string;
  spec: Record<string, unknown>;
  promptsDirs: string[];
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load a single agent template from `templateDir`.
 *
 * @param templateDir  Path to the template folder (must contain `agent.yaml`).
 * @param config       Global Config instance (provides model resolution).
 * @param nameOverride If given, replaces the `name` field from the YAML.
 * @param mcpManager   Optional MCP client manager for MCP tool resolution.
 * @param promptsDirs  Ordered list of `prompts/` directories (user override first, bundled second).
 *                     If omitted or empty, no tool/section prompts are assembled.
 * @returns            Fully constructed Agent, ready to use.
 */
/**
 * Assemble a system prompt from a template recipe.
 *
 * This is the core assembly pipeline, extracted so Session can rebuild the
 * cached prompt when templates, AGENTS.md, skills, or config are reloaded.
 */
/** Individual prompt layers, before concatenation. */
export interface PromptLayers {
  /** Role body from system_prompt.md (core behavioral instructions). */
  roleBody: string;
  /** Tool documentation from tools.md (detailed usage docs per tool). */
  toolDocs: string;
  /** Knowledge files (optional, concatenated). */
  knowledge: string;
}

/**
 * Return the individual prompt layers that assembleSystemPrompt would concatenate.
 * Used by the usage panel to estimate per-section token costs.
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

  // --- 1. Role body (core system prompt) ---
  let systemPrompt = resolveSystemPrompt(spec, templateDir);

  // --- 2. Tool prompt (custom file > tier default) ---
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

  // --- 3. Knowledge files (optional directory) ---
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
    throw new Error(`Template config not found: ${yamlPath}`);
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

  // Store recipe for dynamic reassembly
  agent.promptRecipe = recipe;

  return agent;
}

/**
 * Scan template directories and load all templates with layered override.
 *
 * Three-layer template loading with layered override:
 *
 * 1. **Bundled** 鈥?always loaded from the package.
 * 2. **User-global** (`~/.swarmflow/prompts/templates/`) 鈥?adds new templates only;
 *    cannot override bundled templates (their prompt assembly assumes a specific format).
 * 3. **Project-local** (`{project}/.swarmflow/prompts/templates/`) 鈥?highest priority;
 *    CAN override both bundled and user-global templates.
 *
 * @param bundledRoot  Bundled templates root (always available from the package).
 * @param config       Global Config instance.
 * @param mcpManager   Optional MCP client manager.
 * @param promptsDirs  Ordered prompts directories (user first, bundled second).
 * @param userRoot     Optional user override templates root (~/.swarmflow/prompts/templates/).
 * @param projectRoot  Optional project-local templates root ({project}/.swarmflow/prompts/templates/).
 * @returns `{ name: agent }` record.
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
    throw new Error(`Bundled templates root not found: ${bundledRoot}`);
  }

  // Pass 1: bundled templates (base layer)
  const templateDirs: Record<string, string> = {};
  const bundledNames = new Set<string>();
  for (const child of readdirSync(bundledRoot).sort()) {
    const childPath = join(bundledRoot, child);
    if (isTemplateDir(childPath)) {
      templateDirs[child] = childPath;
      bundledNames.add(child);
    }
  }

  // Pass 2: user-global additions (cannot override bundled)
  if (userRoot && existsSync(userRoot) && statSync(userRoot).isDirectory()) {
    for (const child of readdirSync(userRoot).sort()) {
      if (bundledNames.has(child)) continue; // never override bundled templates
      if (child.startsWith("_")) continue; // _-prefixed dirs are examples, not loaded
      const childPath = join(userRoot, child);
      if (isTemplateDir(childPath)) {
        templateDirs[child] = childPath;
      }
    }
  }

  // Pass 3: project-local templates (CAN override bundled and user-global)
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
 * Validate a template directory without loading it.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateTemplate(templateDir: string): string | null {
  const yamlPath = join(templateDir, AGENT_YAML);
  if (!existsSync(yamlPath)) {
    return `Missing agent.yaml in ${templateDir}`;
  }

  let spec: Record<string, unknown>;
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    spec = (yaml.load(raw) as Record<string, unknown>) ?? {};
  } catch (e) {
    return `Invalid YAML in agent.yaml: ${e}`;
  }

  const typeError = validateTemplateType(spec);
  if (typeError) {
    return typeError;
  }

  if (!spec["system_prompt"] && !spec["system_prompt_file"]) {
    return "agent.yaml must have either 'system_prompt' or 'system_prompt_file'";
  }

  if (typeof spec["system_prompt_file"] === "string") {
    const promptPath = join(templateDir, spec["system_prompt_file"]);
    if (!existsSync(promptPath)) {
      return `system_prompt_file not found: ${spec["system_prompt_file"]}`;
    }
  }

  if (typeof spec["tools_prompt_file"] === "string") {
    const toolsPromptPath = join(templateDir, spec["tools_prompt_file"]);
    if (!existsSync(toolsPromptPath)) {
      return `tools_prompt_file not found: ${spec["tools_prompt_file"]}`;
    }
  }

  const tierSpec = spec["tool_tier"];
  if (tierSpec !== undefined) {
    if (typeof tierSpec !== "string" || !(tierSpec in TOOL_TIER_TOOLS)) {
      const valid = Object.keys(TOOL_TIER_TOOLS).join(", ");
      return `Invalid tool_tier '${String(tierSpec)}'. Must be one of: ${valid}`;
    }
  }

  const toolsSpec = spec["tools"];
  if (toolsSpec != null && toolsSpec !== "all" && !Array.isArray(toolsSpec)) {
    return `Invalid tools spec: must be "all", a list of tool/pack names, or omitted`;
  }
  if (Array.isArray(toolsSpec)) {
    for (const entry of toolsSpec) {
      if (typeof entry !== "string") {
        return `Invalid tools entry: expected string, got ${typeof entry}`;
      }
      if (!TOOL_PACKS[entry] && !BASIC_TOOLS_MAP[entry]) {
        return `Unknown tool or pack '${entry}'. Available tools: ${Object.keys(BASIC_TOOLS_MAP).join(", ")}; packs: ${Object.keys(TOOL_PACKS).join(", ")}`;
      }
    }
  }

  if (tierSpec === undefined && toolsSpec == null) {
    return `agent.yaml must specify either 'tool_tier' (preferred) or 'tools'`;
  }

  const maxRoundsError = validateTemplateMaxToolRounds(spec);
  if (maxRoundsError) {
    return maxRoundsError;
  }

  return null;
}

// ------------------------------------------------------------------
// Prompt assembly
// ------------------------------------------------------------------

/**
 * Resolve the prompts/ directory as a sibling of the templates root.
 * Returns the path if found, or undefined if not.
 */
export function resolvePromptsDir(templatesRoot: string): string | undefined {
  const candidate = join(dirname(templatesRoot), "prompts");
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return candidate;
  }
  return undefined;
}

/**
 * Resolve tool names from the `tools` field in agent.yaml.
 *
 * - `"all"` 鈫?all tools in TOOL_PROMPT_ORDER
 * - Array of names/packs 鈫?expand packs, deduplicate
 * - Absent / null 鈫?EXECUTOR_DEFAULT_TOOLS (for custom templates)
 *
 * Pack names and individual tool names can be mixed freely:
 *   tools: [read, bash, time]   鈫? read_file, list_dir, glob, grep, bash, time
 */
/**
 * Expand an array of tool specs (pack names and/or individual tool names)
 * into a deduplicated list of individual tool names.
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
// Internal helpers
// ------------------------------------------------------------------

/**
 * Return the system prompt string from inline text or an external file.
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
      throw new Error(`system_prompt_file not found: ${promptPath}`);
    }
    return readFileSync(promptPath, "utf-8");
  }
  return "";
}

function validateTemplateType(spec: Record<string, unknown>): string | null {
  const type = spec["type"];
  if (typeof type !== "string" || !type.trim()) {
    return `agent.yaml must set type: ${REQUIRED_TEMPLATE_TYPE}`;
  }
  if (type !== REQUIRED_TEMPLATE_TYPE) {
    return `Invalid template type '${type}': expected '${REQUIRED_TEMPLATE_TYPE}'`;
  }
  return null;
}

function validateTemplateMaxToolRounds(spec: Record<string, unknown>): string | null {
  const raw = spec["max_tool_rounds"];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return `agent.yaml must set integer max_tool_rounds >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS}`;
  }
  if (raw < MIN_TEMPLATE_MAX_TOOL_ROUNDS) {
    return `max_tool_rounds must be >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS} (got ${raw})`;
  }
  return null;
}

/**
 * Resolve the `tools` field to a list of ToolDef objects.
 *
 * - `"all"` => all built-in tools
 * - A list of pack/tool names => expand packs, resolve each from BASIC_TOOLS_MAP
 * - Absent / null => empty list (custom templates get defaults via resolveToolNames)
 */
function resolveTools(spec: Record<string, unknown>): ToolDef[] {
  // Primary: tool_tier (swarmflow-style). Throws on invalid values.
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

  // Fallback: explicit tools list (backward compat for custom templates)
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
          `Unknown tool '${name}'. Available: ${Object.keys(BASIC_TOOLS_MAP).join(", ")}, packs: ${Object.keys(TOOL_PACKS).join(", ")}`,
        );
      }
      resolved.push(tool);
    }
    return resolved;
  }

  throw new Error(`Invalid tools spec: ${JSON.stringify(toolsSpec)}`);
}

/**
 * Resolve the `mcp_tools` field to MCP ToolDef objects.
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
          `MCP server '${serverName}' has no tools or is not connected`,
        );
      }
      tools.push(...serverTools);
    }
    return tools;
  }

  return [];
}

/**
 * Build a fully configured Agent from the parsed YAML spec.
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
      `No model specified for template '${name}' and no default model in config.`,
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

  // Keep MCP selection intent for runtime lazy wiring in Session._ensureMcp().
  (agent as any)._mcpToolsSpec = spec["mcp_tools"] ?? undefined;

  return agent;
}
