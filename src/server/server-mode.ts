/**
 * `swarmflow --server` runtime: bootstraps a Session and serves NDJSON JSON-RPC
 * over stdio.
 *
 * One process = one Session. The GUI (Electron main process) spawns one of
 * these per tab and supervises them. See gui/electron/sessionProcess.ts.
 *
 * Lifecycle:
 *   1. Read settings + build Config (must have at least one provider configured)
 *   2. Load templates / agents / skills / hooks
 *   3. Construct Session
 *   4. Restore model selection + apply settings
 *   5. Register RPC handlers and emit `ready` event with session metadata
 *   6. Listen on stdin until EOF or `server.shutdown` request
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { createRpcServer } from "./rpc-transport.js";
import { buildMeta, registerSessionRpc } from "./session-rpc.js";
import { registerInitRpc } from "./init-rpc.js";
import { Config, resolveAssetPaths, getBundledAssetsDir } from "../config/config.js";
import { Agent } from "../agents/agent.js";
import { Session } from "../session.js";
import { loadTemplates } from "../templates/loader.js";
import { loadSkillsMulti } from "../skills/loader.js";
import {
  SessionStore,
  loadGlobalSettings,
  loadLocalSettings,
  mergeSettings,
  loadModelSelectionState,
  parseSettingsOverrides,
  settingsToConfigInputs,
} from "../config/persistence.js";
import { loadDotenv } from "../lifecycle/dotenv.js";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import type { PersistedModelSelection } from "../models/selection.js";
import { applyPersistedModelSelectionToSession } from "../models/restore.js";
import { hasAnyManagedCredential } from "../config/managed-provider-credentials.js";

export interface ServerModeOptions {
  readonly workDir: string;
  readonly sessionId?: string;
  readonly selectedModel?: string;
  readonly selectedAgent?: string;
  readonly templates?: string;
  readonly configOverrides?: readonly string[];
}

function identifyPrimaryAgent(agents: Record<string, Agent>, name = "main"): Agent {
  const agent = agents[name];
  if (agent) return agent;
  const names = Object.keys(agents).sort();
  if (names.length > 0) return agents[names[0]!];
  throw new Error("No agent templates found");
}

/**
 * Run server mode. Returns when the peer disconnects or `server.shutdown` is
 * called. Throws on bootstrap failure.
 */
