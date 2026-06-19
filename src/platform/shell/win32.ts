/**
 * Windows shell provider — 带自动回退的多 shell。
 *
 * 检测优先级：
 *   1. Git Bash（来自 Git for Windows 的 MSYS2 后备 bash）
 *   2. pwsh（PowerShell 7+，跨平台）
 *   3. powershell（Windows PowerShell 5.1，随 Windows 10+ 提供）
 *
 * Git Bash 是首选，因为 LLM 训练于 bash 语法，现有
 * 的 tree-sitter-bash 权限分类器无需更改即可工作。
 * 当 Git Bash 不可用时，我们回退到 PowerShell，这样没有
 * Git for Windows 的用户仍然可以使用 swarmflow。
 *
 * 进程树终止使用 `taskkill /T /F /PID <pid>`，它
 * 通过 parent-pid 关系遍历后代树。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ShellKind, ShellProvider, ShellSpawnRequest } from "../types.js";

// ------------------------------------------------------------------
// Env allowlists
// ------------------------------------------------------------------

// 所有 shell 类型共享的 Windows 环境变量。
const WIN32_ENV_BASE = new Set([
  // 核心路径
  "PATH", "PATHEXT", "HOME",
  // Windows 安装根目录
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "PROGRAMW6432",
  "COMSPEC",
  // 用户位置
  "USERPROFILE", "HOMEPATH", "HOMEDRIVE",
  "APPDATA", "LOCALAPPDATA",
  // 临时文件
  "TEMP", "TMP", "TMPDIR",
  // 区域/终端
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TERM", "COLORTERM", "TZ",
  // 颜色/CI
  "NO_COLOR", "FORCE_COLOR", "CI",
  // 用户名/登录
  "USER", "USERNAME", "LOGONSERVER",
]);

// 仅在 shell 是 Git Bash (MSYS2) 时相关的额外变量。
const MSYS2_EXTRAS = new Set([
  "MSYSTEM", "MSYS", "MSYS2_ARG_CONV_EXCL", "SHELL",
]);

// 仅在 shell 是 PowerShell 时相关的额外变量。
const POWERSHELL_EXTRAS = new Set([
  "PSMODULEPATH",
]);

// ------------------------------------------------------------------
// 检测：Git Bash
// ------------------------------------------------------------------

function detectGitBash(): string | null {
  // 1. 显式覆盖
  const override = process.env["SWARMFLOW_GIT_BASH_PATH"];
  if (override && existsSync(override)) return override;

  // 2. PATH 上的 git.exe → 派生 <git-dir>/../../bin/bash.exe
  try {
    const result = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const gitPath = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (gitPath) {
        const gitRoot = dirname(dirname(gitPath));
        const candidate = join(gitRoot, "bin", "bash.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // `where` 可能在异常环境下失败；继续。
  }

  // 3. 常见安装位置
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  if (process.env["PROGRAMFILES"]) {
    candidates.push(join(process.env["PROGRAMFILES"], "Git", "bin", "bash.exe"));
  }
  if (process.env["PROGRAMFILES(X86)"]) {
    candidates.push(join(process.env["PROGRAMFILES(X86)"], "Git", "bin", "bash.exe"));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return null;
}

// ------------------------------------------------------------------
// 检测：PowerShell
// ------------------------------------------------------------------

function detectPwsh(): string | null {
  try {
    const result = spawnSync("where", ["pwsh"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const path = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (path && existsSync(path)) return path;
    }
  } catch { /* 继续 */ }
  return null;
}

function detectPowerShell(): string | null {
  try {
    const result = spawnSync("where", ["powershell"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const path = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (path && existsSync(path)) return path;
    }
  } catch { /* 继续 */ }

  // powershell.exe 随 Windows 10+ 附送在已知路径。
  const systemRoot = process.env["SYSTEMROOT"] ?? "C:\\Windows";
  const fallback = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(fallback)) return fallback;

  return null;
}

// ------------------------------------------------------------------
// Shell 解析
// ------------------------------------------------------------------

interface ResolvedShell {
  kind: ShellKind;
  path: string;
}

function resolveShell(): ResolvedShell {
  if (process.platform !== "win32") {
    return { kind: "bash", path: "win32-shell-not-active-on-this-platform" };
  }

  const gitBash = detectGitBash();
  if (gitBash) return { kind: "bash", path: gitBash };

  const pwsh = detectPwsh();
  if (pwsh) return { kind: "pwsh", path: pwsh };

  const ps = detectPowerShell();
  if (ps) return { kind: "powershell", path: ps };

  throw new Error(
    "swarmflow on Windows 需要以下之一：Git Bash、PowerShell 7+ (pwsh) 或 Windows PowerShell。\n" +
    "  —Git Bash（推荐）：https://git-scm.com/download/win\n" +
    "  —PowerShell 7+：https://aka.ms/powershell\n" +
    "已尝试：git bash（未找到），pwsh（未找到），powershell（未找到）。",
  );
}

