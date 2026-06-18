/**
 * Platform Abstraction Layer 鈥?provider interfaces.
 *
 * Defines every cross-platform capability swarmflow needs, with one
 * implementation per supported OS in sibling subdirectories.
 *
 * Business code imports the active provider via `src/platform/index.ts`
 * and never branches on `process.platform` directly. Windows
 * implementations are stubs that throw a clear error until they're
 * filled in.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";

// --------------------------------------------------------------------
// Shell
// --------------------------------------------------------------------

/** Identifies the shell flavour driving the `bash` tool.
 *  Business code uses this to select parser, prompt wording, and
 *  spawn arguments 鈥?never raw `process.platform` checks. */
export type ShellKind = "bash" | "sh" | "pwsh" | "powershell";

export interface ShellSpawnRequest {
  /** Command string passed via `-c` (POSIX) or `-Command` (PowerShell). */
  command: string;
  cwd?: string;
  /** Whether to spawn the shell as a login shell (POSIX `-lc`). */
  loginShell?: boolean;
  /** Override the env passed to the child. If omitted, uses the
   *  platform-default allowlist filter of `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Standard SpawnOptions overrides; usually only `stdio` is set by
   *  the caller. The provider handles `detached` and process-group
   *  semantics internally. */
  stdio?: SpawnOptions["stdio"];
}

export interface ShellProvider {
  /** Shell flavour 鈥?determines prompt wording, parser, and spawn args. */
  readonly kind: ShellKind;
  /** Absolute path to the resolved shell binary. */
  readonly path: string;

  /**
   * Spawn a command string through the platform's shell. Always
   * returns a ChildProcess whose process tree can be killed via
   * `killTree`.
   */
  spawn(request: ShellSpawnRequest): ChildProcess;

  /**
   * Kill the entire descendant tree of a child spawned by `spawn`.
   * POSIX uses the process-group signal (`process.kill(-pid, sig)`);
   * Windows uses `taskkill /T /F`.
   */
  killTree(child: ChildProcess, signal: NodeJS.Signals): void;

  /** Filter `process.env` through the platform-default allowlist. */
  buildChildEnv(): NodeJS.ProcessEnv;
}

// --------------------------------------------------------------------
// Clipboard
// --------------------------------------------------------------------

export type ClipboardImageMediaType = "image/png" | "image/jpeg" | "image/tiff";

export interface ClipboardImage {
  buffer: Buffer;
  mediaType: ClipboardImageMediaType;
}

export interface ClipboardProvider {
  /** Identifier of the active implementation, for diagnostics. */
  readonly id: string;

  /**
   * Write plain text to the system clipboard. Returns true if the
   * primary mechanism succeeded. Implementations may try multiple
   * tools (e.g. wl-copy 鈫?xclip 鈫?OSC 52) and report success on the
   * first that works.
   */
  writeText(text: string): Promise<boolean>;

  /**
   * Read an image from the system clipboard. Returns null when the
   * clipboard contains no image, when the required tool is missing,
   * or when the platform does not support clipboard image reads.
   */
  readImage(): Promise<ClipboardImage | null>;
}

// --------------------------------------------------------------------
// Browser / system file opener
// --------------------------------------------------------------------

export interface BrowserProvider {
  /** Open an http(s):// URL in the user's default browser. */
  openUrl(url: string): void;

  /**
   * Open a local file in the system's default application. On
   * darwin/linux/win this routes through the same command used for
   * `openUrl` (`open` / `xdg-open` / `start`).
   */
  openFile(path: string): void;
}

// --------------------------------------------------------------------
// Binary asset (release tarball naming + install paths)
// --------------------------------------------------------------------

export interface BinaryAssetProvider {
  /** e.g. "swarmflow-darwin-arm64.tar.gz". */
  readonly tarballName: string;
  /** "swarmflow" on POSIX, "swarmflow.exe" on Windows. */
  readonly executableName: string;
  /** Whether `xattr -dr com.apple.quarantine` should run after install. */
  readonly needsQuarantineRemoval: boolean;
}

// --------------------------------------------------------------------
// OS capabilities 鈥?coarse-grained yes/no flags about what the host OS
// implements. Used by business code to skip operations that don't
// apply on the current platform (e.g. POSIX chmod on Windows). Keeping
// these as boolean flags rather than `process.platform` checks lets
// business code stay platform-agnostic.
// --------------------------------------------------------------------

export interface OsCapabilities {
  /**
   * True on macOS and Linux, false on Windows. POSIX permission bits
   * (chmod, the 0o600 / 0o755 model) only have meaningful semantics
   * on POSIX filesystems. Use this to skip `chmodSync` calls rather
   * than branching on `process.platform === "win32"`.
   */
  readonly supportsPosixPermissions: boolean;

  /**
   * True when the host's filesystem (and therefore the shell's $PATH
   * command resolution) is case-insensitive: default macOS (APFS/HFS+)
   * and Windows (NTFS / Git Bash over MSYS2). False on Linux, whose
   * default ext4/btrfs are case-sensitive.
   *
   * Consumers that compare names/paths the OS resolves
   * case-insensitively MUST consult this:
   *  - the bash command classifier, before matching a parsed command
   *    name against its danger/catastrophic sets (`RM`/`Sudo`/`MKFS`
   *    resolve to the same binary as the lowercase form, so a
   *    case-sensitive match would let an uppercase spelling slip past
   *    the safety gate);
   *  - external-path permission rules, when prefix-matching a resolved
   *    path against a stored rule (`D:\Data` vs `d:\data\file`).
   * On Linux the comparison stays case-sensitive 鈥?a file genuinely
   * named `RM` is distinct from `rm`.
   *
   * Note: macOS can be formatted case-sensitive (rare); treating the
   * default as case-insensitive is the safe, conservative choice.
   */
  readonly caseInsensitiveFilesystem: boolean;

