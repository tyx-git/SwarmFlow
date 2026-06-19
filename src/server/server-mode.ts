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
 * 运行服务器模式。当对等方断开连接或调用 `server.shutdown` 时返回。
 * 引导失败时抛出异常。
 */
export async function runServerMode(opts: ServerModeOptions): Promise<void> {
  const homeDir = getSwarmflowHomeDir();
  loadDotenv(homeDir);

  const projectPath = opts.workDir;
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`work-dir does not exist or is not a directory: ${projectPath}`);
  }

  // GUI 子进程希望其工作目录与项目匹配。
  // 这影响工具和 bash 中的相对路径解析。
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
    localProviders,
    mcpServers,
    modelTiers: settings.model_tiers,
    agentModels: settings.agent_models,
    subAgentInheritMcp: settings.sub_agent_inherit_mcp,
    subAgentInheritHooks: settings.sub_agent_inherit_hooks,
  });

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

  // 恢复模型选择
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
