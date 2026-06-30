#!/usr/bin/env bun

/**
 * SwarmFlow CLI 入口点。
 *
 * 用法：
 *   swarmflow                       # 自动检测配置
 *   swarmflow init                  # 运行初始化向导
 *   swarmflow --templates ./tpls    # 指定模板路径
 *   swarmflow --verbose             # 启用调试日志
 *   swarmflow --resume <id>         # 恢复指定会话
 *   swarmflow --server              # 服务模式（Electron GUI 派生）
 */

import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import {
  fixStorage,
  loadGlobalSettings,
  parseSettingsOverrides,
  settingsToConfigInputs,
} from "./config/persistence.js";
import { loadDotenv } from "./lifecycle/dotenv.js";
import { applySystemProxyToEnv } from "./lib/system-proxy.js";
import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { startBackgroundRegistryRefresh } from "./providers/registry-fetch.js";
import { checkForUpdates, applyStaged, setUpdateStateGetter, setRelaunchCallback } from "./lifecycle/update-check.js";
import { VERSION } from "./version.js";
import { hasAnyManagedCredential } from "./config/managed-provider-credentials.js";
import { findSessionById, findSessionByName, listSessionsForProject, formatSize } from "./session-resume.js";

/**
 * main() 的依赖注入表面。
 * 允许测试替换各环节实现（loadDotenv、checkForUpdates 等）。
 */