/** 解析的 shell 是否为 PowerShell 变体。*/
function isPowerShell(kind: ShellKind): boolean {
  return kind === "pwsh" || kind === "powershell";
}

/**
 * PowerShell 命令的第一个真实语句是否为 `using` 或
 * 顶级 `param(...)` 块。两者都必须优先于其他所有语句
 *（只有空行、注释和 `#requires` 可以在它们之前），因此
 * 向这样的命令预先添加 OutputEncoding 语句会引发解析
 * 错误（"Using 语句必须出现在任何其他语句之前"）。当
 * 此时为 true，我们保持命令不变（接受其非 ASCII
 * 输出可能乱码）而不是破坏它。`#requires` 故意
 * 不包括：PowerShell 无论位置如何都会计算它，因此前缀
 * 不会破坏它。
 */
function leadsWithFirstStatementConstruct(command: string): boolean {
  for (const rawLine of command.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue; // blanks, comments, #requires
    return /^(?:using\b|param[ \t]*\()/i.test(line);
  }
  return false;
}

const RESOLVED: ResolvedShell = resolveShell();

// ------------------------------------------------------------------
// 环境过滤
// ------------------------------------------------------------------

function buildEnv(): NodeJS.ProcessEnv {
  const extras = isPowerShell(RESOLVED.kind) ? POWERSHELL_EXTRAS : MSYS2_EXTRAS;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    const upper = key.toUpperCase();
    if (WIN32_ENV_BASE.has(upper) || extras.has(upper) || upper.startsWith("LC_")) {
      env[key] = value;
    }
  }
  // 仅在继承的 env 没有 PATH 时才合成 PATH。守卫
  // 必须是大小写不敏感：Windows 将变量存储为 "Path"，
  // 因此它通过该精确键转发，而大小写敏感的
  // `env["PATH"]` 在此普通对象上查找总是错过它并
  // 注入第二个、最小 PATH 键。子进程然后会看到两个
  // 大小写等效的键（Path=<完整>，PATH=<仅 System32>），且
  // spawn 层的，大小写不敏感去重可能让截断的胜出，
  // 从 shell 中隐藏 git/node/etc.
  const hasPath = Object.keys(env).some((k) => k.toUpperCase() === "PATH");
  if (!hasPath) {
    env["PATH"] = "C:\\Windows\\System32;C:\\Windows";
  }
  return env;
}

// ------------------------------------------------------------------
// Provider
// ------------------------------------------------------------------

export const win32Shell: ShellProvider = {
  kind: RESOLVED.kind,
  path: RESOLVED.path,

  spawn(request: ShellSpawnRequest): ChildProcess {
    if (isPowerShell(RESOLVED.kind)) {
      // PowerShell：-NoLogo 抑制启动横幅，
      // -NoProfile 跳过用户配置文件脚本（确定性 env），
      // -NonInteractive 防止提示阻止子进程。
      //
      // Windows PowerShell 5.1 和 pwsh 7+ 都使用 [Console]::OutputEncoding
      // 对重定向的 stdout 进行编码，该编码仍默认为
      // stock Windows 安装上的 OEM/ANSI 代码页（pwsh 7 仅更改
      // $OutputEncoding，即输入到本机命令的编码——不是
      // 控制捕获 stdout 的控制台输出编码）。非 ASCII
      // 输出（CJK、框绘制、重音）在
      // 收集器将捕获的字节解码为 UTF-8 时会乱码。通过
      // 无参数构造器强制 UTF-8（无 BOM）用于每个 PowerShell
      // 变体。检测在 powershell 之前尝试 pwsh，因此对
      // 窄 kind==="powershell" 进行门控会让常见的
      // pwsh 安装盒子乱码。当命令以必须保持领先的
      // using/param 块开头时跳过此前缀（见辅助函数）。
      const command = leadsWithFirstStatementConstruct(request.command)
        ? request.command
        : `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ${request.command}`;
      return spawn(RESOLVED.path, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
      ], {
        cwd: request.cwd,
        env: request.env ?? buildEnv(),
        stdio: request.stdio ?? ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    }

    // Git Bash
    const flag = request.loginShell ? "-lc" : "-c";
    return spawn(RESOLVED.path, [flag, request.command], {
      cwd: request.cwd,
      env: request.env ?? buildEnv(),
      stdio: request.stdio ?? ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  },

  killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid != null) {
      try {
        // 始终强制（`/F`）。`signal` 参数存在是为了与 POSIX
        // provider 对称，但没有 Windows 类似物：我们生成的
        // shell（windowsHide）及其控制台孙进程（node/vite/python）
        // 没有消息泵窗口，因此 taskkill 的
        // 优雅 WM_CLOSE（省略 `/F`）无法终止它们——它
        // 退出非零，spawnSync 吞下失败，树
        // 存活。对于无窗口控制台进程，无论请求的
        // signal 如何，强制是唯一真正有效的 kill，
        // 并与此 provider 记录的行为相符。
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        return;
      } catch {
        // 回退到直接 child.kill。
      }
    }
    try { child.kill(signal); } catch {}
  },

  buildChildEnv: buildEnv,
};
