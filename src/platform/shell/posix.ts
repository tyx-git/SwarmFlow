/**
 * POSIX shell provider — 在 macOS 和 Linux 上使用。
 *
 * 解析到 bash（当可用时，与 LLM 期望匹配，LLM
 * 训练于 bash 语法）。在没有 bash 的系统上
 *（例如没有 `apk add bash` 的 Alpine）回退到 `/bin/sh`。
 *
 * 进程组 kill 语义：每次 spawn 都是分离的，因此子进程
 * 成为进程组 leader；整个树然后通过
 * `process.kill(-pid, signal)` 回收。这处理长期运行的
 * shell 及其孙进程（`npm run dev` 下的 vite 等）否则会
 * 成为孤儿。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ShellProvider, ShellSpawnRequest } from "../types.js";

// 转发到子 shell 的环境变量名称。macOS + Linux 共享此列表
// ——macOS 只是自然缺少大多数 X11/Wayland/DBus 条目，
// 因此转发它们在那里是 no-op。意图是"最小集合以使常见工具工作"，
// 而不泄漏像 OPENAI_API_KEY 这样的秘密。
//
// 任何匹配前缀 `LC_*` 的也被转发
//（区域排序变体——太多无法一一列出）。
const POSIX_ENV_ALLOWLIST = new Set([
  // POSIX 基础
  "PATH", "HOME", "SHELL", "TERM", "COLORTERM",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TMPDIR", "TMP", "TEMP",
  "PWD", "USER", "LOGNAME", "TZ",

  // 颜色 / 终端偏好
  "NO_COLOR", "FORCE_COLOR", "CI",

  // XDG 目录规范
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",

  // SSH agent / session — 需要用于 `git push`、`ssh`、`scp`、`rsync`
  "SSH_AUTH_SOCK", "SSH_CLIENT", "SSH_TTY", "SSH_CONNECTION",

  // GUI（Linux）。在 macOS 上无害，因为它们不存在。
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY",

  // DBus session 总线 — secret-tool、notify-send、gsettings 等。
  "DBUS_SESSION_BUS_ADDRESS",

  // GPG（签名提交、解密 `pass` 条目）
  "GPG_AGENT_INFO", "GNUPGHOME",

  // Man / pkg-config — LLM 可能运行 `man`、`pkg-config`
  "MANPATH", "INFOPATH", "PKG_CONFIG_PATH",
]);

function resolveShellPath(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  // 最后回退。在没有 bash 的 Alpine 上会落到
  // busybox sh；LLM 编写的 bash 语法会失败但 swarmflow 本身
  // 仍然运行。
  return "/bin/sh";
}

const SHELL_PATH = resolveShellPath();

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (POSIX_ENV_ALLOWLIST.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }
  // 如果父进程没有，始终提供合理的 PATH。
  if (!env["PATH"]) {
    env["PATH"] = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return env;
}

export const posixShell: ShellProvider = {
  kind: SHELL_PATH.endsWith("/sh") ? "sh" : "bash",
  path: SHELL_PATH,

  spawn(request: ShellSpawnRequest): ChildProcess {
    // `-lc` 用于登录 shell（background-shell-manager 需要用户
    // rc-file sourcing）；`-c` 用于一次性命令。
    const flag = request.loginShell ? "-lc" : "-c";

    return spawn(SHELL_PATH, [flag, request.command], {
      cwd: request.cwd,
      env: request.env ?? buildEnv(),
      stdio: request.stdio ?? ["pipe", "pipe", "pipe"],
      // `detached: true` 将子进程放入自己的进程组
      //（pgid == pid）。killTree() 然后可以通过 `process.kill(-pid, ...)`
      // 向整个树发信号。
      detached: true,
    });
  },

  killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid != null) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // 组 kill 可能失败当子进程已死亡、在 pgid != pid 的平台上、
        // 或在 mock 下；回退到下面的直接 leader kill。
      }
    }
    // 直接 kill 用于 pid 不可用时（测试传递没有 pid 的
    // mock ChildProcess 形状）和作为回退
    // 当上面的组 kill 抛出时。
    try { child.kill(signal); } catch {}
  },

  buildChildEnv: buildEnv,
};
