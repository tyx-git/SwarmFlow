import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { Config, resolveAssetPaths, getBundledAssetsDir } from "../../src/config/config.js";
import { Agent } from "../../src/agents/agent.js";
import { Session } from "../../src/session.js";
import { loadTemplates } from "../../src/templates/loader.js";
import { ensureBuiltinSkills, loadSkillsMulti } from "../../src/skills/loader.js";
import { ensureGlobalMemoryFile } from "../../src/lib/prompt-assembler.js";
import {
  SessionStore,
  loadGlobalSettings,
  loadLocalSettings,
  mergeSettings,
  parseSettingsOverrides,
  settingsToConfigInputs,
} from "../../src/config/persistence.js";
import { loadDotenv } from "../../src/lifecycle/dotenv.js";
import type { ThemeModePref } from "../../src/config/theme.js";
import { getSwarmflowHomeDir } from "../../src/lib/home-path.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
} from "../../src/commands/commands.js";
import type { CommandRegistry } from "../../src/commands/commands.js";
import type { PersistedModelSelection } from "../../src/models/selection.js";
import { applyPersistedModelSelectionToSession } from "../../src/models/restore.js";
import {
  resolveStartupModelSelection,
  resolveTemplateFallbackModel,
} from "../../src/models/startup-selection.js";
function identifyPrimaryAgent(
  agents: Record<string, Agent>,
  config: Config,
  name = "queen",
): Agent {
  const agent = agents[name] ?? agents.queen;
  if (agent) return agent;

  const names = Object.keys(agents).sort();
  if (names.length > 0) {
    return agents[names[0]!];
  }

  // No templates loaded (first run, no providers configured).
  // Create a minimal placeholder agent with a stub modelConfig.
  // User will configure via /provider + /model.
  const stub = new Agent({
    name: "queen",
    modelConfig: {
      name: "__pending__",
      provider: "__pending__",
      model: "",
      apiKey: "",
      baseUrl: "https://placeholder.invalid",
      temperature: 0.7,
      maxTokens: 8192,
      contextLength: 128000,
      supportsMultimodal: false,
      supportsWebSearch: false,
      thinkingBudget: 0,
      transportProtocol: "chat",
      thinkingEncryption: "none",
      sealedSchema: null,
      extra: {},
    },
    role: "You are a helpful assistant.",
    tools: [],
    description: "Default (configure a provider and model to start)",
  });
  return stub;
}

function formatOAuthRefreshError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function refreshActiveOpenAICodexToken(session: Session): Promise<void> {
  if (session.primaryAgent?.modelConfig?.provider !== "openai-codex") return;

  try {
    const { ensureFreshToken } = await import("../../src/auth/openai-oauth.js");
    await ensureFreshToken();
    session.reloadCurrentModelConfig();
  } catch (err) {
    session.appendErrorMessage(
      `OAuth token refresh failed: ${formatOAuthRefreshError(err)}`,
      "oauth_refresh",
    );
  }
}

export interface OpenTuiRuntime {
  session: Session;
  store: SessionStore;
  commandRegistry: CommandRegistry;
  verbose: boolean;
  /** Persisted user preference for theme mode. main.tsx feeds this into the resolver. */
  themeModePref: ThemeModePref;
  /** Persisted global preference for inline write/edit diff display. */
  diffDisplay: "compact" | "full";
}

