/**
 * `swarmflow --server` 运行时：引导一个 Session 并通过 stdio 提供 NDJSON JSON-RPC
 * 服务。
 *
 * 一个进程 = 一个 Session。GUI（Electron 主进程）为每个标签页生成一个
 * 此类进程并监督它们。见 gui/electron/sessionProcess.ts。
 *
 * 生命周期：
 *   1. 读取设置 + 构建 Config（必须至少配置一个提供者）
 *   2. 加载模板 / agents / skills / hooks
 *   3. 构造 Session
 *   4. 恢复模型选择 + 应用设置
 *   5. 注册 RPC 处理器并发出带有 session 元数据的 `ready` 事件
 *   6. 在 stdin 上监听直到 EOF 或 `server.shutdown` 请求
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { getLogger, initLogger } from "../lib/logger.js";
import { createRpcServer } from "./rpc-transport.js";
import { buildMeta, registerSessionRpc } from "./session-rpc.js";
import { registerInitRpc } from "./init-rpc.js";
import { Config, resolveAssetPaths, getBundledAssetsDir } from "../config/config.js";
import { Agent } from "../agents/agent.js";
import { Session } from "../session.js";
import { loadTemplates } from "../templates/loader.js";
import { ensureBuiltinSkills, loadSkillsMulti } from "../skills/loader.js";
import { ensureGlobalMemoryFile } from "../lib/prompt-assembler.js";
import {
  SessionStore,
  loadGlobalSettings,
  loadLocalSettings,
  mergeSettings,
  parseSettingsOverrides,
  settingsToConfigInputs,
} from "../config/persistence.js";
import { loadDotenv } from "../lifecycle/dotenv.js";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import type { PersistedModelSelection } from "../models/selection.js";
import { applyPersistedModelSelectionToSession } from "../models/restore.js";
import {
  resolveStartupModelSelection,
  resolveTemplateFallbackModel,
} from "../models/startup-selection.js";
import { hasAnyManagedCredential } from "../config/managed-provider-credentials.js";

export interface ServerModeOptions {
  readonly workDir: string;
  readonly sessionId?: string;
  readonly selectedModel?: string;
  readonly selectedAgent?: string;
  readonly templates?: string;
  readonly configOverrides?: readonly string[];
}

function identifyPrimaryAgent(agents: Record<string, Agent>, name = "queen"): Agent {
  const agent = agents[name] ?? agents.queen;
  if (agent) return agent;
  const names = Object.keys(agents).sort();
  if (names.length > 0) return agents[names[0]!];
  // 没有用户模型时仍启动服务，让 GUI 可以通过 /provider 和 /model 完成配置。
  return new Agent({
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
}

/**
 * 运行服务器模式。当对等方断开连接或调用 `server.shutdown` 时返回。
 * 引导失败时抛出异常。
 */
