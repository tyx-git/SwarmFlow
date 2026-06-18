/**
 * POSIX shell provider 鈥?used on macOS and Linux.
 *
 * Resolves to bash when available (matches LLM expectations, which
 * are trained on bash syntax). Falls back to `/bin/sh` on systems
 * without bash (e.g. Alpine without `apk add bash`).
 *
 * Process-group kill semantics: every spawn is detached so the child
 * becomes a process-group leader; the entire tree is then reaped via
 * `process.kill(-pid, signal)`. This handles long-running shells
 * whose grandchildren (vite under `npm run dev`, etc.) would
 * otherwise be orphaned.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ShellProvider, ShellSpawnRequest } from "../types.js";

// Env names forwarded to the child shell. macOS + Linux share this
// list 鈥?macOS just lacks most of the X11/Wayland/DBus entries
// naturally, so forwarding them is a no-op there. The intent is "the
// minimum set so common tools work" without leaking secrets like
// OPENAI_API_KEY.
//
// Anything matching the prefix `LC_*` is also forwarded
// (locale-collation variants 鈥?too many to list explicitly).
const POSIX_ENV_ALLOWLIST = new Set([
  // POSIX base
  "PATH", "HOME", "SHELL", "TERM", "COLORTERM",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TMPDIR", "TMP", "TEMP",
  "PWD", "USER", "LOGNAME", "TZ",

  // Color / terminal preferences
  "NO_COLOR", "FORCE_COLOR", "CI",

  // XDG directory spec
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",

  // SSH agent / session 鈥?needed for `git push`, `ssh`, `scp`, `rsync`
  "SSH_AUTH_SOCK", "SSH_CLIENT", "SSH_TTY", "SSH_CONNECTION",

  // GUI (Linux). Harmless on macOS where they're absent.
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY",

  // DBus session bus 鈥?secret-tool, notify-send, gsettings, etc.
  "DBUS_SESSION_BUS_ADDRESS",

  // GPG (signing commits, decrypting `pass` entries)
  "GPG_AGENT_INFO", "GNUPGHOME",

  // Man / pkg-config 鈥?LLM may run `man`, `pkg-config`
  "MANPATH", "INFOPATH", "PKG_CONFIG_PATH",
]);

function resolveShellPath(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  // Last-resort fallback. On Alpine without bash this lands on
  // busybox sh; LLM-written bashisms will fail but swarmflow itself
  // still runs.
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
  // Always provide a reasonable PATH if the parent has none.
  if (!env["PATH"]) {
    env["PATH"] = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return env;
}

export const posixShell: ShellProvider = {
  kind: SHELL_PATH.endsWith("/sh") ? "sh" : "bash",
  path: SHELL_PATH,

  spawn(request: ShellSpawnRequest): ChildProcess {
    // `-lc` for login shell (background-shell-manager wants user
    // rc-file sourcing); `-c` for one-shot commands.
    const flag = request.loginShell ? "-lc" : "-c";

    return spawn(SHELL_PATH, [flag, request.command], {
      cwd: request.cwd,
      env: request.env ?? buildEnv(),
      stdio: request.stdio ?? ["pipe", "pipe", "pipe"],
      // `detached: true` puts the child in its own process group
      // (pgid == pid). killTree() can then signal the whole tree
      // via `process.kill(-pid, ...)`.
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
        // Group kill can fail if the child already died, on platforms
        // where pgid != pid, or under mocks; fall through to a direct
        // leader kill below.
      }
    }
    // Direct kill is used both when pid is unavailable (tests pass
    // mocked ChildProcess shapes without a pid) and as a fallback
    // when the group kill above raised.
    try { child.kill(signal); } catch {}
  },

  buildChildEnv: buildEnv,
};