  /**
   * True when launching a PATHEXT script shim (`.cmd` / `.bat`, e.g.
   * `npm` / `npx` / `prettier` on Windows) via a bare exec 鈥?command +
   * argv, no shell 鈥?fails, so callers that exec a configured command
   * (hooks) must route through a shell. True on Windows; false on POSIX,
   * where every executable on $PATH is exec-able directly.
   *
   * Modern Node even throws (EINVAL, post-CVE-2024-27980) when asked to
   * spawn a `.bat`/`.cmd` without `shell: true`.
   */
  readonly scriptShimsRequireShell: boolean;

  /**
   * Names of dangerous executables that exist primarily on this
   * platform. Used by the bash command classifier to flag commands
   * the LLM might invoke through the shell.
   *
   * Stored lowercased; the classifier MUST compare against
   * `name.toLowerCase()`. Windows file lookup is case-insensitive,
   * so `REG QUERY ...` from Git Bash resolves to the same `reg.exe`
   * as `reg query ...`; a case-sensitive lookup would let the LLM
   * trivially bypass the danger gate by varying casing.
   *
   * POSIX-shared danger commands (rm, sudo, chmod, ...) stay in
   * `classify.ts` with case-sensitive matching 鈥?Unix convention is
   * case-sensitive paths, and a file genuinely named `RM` should not
   * collide with `rm`.
   */
  readonly platformSpecificDangerCommands: ReadonlySet<string>;

  /**
   * Names of platform-specific *catastrophic* (irreversible disk-wipe)
   * executables 鈥?e.g. Windows `format` / `diskpart`. Empty on POSIX,
   * where the catastrophic disk tools (mkfs/fdisk/dd/...) are matched
   * directly in `classify.ts`; keeping the Windows ones here rather
   * than in that shared list is deliberate, so `format my-document.tex`
   * on a POSIX host is never mis-flagged as a disk wipe.
   *
   * Stored lowercased (same case-insensitivity rationale as
   * `platformSpecificDangerCommands`). The classifier checks this
   * before the danger set so these escalate to `catastrophic` 鈥?the
   * only class that still forces a prompt in yolo mode.
   */
  readonly platformSpecificCatastrophicCommands: ReadonlySet<string>;

  /**
   * Glyph used as the left-side indicator on completed tool-call
   * entries in the TUI.
   *
   * Why a per-platform default: macOS/Linux terminals render U+23FA
   * BLACK CIRCLE FOR RECORD (鈴? as a clean filled circle slightly
   * larger than a bullet, which reads as a deliberate "this is a
   * completed action" marker. Windows PowerShell's default font
   * (Cascadia Mono / Consolas) does not contain U+23FA, so the
   * terminal falls through to Segoe UI Symbol / Emoji and renders
   * the same codepoint as a "record button" icon with a square
   * outline 鈥?visually wrong and inconsistent with the bullet next
   * to it. U+2B24 BLACK LARGE CIRCLE (猬? lives in the geometric
   * shapes block that Cascadia / Consolas ship directly, so on
   * Windows it stays a plain circle.
   */
  readonly toolIndicatorGlyph: string;

  /**
   * Multiplier applied to mouse-wheel delta in the main conversation
   * scroll viewport. 1 on macOS / Linux (terminals typically deliver
   * the user's preferred OS-level scroll acceleration already). 3 on
   * Windows where Windows Terminal / PowerShell deliver a single
   * tick-per-notch raw delta without OS-side acceleration, making
   * the default scrolling feel sluggish compared to native macOS
   * inertia. The value is applied per scroll event by injecting a
   * ConstantScrollAccel into the conversation ScrollViewport.
   */
  readonly conversationScrollMultiplier: number;
}

// --------------------------------------------------------------------
// System proxy 鈥?OS-level proxy configuration that Bun's `fetch` does
// NOT read on its own. Bun honours the HTTP_PROXY / HTTPS_PROXY env
// vars, but on Windows it ignores the WinINET system proxy (Internet
// Options 鈫?LAN Settings / the setting most VPN & proxy clients toggle).
// This provider surfaces that config so startup code can normalise it
// into the env vars, making every outbound fetch route through it.
// --------------------------------------------------------------------

export interface SystemProxyConfig {
  /** Proxy URL for http:// targets, e.g. "http://127.0.0.1:7890". */
  httpProxy?: string;
  /** Proxy URL for https:// targets. */
  httpsProxy?: string;
  /** Comma-separated bypass list in NO_PROXY form, if any. */
  noProxy?: string;
}

export interface SystemProxyProvider {
  /** Identifier of the active implementation, for diagnostics. */
  readonly id: string;

  /**
   * Read the OS-level proxy configuration. Returns null when no system
   * proxy is configured, when the platform exposes nothing beyond the
   * env vars Bun already reads (POSIX), or when the configuration can't
   * be resolved statically (e.g. a Windows PAC `AutoConfigURL`).
   */
  getSystemProxy(): SystemProxyConfig | null;
}

// --------------------------------------------------------------------
// Aggregate
// --------------------------------------------------------------------

export interface PlatformProviders {
  shell: ShellProvider;
  clipboard: ClipboardProvider;
  browser: BrowserProvider;
  binaryAsset: BinaryAssetProvider;
  osCapabilities: OsCapabilities;
  systemProxy: SystemProxyProvider;
}