export async function runServerMode(opts: ServerModeOptions): Promise<void> {
  initLogger();
  const log = getLogger("server");
  log.info("runServerMode:enter", { workDir: opts.workDir, hasSessionId: Boolean(opts.sessionId) });

  const homeDir = getSwarmflowHomeDir();
  loadDotenv(homeDir);

  // 先归一化为绝对路径，再 chdir：否则相对 work-dir 会在切换目录后被
  // 二次拼接（例如 --work-dir project 变成 <project>/project）。
  const projectPath = resolve(opts.workDir);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`work-dir does not exist or is not a directory: ${projectPath}`);
  }

  // GUI 子进程希望其工作目录与项目匹配。
  // 这影响工具和 bash 中的相对路径解析。
  process.chdir(projectPath);

  // Keep the protected workflow skills available even during first-run init.
  ensureBuiltinSkills(join(homeDir, "skills"));
  // 全局记忆初始化为空文件；用户之后手动维护。
  ensureGlobalMemoryFile(homeDir);

  const store = new SessionStore({ projectPath });

  const globalSettings = loadGlobalSettings(homeDir);
  const localSettings = loadLocalSettings(projectPath, store.projectDir);
  let settings = mergeSettings(globalSettings, localSettings);
  settings = mergeSettings(settings, parseSettingsOverrides(opts.configOverrides ?? []));

  const { providerEnvVars, providerModels, localProviders, mcpServers } = settingsToConfigInputs(settings);
  const hasProviders =
    Object.keys(providerEnvVars).length > 0
    || Object.keys(localProviders).length > 0
    || hasAnyManagedCredential();

  if (!hasProviders) {
    // 未配置提供者 — 进入 init 模式而不是抛出异常。
    // GUI webview 通过 init RPC 方法驱动向导。
    const rpc = createRpcServer(process.stdin, process.stdout);
    rpc.emit("needs_init", { reason: "no_providers" });

    registerInitRpc({
      server: rpc,
      onInitComplete: async () => {
        // 现在配置存在了，重新运行服务器模式。
        // 重新加载 dotenv 以使新保存的密钥可见。
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
    providerModels,
    localProviders,
    mcpServers,
    subAgentInheritMcp: settings.sub_agent_inherit_mcp,
    subAgentInheritHooks: settings.sub_agent_inherit_hooks,
  });

  // 新会话的模型/思考深度必须在模板实例化前确定，唯一数据源是 settings.json：
  // currentProvider.currentModel > default_model。
  const startupSelection = resolveStartupModelSelection(config, settings, {
    selectedModel: opts.selectedModel,
  });
  const templateFallbackModel = resolveTemplateFallbackModel(config, startupSelection);

  // OAuth token 刷新 — 尽力而为，失败时不让引导失败
  const oauthEntries = config.listModelEntries().filter((e) => e.apiKeyRaw === "oauth:openai-codex");
  if (oauthEntries.length > 0) {
    try {
      const { ensureFreshToken } = await import("../auth/openai-oauth.js");
      await ensureFreshToken();
    } catch (err) {
      process.stderr.write(`[server] OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // MCP 管理器（急切连接，在第一个回合惰性等待）
  let mcpManager: unknown = null;
  let mcpReadyPromise: Promise<void> | undefined;
  if (config.mcpServerConfigs.length > 0) {
    try {
      const { MCPClientManager } = await import("../clients/mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
      mcpReadyPromise = (mcpManager as any).connectAll().catch(() => {});
    } catch {
      // 可选
    }
  }

  // 模板
  const bundledDir = getBundledAssetsDir();
  const bundledTemplatesDir = join(bundledDir, "prompts", "templates");
  const bundledPrompts = join(bundledDir, "prompts");
  const promptsDirs: string[] = [];
  if (paths.promptsPath) promptsDirs.push(paths.promptsPath);
  promptsDirs.push(bundledPrompts);

  const agents = loadTemplates(
    bundledTemplatesDir,
    config,
    mcpManager as never,
    promptsDirs,
    paths.templatesPath ?? undefined,
    paths.projectTemplatesPath ?? undefined,
    templateFallbackModel,
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
    homeDir,
    contextBudgetPercent,
    forkInheritPromptCacheKey: settings.fork_inherit_prompt_cache_key === true,
  });

  if (hooksLoaded.length > 0) {
    session.hookRuntime.setHooks(hooksLoaded);
  }

  // 恢复模型选择（包括 currentModel 的思考深度）
  if (startupSelection.modelConfigName) {
    try {
      applyPersistedModelSelectionToSession(
        session,
        {
          modelConfigName: startupSelection.modelConfigName,
          modelProvider: startupSelection.modelProvider,
          modelSelectionKey: startupSelection.modelSelectionKey,
          modelId: startupSelection.modelId,
        } satisfies PersistedModelSelection,
      );
    } catch (err) {
      process.stderr.write(
        `[server] failed to restore model: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  session.applySettings(settings, {
    thinkingLevel: startupSelection.thinkingLevel,
  });

  // ── Start RPC server ──
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

  // 发出带 session 元数据的 ready 事件，以便 GUI 填充其 UI。
  // 与 session-rpc 共享 buildMeta()，确保 payload（包括 protocolVersion/capabilities）
  // 在两个发射点之间永不漂移。
  rpc.emit("ready", buildMeta(session, projectPath, store.sessionDir ?? null));

  // 最后一层崩溃保护。没有它，任何逃逸异常都会静默杀死进程：
  // 客户端只会看到冻结且无解释的 UI（TUI 入口在 external/opentui/main.tsx
  // 安装了等价处理器）。尽力顺序：持久化 session，告诉客户端原因，
  // 然后以非零码退出，让监督者（GUI）可以响应。
  let crashing = false;
  const crashGuard = (origin: "uncaughtException" | "unhandledRejection") => (err: unknown): void => {
    if (crashing) return; // 清理期间的第二个故障不得递归
    crashing = true;
    try {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[server] ${origin}: ${message}\n`);
    } catch { /* stderr 可能已经关闭 */ }
    try {
      session.onSaveRequest?.();
    } catch { /* 崩溃期间保存是尽力而为 */ }
    try {
      rpc.emit("server.crashed", {
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch { /* 对端可能已经消失 */ }
    // 退出前给 stdout 一个 tick 来刷新崩溃事件。
    setTimeout(() => process.exit(1), 100);
  };
  process.on("uncaughtException", crashGuard("uncaughtException"));
  process.on("unhandledRejection", crashGuard("unhandledRejection"));

  // 保持进程存活，直到 stdin 关闭（对端断开）或执行 shutdown。
  process.stdin.on("end", () => {
    void shutdown();
  });

  // 不返回 — 让 stdin 保持进程存活
  await new Promise<void>(() => {
    /* 永不解析；shutdown 会调用 process.exit */
  });
}
