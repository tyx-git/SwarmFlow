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
  //通过更广泛的NodeJS进行强制转换。平台联盟。外面有什么吗
  //我们支持的三个仍然会到达这个分支，但是
  //错误分类—这是有意的:提供者选择器抛出
  //在不支持的平台上显式，因此不支持的情况是
  //永不沉默。
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  //FreeBSD/openbsd/sunos/AIX→作为工具的linux对待
  //目的；相关的提供商仍然需要linux端
  //工具(xclip / wl-paste / xdg-open)存在。
  return "linux";
}

/** True when running inside an SSH session —used to gate browser launches. */
export function isRemoteSession(): boolean {
  return Boolean(process.env["SSH_CLIENT"] || process.env["SSH_TTY"]);
}

/**
*检查$PATH中是否存在可执行文件。按名称缓存的
*进程的生命周期，因为$PATH在运行时很少改变。
*
*为什么使用`/bin/sh '而不是从
* `posix.ts `:这个助手是每个shell的底层依赖项
* provider(在模块加载时从linux剪贴板探针调用，
*举例来说)，所以它不能依赖于更高级别的解析
*没有圆形的外壳。“command -v”是一个内置的POSIX shell
*这在sh、dash和bash中是一样的，并且“sh”存在于
*每次POSIX安装都不需要单独的探针。
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
      // `command -v `是POSIX可移植的，比` which `快。
      //我们通过“sh”调用它，因为它是shell内置的。
      execFileSync("sh", ["-c", `command -v ${JSON.stringify(name)}`], {
        stdio: "ignore",
      });
    }
    return true;
  } catch {
    return false;
  }
}

// `command -v '是POSIX可移植的，比哪个更快。
//我们通过“sh”调用它，因为它内置在shell中。
export type LinuxDisplayServer = "wayland" | "x11" | "none";

export function linuxDisplayServer(): LinuxDisplayServer {
  if (process.env["WAYLAND_DISPLAY"]) return "wayland";
  if (process.env["DISPLAY"]) return "x11";
  return "none";
}