export interface MainDeps {
  launchTui?: () => Promise<void>;
  homeDir?: string;
  loadDotenv?: (homeDir?: string) => void;
  loadGlobalSettings?: typeof loadGlobalSettings;
  applyStaged?: typeof applyStaged;
  checkForUpdates?: typeof checkForUpdates;
  relaunchAfterUpdate?: (argv: string[]) => void;
  runInitWizard?: () => Promise<unknown>;
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
  hasAnyManagedCredential?: typeof hasAnyManagedCredential;
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
 * 用当前二进制重新启动自身（用于更新后的热重启）。
 * 保留原 argv，去掉 bun 路径前缀或 node 路径前缀。
 */
function relaunchCurrentBinary(argv: string[]): void {
  const relaunchArgs = argv.length > 0 && argv[0] === process.execPath
    ? argv.slice(1)
    : argv.slice(2);
  const result = spawnSync(process.execPath, relaunchArgs, {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 0);
}

/**
 * 启动居中过渡动画 — 用户按下回车后立即调用。
 * 返回清理函数，launchTui() 在 TUI 启动前调用它。
 */
function startResumeAnimation(): void {
  const termWidth = process.stdout.columns || 80;
  const termHeight = process.stdout.rows || 24;
  const paddingTop = Math.max(1, Math.floor((termHeight / 2) - 1));

  const spinFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinIdx = 0;
  const label = "recalling session...";

  function renderFrame(): string {
    const lines: string[] = [];
    for (let i = 0; i < paddingTop; i++) lines.push("");
    const spinChar = spinFrames[spinIdx % spinFrames.length];
    const text = `${spinChar}  ${label}`;
    const pad = Math.max(0, Math.floor((termWidth - text.length) / 2));
    lines.push(`${" ".padEnd(pad)}\x1B[90m${spinChar}\x1B[0m  \x1B[36m${label}\x1B[0m`);
    return lines.join("\n");
  }

  process.stdout.write("\x1B[?25l");
  process.stdout.write("\x1B[2J\x1B[H");
  process.stdout.write(renderFrame());

  const animInterval = setInterval(() => {
    spinIdx = (spinIdx + 1) % spinFrames.length;
    process.stdout.write(`\x1B[${paddingTop + 1};1H\x1B[2K`);
    process.stdout.write(renderFrame());
  }, 100);

  (process as any).__resumeAnimCleanup = () => {
    clearInterval(animInterval);
    process.stdout.write("\x1B[?25h");
    process.stdout.write("\x1B[2J\x1B[H");
    delete (process as any).__resumeAnimCleanup;
  };
}

/**
 * 在 Commander 解析 argv 之前处理 `swarmflow --resume [id/name]`。
 *
 * 支持三种模式：
 *   --resume          显示当前项目的会话列表，交互式选择
 *   --resume <name>   按名称（title/summary）或 UUID 匹配会话
 *   --resume <uuid>   按 UUID 匹配（兼容原有行为）
 *
 * 成功后将会话目录存入环境变量，launchTui() 可在引导后调用 applySessionRestore。
 * --resume 及其参数从 argv 中拼接，以免 Commander 看到它们。
 */
async function maybeHandleResumeFlag(
  argv: string[],
  findSession: typeof findSessionById = findSessionById,
): Promise<void> {
  const idx = argv.indexOf("--resume");
  if (idx < 0) return;

  const nextArg = argv[idx + 1];
  const hasArg = nextArg && !nextArg.startsWith("--");

  // --resume 不带参数：交互式选择当前项目会话
  if (!hasArg) {
    const { projectDir } = await getCurrentProjectInfo();
    const sessions = listSessionsForProject(projectDir);

    if (sessions.length === 0) {
      console.error("No previous sessions in this project.");
      argv.splice(idx, 1);
      return;
    }

    // 清空终端
    process.stdout.write("\x1Bc");

    // Design A: Separator Lines
    const selected = await interactiveSessionSelect(sessions);
    if (selected < 0) {
      // 用户按了 Esc 或 Ctrl+C
      argv.splice(idx, 1);
      return;
    }

    const chosen = sessions[selected];
    process.env["SWARMFLOW_RESUME_SESSION_DIR"] = chosen.path;

    // 立即启动过渡动画 — 用户按下回车后第一件事
    startResumeAnimation();

    argv.splice(idx, 1);
    return;
  }

  // --resume <argument>
  const id = nextArg;

  // 1. 尝试 UUID 匹配（所有项目）
  let found = findSession(id);
  if (!found) {
    // 2. 尝试名称匹配（当前项目）
    const { projectDir } = await getCurrentProjectInfo();
    const byName = findSessionByName(id, projectDir);
    if (byName) {
      // 构造 FoundSession 结构
      const { projectPath } = readProjectMeta(projectDir);
      found = { sessionDir: byName.path, projectDir, projectPath, title: byName.title };
    }
  }

  if (!found) {
    console.error(`Error: session not found: ${id}`);
    console.error("Tip: use 'swarmflow --resume' to see available sessions.");
    process.exit(1);
  }

  const cwd = process.cwd();
  if (found.projectPath && found.projectPath !== cwd) {
    let willCd: boolean;
    try {
      const { confirm } = await import("@inquirer/prompts");
      willCd = await confirm({
        message: `This session lives in ${found.projectPath}.\n  Switch to that directory and resume?`,
        default: true,
      });
    } catch {
      process.exit(130); // 用户 Ctrl+C
    }
    if (!willCd) process.exit(0);
    try {
      process.chdir(found.projectPath);
    } catch (e) {
      console.error(`Error: failed to chdir to ${found.projectPath}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  process.env["SWARMFLOW_RESUME_SESSION_DIR"] = found.sessionDir;

  // 立即启动过渡动画
  startResumeAnimation();

  argv.splice(idx, 2);
}

/** 获取当前项目的 projectDir 和 projectPath。 */
async function getCurrentProjectInfo(): Promise<{ projectDir: string; projectPath: string }> {
  const cwd = process.cwd();
  const { projectSlug } = await import("./config/persistence.js");
  const slug = projectSlug(cwd);
  const { join } = await import("node:path");
  const projectDir = join(getSwarmflowHomeDir(), "projects", slug);
  return { projectDir, projectPath: cwd };
}

/** 从 project.json 读取 projectPath。 */
function readProjectMeta(projectDir: string): { projectPath: string | undefined } {
  try {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const raw = JSON.parse(readFileSync(join(projectDir, "project.json"), "utf-8"));
    return { projectPath: typeof raw.original_path === "string" ? raw.original_path : undefined };
  } catch {
    return { projectPath: undefined };
  }
}

/** 格式化时间为 "X mins ago" 风格。 */
function formatAge(isoString: string | undefined): string {
  if (!isoString) return "unknown";
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) return "unknown";
  const delta = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (delta < 60) return delta <= 1 ? "just now" : `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return mins === 1 ? "1 min ago" : `${mins} mins ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** 格式化会话选择项。 */
function formatSessionChoice(s: { title?: string; summary: string; lastActiveAt: string; turns: number }): string {
  const label = s.title || s.summary.slice(0, 50) || "(untitled)";
  const age = formatAge(s.lastActiveAt);
  return `${label}  \x1B[90m${s.turns} turns \xb7 ${age}\x1B[0m`;
}

/**
 * 交互式会话选择器 — 使用 readline 实现完全控制的 UI。
 * Design A: Separator Lines 风格。
 * 返回选中的索引，Esc/Ctrl+C 返回 -1。
 */
async function interactiveSessionSelect(
  sessions: Array<{ title?: string; summary: string; lastActiveAt: string; turns: number; path: string; sizeBytes: number }>,
): Promise<number> {
  const { stdin, stdout } = process;

  const maxShow = Math.min(sessions.length, 5);
  let selected = 0;

  // 隐藏光标
  stdout.write("\x1B[?25l");

  const render = () => {
    // 清空屏幕
    stdout.write("\x1B[2J\x1B[H");

    const cols = stdout.columns || 80;
    const margin = 4; // 左右边距
    const lineLen = cols - margin * 2;

    const line = (i: number) => {
      const s = sessions[i];
      const label = s.title || s.summary.slice(0, 40) || "(untitled)";
      const age = formatAge(s.lastActiveAt);
      const size = formatSize(s.sizeBytes);
      const subtitle = `${age} · ${size} · ${s.turns} turns`;

      if (i === selected) {
        // 选中行：> 指示器 + 粗体
        return [
          `${" ".repeat(margin)}\x1B[38;2;122;162;247m>\x1B[0m \x1B[1;37m${label}\x1B[0m`,
          `${" ".repeat(margin + 3)}\x1B[90m${subtitle}\x1B[0m`,
        ].join("\n");
      } else {
        return [
          `${" ".repeat(margin)}  \x1B[37m${label}\x1B[0m`,
          `${" ".repeat(margin + 3)}\x1B[90m${subtitle}\x1B[0m`,
        ].join("\n");
      }
    };

    // 标题：居中 + 大字体
    const titleText = "[ Recent Sessions ]";
    const titlePad = Math.max(0, Math.floor((cols - titleText.length) / 2));

    stdout.write("\n");
    stdout.write(`${" ".repeat(margin)}\x1B[90m${"━".repeat(lineLen)}\x1B[0m\n`);
    stdout.write(`${" ".repeat(titlePad)}\x1B[1;38;2;187;154;247m${titleText}\x1B[0m\n`);
    stdout.write(`${" ".repeat(margin)}\x1B[90m${"━".repeat(lineLen)}\x1B[0m\n`);
    stdout.write("\n");

    for (let i = 0; i < maxShow; i++) {
      stdout.write(line(i) + "\n");
      if (i < maxShow - 1) stdout.write("\n");
    }

    stdout.write("\n");
    stdout.write(`${" ".repeat(margin)}\x1B[90m↑↓ Navigate · Enter Resume · Esc Cancel\x1B[0m\n`);
  };

  render();

  return new Promise<number>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      stdin.removeListener("data", onData);
      if (stdin.isRaw) stdin.setRawMode(false);
      stdout.write("\x1B[?25h"); // 显示光标
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    // 缓冲区用于检测 Esc 序列
    let escBuffer = "";
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const onData = (key: string) => {
      if (resolved) return;

      // 处理 Esc 序列（箭头键等）
      if (key.startsWith("\x1B")) {
        escBuffer += key;
        if (escTimer) clearTimeout(escTimer);

        // 检查是否是完整的箭头键序列
        if (escBuffer === "\x1B[A") {
          selected = (selected - 1 + maxShow) % maxShow;
          render();
          escBuffer = "";
          return;
        } else if (escBuffer === "\x1B[B") {
          selected = (selected + 1) % maxShow;
          render();
          escBuffer = "";
          return;
        }

        // 等待更多字符
        escTimer = setTimeout(() => {
          // 超时：不是箭头键，检查是否是单独的 Esc
          if (escBuffer === "\x1B") {
            cleanup();
            resolve(-1);
          }
          escBuffer = "";
        }, 30);
        return;
      }

      // 非 Esc 字符
      if (escTimer) clearTimeout(escTimer);
      escBuffer = "";

      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(selected);
      } else if (key === "\x03") {
        cleanup();
        resolve(-1);
      }
    };

    stdin.on("data", onData);
  });
}

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

/** 检查是否已配置至少一个 Provider。 */
function hasConfiguredProviders(
  settings: ReturnType<typeof loadGlobalSettings>,
  hasManagedCredential: typeof hasAnyManagedCredential = hasAnyManagedCredential,
): boolean {
  const { providerEnvVars, localProviders } = settingsToConfigInputs(settings);
  return (
    Object.keys(providerEnvVars).length > 0
    || Object.keys(localProviders).length > 0
    || hasManagedCredential()
  );
}

/**
 * 确保已配置 Provider。
 * 若未配置且用户未提供凭证，启动初始化向导。
 */
async function ensureProvidersConfigured(
  homeDir: string,
  deps: Pick<MainDeps, "loadGlobalSettings" | "runInitWizard" | "hasAnyManagedCredential">,
): Promise<ReturnType<typeof loadGlobalSettings>> {
  const loadSettings = deps.loadGlobalSettings ?? loadGlobalSettings;
  const hasManagedCredential = deps.hasAnyManagedCredential ?? hasAnyManagedCredential;
  let globalSettings = loadSettings(homeDir);
  if (hasConfiguredProviders(globalSettings, hasManagedCredential)) return globalSettings;

  console.log("No providers configured. Starting setup wizard...\n");
  try {
    const runInitWizard = deps.runInitWizard ?? (await import("./lifecycle/init-wizard.js")).runInitWizard;
    await runInitWizard();
  } catch {
    console.error(
      "Error: no providers configured.\n" +
      "  Run 'swarmflow init' to set up providers.",
    );
    process.exit(1);
  }

  globalSettings = loadSettings(homeDir);
  if (!hasConfiguredProviders(globalSettings, hasManagedCredential)) {
    console.error(
      "Error: no providers configured.\n" +
      "  Run 'swarmflow init' to set up providers.",
    );
    process.exit(1);
  }
  return globalSettings;
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
async function launchTuiFromDefaultEntry(): Promise<void> {
  const opentuiEntry = "../external/opentui/main.js";
  const mod = (await import(opentuiEntry)) as { launchTui: () => Promise<void> };
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
  normalizeLegacyVersionAlias(argv);

  const homeDir = deps.homeDir ?? getSwarmflowHomeDir();

  // ─── --resume <id> 短路 ───
  // 在 Commander 解析前运行，以便会话解析的 cwd 对后续所有步骤生效。
  await maybeHandleResumeFlag(argv, deps.findSessionById);

  // ─── 服务模式短路 ───
  // GUI（Electron 主进程）以此参数派生进程。
  if (argv.includes("--server")) {
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
      await runInitWizard();
    });

  // oauth：OAuth 登录管理（Codex / Copilot）
  program
    .command("oauth [action] [service]")
    .description("Manage OAuth login for Codex or Copilot (login/status/logout)")
    .action(async (action?: string, service?: string) => {
      ranSubcommand = true;
      const { oauthCommand } = await import("./auth/openai-oauth.js");
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
      const { SessionStore } = await import("./config/persistence.js");
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

  // update：检查并安装更新
  program
    .command("update")
    .description("Check for and install the latest version")
    .option("--check", "Check for updates without installing")
    .action(async (opts: { check?: boolean }) => {
      ranSubcommand = true;
      if (opts.check) {
        const { runUpdateCheck } = await import("./lifecycle/update-check.js");
        await runUpdateCheck(VERSION);
      } else {
        const { runUpdate } = await import("./lifecycle/update-check.js");
        await runUpdate(VERSION);
      }
    });

  // 默认 action（防止无子命令时 Commander 显示帮助并退出）
  program.action(() => {});

  // 在派发任何子命令前加载 ~/.swarmflow/.env，
  // 使 init 能检测之前保存的密钥并提供复用选项。
  (deps.loadDotenv ?? loadDotenv)(homeDir);

  // 将 OS 系统代理规范化为 HTTP(S)_PROXY。
  // Bun 的 fetch 读取这些环境变量但忽略 Windows 系统代理；
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

  // 应用后台下载的待生效更新
  const applyResult = (deps.applyStaged ?? applyStaged)(homeDir);
  if (applyResult.kind === "applied") {
    if (deps.relaunchAfterUpdate) {
      deps.relaunchAfterUpdate(argv);
      return;
    }
    if (!deps.applyStaged) {
      relaunchCurrentBinary(argv);
      return;
    }
  }
  const effectiveVersion = applyResult.kind === "applied"
    ? (applyResult.version ?? VERSION)
    : VERSION;

  // 若启用，后台启动更新检查（非阻塞）
  const loadSettings = deps.loadGlobalSettings ?? loadGlobalSettings;
  const autoUpdateSetting = loadSettings(homeDir).auto_update ?? true;
  if (autoUpdateSetting !== false) {
    const getter = (deps.checkForUpdates ?? checkForUpdates)(effectiveVersion, homeDir, autoUpdateSetting);
    setUpdateStateGetter(getter);
  }
  setRelaunchCallback(() => {
    if (deps.relaunchAfterUpdate) {
      deps.relaunchAfterUpdate(argv);
    } else {
      relaunchCurrentBinary(argv);
    }
  });

  // 调试日志
  if (opts.verbose) {
    const origDebug = console.debug;
    console.debug = (...args: unknown[]) => origDebug("[DEBUG]", ...args);
  }

  const globalSettings = await ensureProvidersConfigured(homeDir, deps);
  await warnIfCopilotCredentialsMissing(globalSettings, deps.hasGitHubTokens);

  // 最佳生效非阻塞：为下次启动预热远程模型注册表。
  startBackgroundRegistryRefresh();

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