export async function runServerMode(opts: ServerModeOptions): Promise<void> {
  const homeDir = getSwarmflowHomeDir();
  loadDotenv(homeDir);

  const projectPath = opts.workDir;
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`work-dir does not exist or is not a directory: ${projectPath}`);
  }

  // The GUI subprocess wants its working directory to match the project.
  // This affects relative path resolution in tools and bash.
  process.chdir(projectPath);

  const store = new SessionStore({ projectPath });

  const globalSettings = loadGlobalSettings(homeDir);
  const localSettings = loadLocalSettings(projectPath, store.projectDir);
  let settings = mergeSettings(globalSettings, localSettings);
  settings = mergeSettings(settings, parseSettingsOverrides(opts.configOverrides ?? []));

  const { providerEnvVars, localProviders, mcpServers } = settingsToConfigInputs(settings);
  const hasProviders =
    Object.keys(providerEnvVars).length > 0
    || Object.keys(localProviders).length > 0
    || hasAnyManagedCredential();

  if (!hasProviders) {
    // No providers configured 鈥?enter init mode instead of throwing.
    // The GUI webview drives the wizard through init RPC methods.
    const rpc = createRpcServer(process.stdin, process.stdout);
    rpc.emit("needs_init", { reason: "no_providers" });

    registerInitRpc({
      server: rpc,
      onInitComplete: async () => {
        // Re-run server mode now that config exists.
        // Re-load dotenv so newly saved keys are visible.
        loadDotenv(homeDir);
        rpc.close();
        await runServerMode(opts);
      },
    });

    process.stdin.on("end", () => { process.exit(0); });
    await new Promise<void>(() => { /* never resolves */ });
    return;
  }

  const paths = resolveAssetPaths({
    templatesFlag: opts.templates,
    projectPath,
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

  // OAuth token refresh 鈥?best-effort, don't fail bootstrap if it fails
  const oauthEntries = config.listModelEntries().filter((e) => e.apiKeyRaw === "oauth:openai-codex");
  if (oauthEntries.length > 0) {
    try {
      const { ensureFreshToken } = await import("../auth/openai-oauth.js");
      await ensureFreshToken();
    } catch (err) {
      process.stderr.write(`[server] OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // MCP manager (connect eagerly, await lazily on first turn)
  let mcpManager: unknown = null;
  let mcpReadyPromise: Promise<void> | undefined;
  if (config.mcpServerConfigs.length > 0) {
    try {
      const { MCPClientManager } = await import("../clients/mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
      mcpReadyPromise = (mcpManager as any).connectAll().catch(() => {});
    } catch {
      // optional
    }
  }

  // Templates
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
  );
  const primary = identifyPrimaryAgent(agents, opts.selectedAgent);

  // Skills
  const bundledSkills = join(bundledDir, "skills");
  const skillRoots: string[] = [];
  if (existsSync(bundledSkills) && statSync(bundledSkills).isDirectory()) {
    skillRoots.push(bundledSkills);
  }
  skillRoots.push(...paths.skillRoots);
  const skills = loadSkillsMulti(skillRoots);

  // Hooks
  let hooksLoaded: import("../hooks/index.js").HookManifest[] = [];
  try {
    const { loadHooksMulti } = await import("../hooks/index.js");
    hooksLoaded = loadHooksMulti(paths.hookRoots);
  } catch { /* optional */ }

  // Session
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
  });

  if (hooksLoaded.length > 0) {
    session.hookRuntime.setHooks(hooksLoaded);
  }

  // Restore model selection
  const modelState = loadModelSelectionState(homeDir);
  const effectiveModelConfigName = opts.selectedModel ?? settings.default_model ?? modelState.config_name;
  if (effectiveModelConfigName) {
    try {
      applyPersistedModelSelectionToSession(
        session,
        {
          modelConfigName: effectiveModelConfigName,
          modelProvider: modelState.provider,
          modelSelectionKey: modelState.selection_key,
          modelId: modelState.model_id,
        } satisfies PersistedModelSelection,
      );
    } catch (err) {
      process.stderr.write(
        `[server] failed to restore model: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  session.applySettings(settings, modelState);

  // 鈹€鈹€ Start RPC server 鈹€鈹€
  const rpc = createRpcServer(process.stdin, process.stdout);

  let shutdownRequested = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    try {
      await session.close();
    } catch (err) {
      process.stderr.write(
        `[server] session close failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    rpc.close();
    process.exit(0);
  };

  registerSessionRpc({
    session,
    server: rpc,
    sessionDir: store.sessionDir ?? null,
    workDir: projectPath,
    onShutdown: shutdown,
  });

  // Emit ready event with session metadata so the GUI can populate its UI.
  // Shares buildMeta() with session-rpc so the payload (including
  // protocolVersion/capabilities) can never drift between the two emitters.
  rpc.emit("ready", buildMeta(session, projectPath, store.sessionDir ?? null));

  // Last-resort crash guard. Without it, any escaped exception kills the
  // process silently: the client sees a frozen UI with no explanation (the
  // TUI entry point installs the equivalent handlers in external/opentui/main.tsx).
  // Best-effort order: persist the session, tell the client why, then exit
  // non-zero so the supervisor (GUI) can react.
  let crashing = false;
  const crashGuard = (origin: "uncaughtException" | "unhandledRejection") => (err: unknown): void => {
    if (crashing) return; // a second fault during cleanup must not recurse
    crashing = true;
    try {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[server] ${origin}: ${message}\n`);
    } catch { /* stderr may already be closed */ }
    try {
      session.onSaveRequest?.();
    } catch { /* saving is best-effort during a crash */ }
    try {
      rpc.emit("server.crashed", {
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch { /* peer may already be gone */ }
    // Give stdout a tick to flush the crash event before exiting.
    setTimeout(() => process.exit(1), 100);
  };
  process.on("uncaughtException", crashGuard("uncaughtException"));
  process.on("unhandledRejection", crashGuard("unhandledRejection"));

  // Keep process alive until stdin closes (peer disconnect) or shutdown.
  process.stdin.on("end", () => {
    void shutdown();
  });

  // Don't return 鈥?let stdin keep us alive
  await new Promise<void>(() => {
    /* never resolves; shutdown calls process.exit */
  });
}
