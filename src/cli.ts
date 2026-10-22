#!/usr/bin/env node

/**
 * SwarmFlow CLI 入口点。
 *
 * 用法：
 *   swarmflow                       # 自动检测配置
 *   swarmflow init                  # 运行初始化向导
 *   swarmflow --templates ./tpls    # 指定模板路径
 *   swarmflow --verbose             # 启用调试日志
 *   swarmflow --resume <id>         # 恢复指定会话
 *   swarmflow --session             # 管理全局历史会话
 *   swarmflow --server              # 服务模式（Electron GUI 派生）
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";

import { initLogger, getLogger } from "./logging/logger.js";

import { fixStorage } from "./config/storage-repair.js";
import { loadGlobalSettings, parseSettingsOverrides, settingsToConfigInputs } from "./config/settings/io.js";
import { loadDotenv } from "./lifecycle/dotenv.js";
import { applySystemProxyToEnv } from "./platform/system-proxy/apply-to-env.js";
import { getSwarmflowHomeDir } from "./config/home-dir.js";

import { VERSION } from "./version.js";
import { findSessionById } from "./session/resume.js";
import { interactiveGlobalSessionManager, maybeHandleResumeFlag } from "./cli/session-picker.js";

/**
 * OpenTUI's native renderer writes UTF-8 bytes directly to the Windows
 * console. Node's normal console methods handle Unicode themselves, but the
 * native path is decoded by the active Windows console code page. Legacy
 * consoles commonly start in CP936, which turns every non-ASCII glyph into
 * mojibake. Switch only interactive consoles; redirected output is already a
 * byte stream and must remain UTF-8 for callers to decode.
 */
export function ensureWindowsUtf8Console(): void {
  if (process.platform !== "win32" || !process.stdout.isTTY) return;
  // SEA 单文件版由 scripts/sea-bootstrap.cjs 提前切过代码页，这里跳过，
  // 避免重复派生子进程（一次 chcp 实测约 100~180ms，纯浪费）。
  if (process.env.SWARMFLOW_SEA_CONSOLE_READY === "1") {
    process.stdout.setDefaultEncoding("utf8");
    process.stderr.setDefaultEncoding("utf8");
    return;
  }

  // 直接调用 chcp.com，而不是 `cmd /d /s /c chcp 65001`：绕开 cmd.exe 的
  // 解释器启动，实测单次派生由约 296ms 降到约 181ms。stdout 被忽略，
  // 因此不再需要 `> nul` 重定向。
  const systemRoot = process.env["SYSTEMROOT"] ?? process.env["SystemRoot"] ?? "C:\\Windows";
  const chcpPath = join(systemRoot, "System32", "chcp.com");

  try {
    spawnSync(existsSync(chcpPath) ? chcpPath : "chcp.com", ["65001"], {
      stdio: "ignore",
    });
    process.stdout.setDefaultEncoding("utf8");
    process.stderr.setDefaultEncoding("utf8");
  } catch {
    // The CLI remains usable when launched without a shell-backed console.
  }
}

/**
 * main() 的依赖注入表面。
 * 允许测试替换各环节实现（loadDotenv 等）。
 */
export interface MainDeps {
  launchTui?: () => Promise<void>;
  homeDir?: string;
  loadDotenv?: (homeDir?: string) => void;
  loadGlobalSettings?: typeof loadGlobalSettings;
  runInitWizard?: (homeDir?: string) => Promise<unknown>;
  /** 服务模式入口（Electron 主进程调用）。 */
  runServerMode?: (opts: {
    workDir: string;
    sessionId?: string;
    selectedModel?: string;
    selectedAgent?: string;
    templates?: string;
    configOverrides?: readonly string[];
  }) => Promise<void>;
  findSessionById?: typeof findSessionById;
  hasGitHubTokens?: () => boolean;
}

/** 需要取值的命令行标志（用于别名处理）。 */
const VALUE_FLAGS = new Set([
  "--resume",
  "--templates",
  "--config",
  "-c",
  "--work-dir",
  "--session-id",
  "--model",
  "--agent",
]);

