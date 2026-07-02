import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { Config, resolveAssetPaths, getBundledAssetsDir } from "../../src/config/config.js";
import { Agent } from "../../src/agents/agent.js";
import { Session } from "../../src/session.js";
import { loadTemplates } from "../../src/templates/loader.js";
import { loadSkillsMulti } from "../../src/skills/loader.js";
import {
  SessionStore,
  loadGlobalSettings,
  loadLocalSettings,
  mergeSettings,
  loadModelSelectionState,
  parseSettingsOverrides,
  settingsToConfigInputs,
} from "../../src/config/persistence.js";
import { loadDotenv } from "../../src/lifecycle/dotenv.js";
import { getSwarmflowHomeDir } from "../../src/lib/home-path.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
} from "../../src/commands/commands.js";
import type { CommandRegistry } from "../../src/commands/commands.js";
import type { PersistedModelSelection } from "../../src/models/selection.js";
import { applyPersistedModelSelectionToSession } from "../../src/models/restore.js";
import {
  hasAnyManagedCredential,
} from "../../src/config/managed-provider-credentials.js";

function identifyPrimaryAgent(
  agents: Record<string, Agent>,
  config: Config,
  name = "main",
): Agent {
  const agent = agents[name];
  if (agent) return agent;

  const names = Object.keys(agents).sort();
  if (names.length > 0) {
    return agents[names[0]!];
  }

  // No templates loaded (first run, no providers configured).
  // Create a minimal placeholder agent with a stub modelConfig.
  // User will configure via /provider + /model.
  const stub = new Agent({
    name: "main",
    modelConfig: {
      name: "__pending__",
      provider: "__pending__",
      model: "",
      apiKey: "",
      baseUrl: "https://placeholder.invalid",
      temperature: 0.7,
      maxTokens: 8192,
      contextLength: 128000,
      supportsThinking: false,
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

function resolveTemplateFallbackModel(
  config: Config,
  effectiveModelConfigName: string | undefined,
  modelState: ReturnType<typeof loadModelSelectionState>,
): string | undefined {
  if (effectiveModelConfigName && config.modelNames.includes(effectiveModelConfigName)) {
    return effectiveModelConfigName;
  }
  const provider = modelState.provider?.trim();
  const model = modelState.model_id?.trim() || modelState.selection_key?.trim();
  if (!provider || !model) return undefined;
  return config.findModelConfigName(provider, model);
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
  themeModePref: "auto" | "light" | "dark" | "default" | "nord" | "dracula";
  /** Persisted global preference for inline write/edit diff display. */
  diffDisplay: "compact" | "full";
  /** Persisted global preference for copy-on-select. Default: true. */
  copyOnSelect: boolean;
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
  const { providerEnvVars, localProviders, mcpServers } = settingsToConfigInputs(settings);

  // ── Build Config ──
  const paths = resolveAssetPaths({
    templatesFlag: opts?.templates,
    projectPath,
    homeDir,
  });
  const config = new Config({
    providerEnvVars,
    localProviders,
    mcpServers,
    modelTiers: settings.model_tiers,
    agentModels: settings.agent_models,
    subAgentInheritMcp: settings.sub_agent_inherit_mcp,
    subAgentInheritHooks: settings.sub_agent_inherit_hooks,
  });

  // Restore the selected model before templates are instantiated so templates
  // without an explicit model do not force Config.defaultModel token resolution.
  const modelState = loadModelSelectionState(homeDir);
  const effectiveModelConfigName = settings.default_model ?? modelState.config_name;
  const templateFallbackModel = resolveTemplateFallbackModel(
    config,
    effectiveModelConfigName,
    modelState,
  );

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
  // Priority: settings.default_model > state/model-selection.json
  try {
    if (effectiveModelConfigName) {
      applyPersistedModelSelectionToSession(
        session,
        {
          modelConfigName: effectiveModelConfigName,
          modelProvider: modelState.provider,
          modelSelectionKey: modelState.selection_key,
          modelId: modelState.model_id,
        } satisfies PersistedModelSelection,
      );
    }
  } catch (err) {
    console.warn(
      `Warning: failed to restore saved model preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Apply settings to session ──
  session.applySettings(settings, modelState);
  await refreshActiveOpenAICodexToken(session);

  // ── Shiki syntax highlighter (disable with SHIKI=0) ──
  if (opts?.initHighlighter !== false) {
    if (process.env.SHIKI !== "0") {
      import("./forked/shiki-highlighter.js").then(async ({ initShikiHighlighter }) => {
        await initShikiHighlighter();
      }).catch(() => {
        // Shiki unavailable — silently fall back to hljs.
        import("./forked/patch-opentui-markdown.js").then(({ setUseShikiHighlighter }) => {
          setUseShikiHighlighter(false);
        });
      });
    } else {
      import("./forked/patch-opentui-markdown.js").then(({ setUseShikiHighlighter }) => {
        setUseShikiHighlighter(false);
      });
    }
  }

  const commandRegistry = buildDefaultRegistry();
  registerSkillCommands(commandRegistry, session.skills);

  const themeModePref: "auto" | "light" | "dark" | "default" | "nord" | "dracula" = settings.theme_mode ?? "auto";
  const diffDisplay: "compact" | "full" = globalSettings.diff_display === "full" ? "full" : "compact";
  const copyOnSelect: boolean = globalSettings.copy_on_select !== false;

  return {
    session,
    store,
    commandRegistry,
    verbose,
    themeModePref,
    diffDisplay,
    copyOnSelect,
  };
}
