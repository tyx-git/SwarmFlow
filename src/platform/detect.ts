/**
 * Platform + capability detection helpers used by PAL implementations.
 *
 * These helpers are the *only* place that consults `process.platform`
 * directly (alongside the per-OS implementation files in `shell/`,
 * `clipboard/`, etc.). Business code outside `src/platform/` must
 * never branch on `process.platform`.
 */

import { execFileSync } from "node:child_process";

export type SupportedPlatform = "darwin" | "linux" | "win32";

export function currentPlatform(): SupportedPlatform {
  // Cast through the broader NodeJS.Platform union. Anything outside
  // the three we support will still reach this branch but be
  // misclassified 鈥?that's intentional: the provider selectors throw
  // explicitly on unsupported platforms so the unsupported case is
  // never silent.
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  // freebsd / openbsd / sunos / aix 鈫?treat as linux for tooling
  // purposes; the relevant providers will still need linux-side
  // tooling (xclip / wl-paste / xdg-open) to be present.
  return "linux";
}

/** True when running inside an SSH session 鈥?used to gate browser launches. */
export function isRemoteSession(): boolean {
  return Boolean(process.env["SSH_CLIENT"] || process.env["SSH_TTY"]);
}

/**
 * Check whether an executable exists on $PATH. Cached by name for the
 * lifetime of the process since $PATH rarely changes at runtime.
 *
 * Why this uses `/bin/sh` rather than the resolved bash from
 * `posix.ts`: this helper is a low-level dependency of every shell
 * provider (called from the linux clipboard probe at module load,
 * for instance), so it can't depend on a higher-level resolved
 * shell without circularity. `command -v` is a POSIX shell builtin
 * that works the same in sh, dash, and bash, and `sh` exists on
 * every POSIX install without requiring a separate probe.
 */
const _commandExistsCache = new Map<string, boolean>();

export function commandExists(name: string): boolean {
  const cached = _commandExistsCache.get(name);
  if (cached !== undefined) return cached;

  const result = _commandExistsUncached(name);
  _commandExistsCache.set(name, result);
  return result;
}

function _commandExistsUncached(name: string): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [name], { stdio: "ignore" });
    } else {
      // `command -v` is POSIX-portable and faster than `which`.
      // We invoke it through `sh` because it's a shell builtin.
      execFileSync("sh", ["-c", `command -v ${JSON.stringify(name)}`], {
        stdio: "ignore",
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect Linux display server. Used by clipboard implementation
 * selection. Returns null on non-linux.
 */
export type LinuxDisplayServer = "wayland" | "x11" | "none";

export function linuxDisplayServer(): LinuxDisplayServer {
  if (process.env["WAYLAND_DISPLAY"]) return "wayland";
  if (process.env["DISPLAY"]) return "x11";
  return "none";
}