export async function bootstrapOpenTuiRuntime(opts?: {
  templates?: string;
  configOverrides?: readonly string[];
  verbose?: boolean;
  homeDir?: string;
  projectPath?: string;
  initHighlighter?: boolean;
}): Promise<OpenTuiRuntime> {
  const homeDir = opts?.homeDir ?? getSwarmflowHomeDir();
  loadDotenv(homeDir);

  const verbose = opts?.verbose ?? false;
  const projectPath = opts?.projectPath ?? process.cwd();
  const store = new SessionStore({ projectPath, baseDir: homeDir });

  // ── Load settings (global + local merge) ──
  const globalSettings = loadGlobalSettings(homeDir);
  const localSettings = loadLocalSettings(projectPath, store.projectDir);
  let settings = mergeSettings(globalSettings, localSettings);
  settings = mergeSettings(settings, parseSettingsOverrides(opts?.configOverrides ?? []));

  // Check if any providers are configured (non-blocking; empty Config is valid on first run)
  const { providerEnvVars, providerModels, localProviders, mcpServers } = settingsToConfigInputs(settings);

  // ── Build Config ──
  // Materialize the protected workflow skills before resolving roots so a
  // first-run home directory is included in the merged skill search path.
  ensureBuiltinSkills(join(homeDir, "skills"));
  // 全局记忆初始化为空文件；用户之后手动维护。
  ensureGlobalMemoryFile(homeDir);
  const paths = resolveAssetPaths({
    templatesFlag: opts?.templates,
    projectPath,
    homeDir,
  });
  const config = new Config({
    providerEnvVars,
    providerModels,
    localProviders,
    mcpServers,
    subAgentInheritMcp: settings.sub_agent_inherit_mcp,
    subAgentInheritHooks: settings.sub_agent_inherit_hooks,
  });

  // Restore the selected model before templates are instantiated so templates
  // without an explicit model do not force Config.defaultModel token resolution.
  // 唯一数据源是 settings.json：currentProvider.currentModel > default_model。
  const startupSelection = resolveStartupModelSelection(config, settings);
  const templateFallbackModel = resolveTemplateFallbackModel(config, startupSelection);

  // ── MCP client (connect eagerly, await lazily on first turn) ──
  let mcpManager: unknown = null;
  let mcpReadyPromise: Promise<void> | undefined;
  if (config.mcpServerConfigs.length > 0) {
    try {
      const { MCPClientManager } = await import("../../src/clients/mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
      mcpReadyPromise = (mcpManager as any).connectAll().catch(() => {});
    } catch {
      console.warn(
        "Warning: MCP servers configured but MCP client module not available. Install @modelcontextprotocol/sdk if needed.",
      );
    }
  }

  // ── Templates ──
  const bundledDir = getBundledAssetsDir();
  const bundledTemplates = join(bundledDir, "prompts", "templates");
  const bundledPrompts = join(bundledDir, "prompts");
  const promptsDirs: string[] = [];
  if (paths.promptsPath) promptsDirs.push(paths.promptsPath);
  promptsDirs.push(bundledPrompts);

  const agents = loadTemplates(
    bundledTemplates,
    config,
    mcpManager as never,
    promptsDirs,
    paths.templatesPath ?? undefined,
    paths.projectTemplatesPath ?? undefined,
    templateFallbackModel,
  );
  const primary = identifyPrimaryAgent(agents, config);

  // ── Skills (four-layer: bundled > global > project > workspace) ──
  const bundledSkills = join(bundledDir, "skills");
  const skillRoots: string[] = [];
  if (existsSync(bundledSkills) && statSync(bundledSkills).isDirectory()) {
    skillRoots.push(bundledSkills);
  }
  skillRoots.push(...paths.skillRoots);
  const skills = loadSkillsMulti(skillRoots);

  // ── Session ──
  const contextBudgetPercent = settings.context_budget_percent ?? 100;
  const session = new Session({
    primaryAgent: primary as never,
    config,
    agentTemplates: agents as never,
    skills: skills as never,
    skillRoots,
    progress: undefined,
    mcpManager: mcpManager as never,
    mcpReadyPromise,
    promptsDirs,
    store: store as never,
    contextBudgetPercent,
    projectRoot: projectPath,
    homeDir,
    forkInheritPromptCacheKey: settings.fork_inherit_prompt_cache_key === true,
  });

  // Notify TUI when eager MCP connect completes
  if (mcpReadyPromise && mcpManager) {
    const mgr = mcpManager as any;
    mcpReadyPromise.then(() => {
      if (session.onMcpStatus && typeof mgr.getServerStatuses === "function") {
        session.onMcpStatus(mgr.getServerStatuses());
      }
    });
  }

  // ── Hooks (global > project > workspace) ──
  try {
    const { loadHooksMulti } = await import("../../src/hooks/index.js");
    const hooksLoaded = loadHooksMulti(paths.hookRoots);
    if (hooksLoaded.length > 0) {
      session.hookRuntime.setHooks(hooksLoaded);
    }
  } catch { /* hooks module optional */ }

  // ── Restore model selection ──
  // settings.json-only: currentProvider.currentModel > default_model.
  try {
    if (startupSelection.modelConfigName) {
      applyPersistedModelSelectionToSession(
        session,
        {
          modelConfigName: startupSelection.modelConfigName,
          modelProvider: startupSelection.modelProvider,
          modelSelectionKey: startupSelection.modelSelectionKey,
          modelId: startupSelection.modelId,
        } satisfies PersistedModelSelection,
      );
    }
  } catch (err) {
    console.warn(
      `Warning: failed to restore saved model preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Apply settings to session ──
  session.applySettings(settings, {
    thinkingLevel: startupSelection.thinkingLevel,
  });
  await refreshActiveOpenAICodexToken(session);

  // 预加载独立工具行使用的成熟 Shiki 高亮器。原生 MarkdownRenderable
  // 自己负责 Tree-sitter 高亮，不再需要应用层补丁。
  if (opts?.initHighlighter !== false) {
    import("./forked/shiki-highlighter.js")
      .then(({ initShikiHighlighter }) => initShikiHighlighter())
      .catch(() => undefined);
  }

  const commandRegistry = buildDefaultRegistry();
  registerSkillCommands(commandRegistry, session.skills);

  const themeModePref: ThemeModePref = settings.theme_mode ?? "auto";
  const diffDisplay: "compact" | "full" = globalSettings.diff_display === "full" ? "full" : "compact";
  return {
    session,
    store,
    commandRegistry,
    verbose,
    themeModePref,
    diffDisplay,
  };
}
