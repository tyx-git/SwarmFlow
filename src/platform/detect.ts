/**
 * PAL 实现使用的平台 + 能力检测辅助函数。
 *
 * 这些辅助函数是直接咨询 `process.platform` 的*唯一*地方
 *（以及 `shell/`、`clipboard/` 等中每个操作系统的实现文件）。
 * `src/platform/` 之外的业务代码必须永远不要在 `process.platform` 上分支。
 */

import { execFileSync } from "node:child_process";

export type SupportedPlatform = "darwin" | "linux" | "win32";

export function currentPlatform(): SupportedPlatform {
  // process.platform 的类型比 SupportedPlatform 宽；三个受支持的平台
  // 会落到下面的精确分支。其余平台按 Linux 处理，以便工具探测继续
  // 使用 xclip / wl-paste / xdg-open 那一套；provider 选择器会在真正
  // 不支持的平台上显式报错，不会静默降级。
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "linux";
}

/** 是否运行在 SSH 会话中——用于决定能否启动浏览器。 */
export function isRemoteSession(): boolean {
  return Boolean(process.env["SSH_CLIENT"] || process.env["SSH_TTY"]);
}

/**
 * 检查可执行文件是否在 `$PATH` 中。
 * 按名称缓存整个进程生命周期，因为 `$PATH` 在运行时几乎不变。
 *
 * 为什么通过 `sh` 调用而不是从 `posix.ts` 导入：这个助手是各 shell
 * provider 的底层依赖（例如 Linux 剪贴板探针会在模块加载时调用它），
 * 不能反向依赖更高层的解析逻辑，否则会形成循环依赖。`command -v` 是
 * POSIX shell 内建命令，在 sh、dash、bash 中行为一致，且每次 POSIX
 * 安装都有 `sh`，无需额外探测。
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
      // `command -v` 是 POSIX 可移植写法，且比 `which` 更快。
      execFileSync("sh", ["-c", `command -v ${JSON.stringify(name)}`], {
        stdio: "ignore",
      });
    }
    return true;
  } catch {
    return false;
  }
}

export type LinuxDisplayServer = "wayland" | "x11" | "none";

export function linuxDisplayServer(): LinuxDisplayServer {
  if (process.env["WAYLAND_DISPLAY"]) return "wayland";
  if (process.env["DISPLAY"]) return "x11";
  return "none";
}