/**
 * 提前验证 -c 配置覆盖，若输入错误则给出友好提示并退出。
 * parseSettingsOverrides 可能抛出原始 Error，不捕获会显示堆栈跟踪。
 */
function parseConfigOverridesOrExit(overrides: readonly string[]) {
  try {
    return parseSettingsOverrides(overrides);
  } catch (err) {
    process.stderr.write(`swarmflow: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

/** 将 -v 别名为 -V（Commader 的 --version 标志）。 */
function normalizeLegacyVersionAlias(argv: string[]): void {
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] !== "-v") continue;
    if (VALUE_FLAGS.has(argv[index - 1] ?? "")) continue;
    argv[index] = "-V";
  }
}

/**
 * 确保初始化向导已运行（首次启动）。
 * `homeDir` 就是 `~/.swarmflow`：目录存在时读取现有配置，目录不存在时进入向导。
 */
async function ensureProvidersConfigured(
  homeDir: string,
  deps: Pick<MainDeps, "loadGlobalSettings" | "runInitWizard">,
): Promise<ReturnType<typeof loadGlobalSettings>> {
  const loadSettings = deps.loadGlobalSettings ?? loadGlobalSettings;
  let homeDirExists = false;
  try {
    homeDirExists = existsSync(homeDir) && statSync(homeDir).isDirectory();
  } catch {
    homeDirExists = false;
  }

  if (homeDirExists) {
    return loadSettings(homeDir);
  }

  // 首次运行：~/.swarmflow 尚不存在，启动向导。
  try {
    const runInitWizard = deps.runInitWizard ?? (await import("./lifecycle/init-wizard.js")).runInitWizard;
    await runInitWizard(homeDir);
  } catch (error) {
    // 取消由向导自身处理；真正的异常需要可见，避免引导静默消失。
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`swarmflow: 初始化向导未完成：${message}\n`);
  }

  return loadSettings(homeDir);
}

/** 若配置了 Copilot 但未登录，显示警告。 */
async function warnIfCopilotCredentialsMissing(
  settings: ReturnType<typeof loadGlobalSettings>,
  hasGitHubTokensOverride?: () => boolean,
): Promise<void> {
  const { providerEnvVars } = settingsToConfigInputs(settings);
  if (!Object.prototype.hasOwnProperty.call(providerEnvVars, "copilot")) return;

  const hasGitHubTokens = hasGitHubTokensOverride
    ?? (await import("./auth/github-copilot-oauth.js")).hasGitHubTokens;
  if (!hasGitHubTokens()) {
    console.warn("Warning: GitHub Copilot credentials missing.");
    console.warn("Run 'swarmflow oauth' to log in.\n");
  }
}

/**
 * 从默认路径动态导入 opentui/main.js 并启动 TUI。
 * 使用动态路径避免 external/opentui 进入 src/ 的 rootDir 类型检查范围。
 */
export function resolveOpenTuiEntry(modulePath = fileURLToPath(import.meta.url)): string | null {
  // Development runs the TypeScript entry directly; compiled distributions
  // contain the JavaScript entry. A compiled CLI lives under `dist/src`,
  // while the source UI remains under the repository root, so check both
  // layouts before reporting that the UI distribution is missing.
  const moduleDir = dirname(modulePath);
  const projectRoots = [resolve(moduleDir, ".."), resolve(moduleDir, "../..")];
  const candidates = projectRoots.flatMap((projectRoot) => [
    join(projectRoot, "external", "opentui", "main.js"),
    join(projectRoot, "external", "opentui", "main.tsx"),
  ]);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function launchTuiFromDefaultEntry(): Promise<void> {
  const entry = resolveOpenTuiEntry();
  if (!entry) {
    throw new Error(
      "OpenTUI entry not found. Run with --server or install the full UI distribution.",
    );
  }
  const entryUrl = pathToFileURL(entry).href;
  const mod = entry.endsWith(".ts") || entry.endsWith(".tsx")
    ? await (await import("tsx/esm/api")).tsImport(entryUrl, import.meta.url)
    : await import(entryUrl);
  await mod.launchTui();
}

// ------------------------------------------------------------------
// 主入口
// ------------------------------------------------------------------

/**
 * SwarmFlow CLI 主函数。
 *
 * 处理流程：
 *   1. 解析 --resume（全局会话恢复）
 *   2. 检测 --server（服务模式，跳过 TUI）
 *   3. 注册子命令（init / oauth / update / sessions / fix）
 *   4. 加载 .env、设置系统代理
 *   5. 应用待生效的更新
 *   6. 检查更新（后台）
 *   7. 确保 Provider 已配置
 *   8. 启动 TUI
 */
export async function main(argv: string[] = process.argv, deps: MainDeps = {}): Promise<void> {
  ensureWindowsUtf8Console();

  // 尽早初始化诊断日志，捕获后续每一帧的状态。
  // 通过 SWARMFLOW_LOG=1 启用；进程 panic 时也会写一行。
  initLogger();
  const log = getLogger("cli");
  log.info("main:enter", { argv: argv.slice(0, 8) });

  normalizeLegacyVersionAlias(argv);

  const homeDir = deps.homeDir ?? getSwarmflowHomeDir();

  // ─── --resume <id> 短路 ───
  // 在 Commander 解析前运行，以便会话解析的 cwd 对后续所有步骤生效。
  await maybeHandleResumeFlag(argv, deps.findSessionById);

  // --session：管理全局历史会话，完成后退出，不启动 TUI。
  if (argv.includes("--session")) {
    process.stdout.write("\x1Bc");
    await interactiveGlobalSessionManager(homeDir);
    return;
  }

  // ─── 服务模式短路 ───
  // GUI（Electron 主进程）以此参数派生进程。
  if (argv.includes("--server")) {
    log.info("server:short-circuit", { workDirFlag: argv.includes("--work-dir") });
    const args = argv.slice(2);
    const getFlag = (name: string): string | undefined => {
      const idx = args.indexOf(name);
      return idx >= 0 ? args[idx + 1] : undefined;
    };
    const workDir = getFlag("--work-dir") ?? process.cwd();
    const sessionId = getFlag("--session-id");
    const selectedModel = getFlag("--model");
    const selectedAgent = getFlag("--agent");
    const templates = getFlag("--templates");
    const configOverrides: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if ((args[i] === "--config" || args[i] === "-c") && args[i + 1]) {
        configOverrides.push(args[i + 1]!);
        i += 1;
      }
    }
    // 提前验证配置覆盖，使错误信息清晰而非崩溃堆栈。
    parseConfigOverridesOrExit(configOverrides);
    const runServerMode = deps.runServerMode ?? (await import("./server/server-mode.js")).runServerMode;
    try {
      await runServerMode({ workDir, sessionId, selectedModel, selectedAgent, templates, configOverrides });
    } catch (err) {
      process.stderr.write(
        `[swarmflow --server] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }

  // ─── 子命令注册 ───
  const program = new Command();
  program
    .name("swarmflow")
    .version(VERSION, "-V, --version", "Output the current version")
    .description("A terminal AI coding agent built for long sessions")
    .option("--templates <path>", "Path to prompts/templates directory")
    .option("-c, --config <key=value>", "Override a setting for this process", (value, previous: string[]) => {
      previous.push(value);
      return previous;
    }, [])
    .option("--verbose", "Enable debug logging");

  let ranSubcommand = false;

  // init：初始化配置
  program
    .command("init")
    .description("Initialize swarmflow configuration")
    .action(async () => {
      ranSubcommand = true;
      const runInitWizard = deps.runInitWizard ?? (await import("./lifecycle/init-wizard.js")).runInitWizard;
      await runInitWizard(homeDir);
    });

  // oauth：OAuth 登录管理（Codex / Copilot）
  program
    .command("oauth [action] [service]")
    .description("Manage OAuth login for Codex or Copilot (login/status/logout)")
    .action(async (action?: string, service?: string) => {
      ranSubcommand = true;
      const { oauthCommand } = await import("./auth/oauth-command.js");
      await oauthCommand(action, service);
    });

  // fix：修复会话存储（缺少 project.json / meta.json 时）
  program
    .command("fix")
    .description("Check and repair session storage (missing project.json / meta.json)")
    .action(() => {
      ranSubcommand = true;
      console.log("Checking session storage...\n");
      const result = fixStorage();
      console.log(`Projects checked: ${result.projectsChecked}`);
      console.log(`Projects fixed:   ${result.projectsFixed}`);
      console.log(`Sessions checked: ${result.sessionsChecked}`);
      console.log(`Sessions fixed:   ${result.sessionsFixed}`);
      if (result.warnings.length > 0) {
        console.log(`\nWarnings:`);
        for (const w of result.warnings) {
          console.log(`  - ${w}`);
        }
      }
      if (result.projectsFixed === 0 && result.sessionsFixed === 0) {
        console.log("\nAll good — no repairs needed.");
      } else {
        console.log(`\nDone — repaired ${result.projectsFixed + result.sessionsFixed} items.`);
      }
    });

  // sessions：列出项目保存的会话
  program
    .command("sessions")
    .description("List saved sessions for a project directory")
    .option("--json", "Output as JSON")
    .option("--work-dir <path>", "Project directory (defaults to cwd)")
    .action(async (opts: { json?: boolean; workDir?: string }) => {
      ranSubcommand = true;
      const { SessionStore } = await import("./config/session-store.js");
      const projectPath = opts.workDir ? resolve(opts.workDir) : process.cwd();
      const store = new SessionStore({ projectPath });
      const sessions = store.listSessions();
      if (opts.json) {
        process.stdout.write(JSON.stringify(sessions) + "\n");
      } else {
        for (const s of sessions) {
          console.log(`${s.sessionId}  ${s.title || s.summary || "(untitled)"}  (${s.turns} turns)`);
        }
      }
    });

  // 默认 action（防止无子命令时 Commander 显示帮助并退出）
  program.action(() => {});

  // 在派发任何子命令前加载 ~/.swarmflow/.env，
  // 使 init 能检测之前保存的密钥并提供复用选项。
  (deps.loadDotenv ?? loadDotenv)(homeDir);

  // 将 OS 系统代理规范化为 HTTP(S)_PROXY。
  // Node 的 fetch 不会自动读取 Windows 系统代理；
  // 没有这一行，无代理环境变量设置的用户会在阻塞主机上挂起。
  // 在 dotenv 之后运行，明确的 .env 代理优先。
  applySystemProxyToEnv();

  await program.parseAsync(argv);

  // 子命令已运行则退出，不继续进入 TUI。
  if (ranSubcommand) return;

  const opts = program.opts<{
    templates?: string;
    config?: string[];
    verbose?: boolean;
  }>();

  parseConfigOverridesOrExit(opts.config ?? []);

  // 调试日志
  if (opts.verbose) {
    const origDebug = console.debug;
    console.debug = (...args: unknown[]) => origDebug("[DEBUG]", ...args);
  }

  const globalSettings = await ensureProvidersConfigured(homeDir, deps);
  await warnIfCopilotCredentialsMissing(globalSettings, deps.hasGitHubTokens);

  // 诊断日志：settings.diagnostics === true 时打开 OpenTUI 的 JSONL 诊断。
  // 必须在 launchTui() 之前落好 —— main.tsx 靠 OPENTUI_DIAG 判断要不要
  // resetOpenTuiDiagLog()，而 fork 里的 writeOpenTuiDiag 每次都读这个开关。
  // 显式的 OPENTUI_DIAG 环境变量优先，方便临时打开/关闭而不改配置文件。
  if (globalSettings.diagnostics === true && !process.env.OPENTUI_DIAG) {
    process.env.OPENTUI_DIAG = "1";
  }

  await (deps.launchTui ?? launchTuiFromDefaultEntry)();
}

/** 规范化为真实路径（解析符号链接）。 */
function normalizeEntryPath(pathValue: string | undefined): string | null {
  if (!pathValue) return null;
  try {
    return realpathSync(resolve(pathValue));
  } catch {
    return null;
  }
}

/** 仅在直接执行时运行 main（而非被导入时）。 */
const entryPath = normalizeEntryPath(process.argv[1]);
const modulePath = normalizeEntryPath(fileURLToPath(import.meta.url));
if (entryPath && modulePath && entryPath === modulePath) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
