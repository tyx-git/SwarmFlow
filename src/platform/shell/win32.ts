/**
 * Windows shell provider 鈥?multi-shell with automatic fallback.
 *
 * Detection priority:
 *   1. Git Bash (MSYS2-backed bash from Git for Windows)
 *   2. pwsh (PowerShell 7+, cross-platform)
 *   3. powershell (Windows PowerShell 5.1, ships with Windows 10+)
 *
 * Git Bash is preferred because LLMs are trained on bash syntax and the
 * existing tree-sitter-bash permission classifier works unchanged.
 * When Git Bash is unavailable, we fall back to PowerShell so users
 * without Git for Windows can still use swarmflow.
 *
 * Process-tree termination uses `taskkill /T /F /PID <pid>`, which
 * walks the descendant tree by parent-pid relationships.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ShellKind, ShellProvider, ShellSpawnRequest } from "../types.js";

// ------------------------------------------------------------------
// Env allowlists
// ------------------------------------------------------------------

// Shared Windows env vars needed by all shell types.
const WIN32_ENV_BASE = new Set([
  // Core paths
  "PATH", "PATHEXT", "HOME",
  // Windows installation roots
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "PROGRAMW6432",
  "COMSPEC",
  // User locations
  "USERPROFILE", "HOMEPATH", "HOMEDRIVE",
  "APPDATA", "LOCALAPPDATA",
  // Temp
  "TEMP", "TMP", "TMPDIR",
  // Locale / terminal
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TERM", "COLORTERM", "TZ",
  // Color / CI
  "NO_COLOR", "FORCE_COLOR", "CI",
  // Username / login
  "USER", "USERNAME", "LOGONSERVER",
]);

// Extra vars only relevant when the shell is Git Bash (MSYS2).
const MSYS2_EXTRAS = new Set([
  "MSYSTEM", "MSYS", "MSYS2_ARG_CONV_EXCL", "SHELL",
]);

// Extra vars only relevant when the shell is PowerShell.
const POWERSHELL_EXTRAS = new Set([
  "PSMODULEPATH",
]);

// ------------------------------------------------------------------
// Detection: Git Bash
// ------------------------------------------------------------------

function detectGitBash(): string | null {
  // 1. Explicit override
  const override = process.env["SWARMFLOW_GIT_BASH_PATH"];
  if (override && existsSync(override)) return override;

  // 2. git.exe on PATH 鈫?derive <git-dir>/../../bin/bash.exe
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
    // `where` may fail under unusual environments; fall through.
  }

  // 3. Common install locations
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
// Detection: PowerShell
// ------------------------------------------------------------------

function detectPwsh(): string | null {
  try {
    const result = spawnSync("where", ["pwsh"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const path = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (path && existsSync(path)) return path;
    }
  } catch { /* fall through */ }
  return null;
}

function detectPowerShell(): string | null {
  try {
    const result = spawnSync("where", ["powershell"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const path = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (path && existsSync(path)) return path;
    }
  } catch { /* fall through */ }

  // powershell.exe ships with Windows 10+ at a well-known path.
  const systemRoot = process.env["SYSTEMROOT"] ?? "C:\\Windows";
  const fallback = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(fallback)) return fallback;

  return null;
}

// ------------------------------------------------------------------
// Shell resolution
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
    "swarmflow on Windows requires one of: Git Bash, PowerShell 7+ (pwsh), or Windows PowerShell.\n" +
    "  鈥?Git Bash (recommended): https://git-scm.com/download/win\n" +
    "  鈥?PowerShell 7+: https://aka.ms/powershell\n" +
    "Tried: git bash (not found), pwsh (not found), powershell (not found).",
  );
}

/** Whether the resolved shell is a PowerShell variant. */
function isPowerShell(kind: ShellKind): boolean {
  return kind === "pwsh" || kind === "powershell";
}

/**
 * Whether a PowerShell command's FIRST real statement is a `using` or a
 * top-level `param(...)` block. Both MUST precede every other statement
 * (only blank lines, comments, and `#requires` may come before them), so
 * prepending the OutputEncoding statement to such a command raises a parse
 * error ("Using statement must appear before any other statements"). When
 * this is true we leave the command untouched (accepting that its non-ASCII
 * output may mojibake) rather than break it. `#requires` is intentionally
 * NOT included: PowerShell evaluates it regardless of position, so a prefix
 * doesn't break it.
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
// Env filtering
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
  // Only synthesize a PATH when the inherited env has none. The guard
  // must be case-INSENSITIVE: Windows stores the variable as "Path", so
  // it is forwarded under that exact key, and a case-sensitive
  // `env["PATH"]` lookup on this plain object would always miss it and
  // inject a second, minimal PATH key. The child would then see two
  // case-equivalent keys (Path=<full>, PATH=<System32-only>), and the
  // spawn layer's case-insensitive dedup can let the truncated one win,
  // hiding git/node/etc. from the shell.
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
      // PowerShell: -NoLogo suppresses the startup banner,
      // -NoProfile skips user profile scripts (deterministic env),
      // -NonInteractive prevents prompts blocking the subprocess.
      //
      // Both Windows PowerShell 5.1 AND pwsh 7+ encode redirected stdout
      // using [Console]::OutputEncoding, which still defaults to the
      // OEM/ANSI code page on a stock Windows install (pwsh 7 only changes
      // $OutputEncoding, the input-to-native-command encoding 鈥?not the
      // console output encoding that governs captured stdout). Non-ASCII
      // output (CJK, box-drawing, accents) then mojibakes when the
      // collector decodes the captured bytes as UTF-8. Force UTF-8 (no
      // BOM, via the parameterless ctor) up front for every PowerShell
      // variant. Detection tries pwsh BEFORE powershell, so gating on the
      // narrow kind==="powershell" would have left the common
      // pwsh-installed boxes mojibaked. Skip the prefix when the command
      // opens with a using/param block that must stay first (see helper).
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
        // Always force (`/F`). The `signal` argument exists for parity
        // with the POSIX provider but has no Windows analogue: the
        // shells we spawn (windowsHide) and their console grandchildren
        // (node/vite/python) have no message-pump window, so taskkill's
        // graceful WM_CLOSE (omitting `/F`) cannot terminate them 鈥?it
        // exits non-zero, spawnSync swallows the failure, and the tree
        // survives. Forcing is the only kill that actually works for a
        // windowless console process, regardless of the requested
        // signal, and matches this provider's documented contract.
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        return;
      } catch {
        // Fall through to direct child.kill.
      }
    }
    try { child.kill(signal); } catch {}
  },

  buildChildEnv: buildEnv,
};
