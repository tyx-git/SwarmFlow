/**
 * macOS 浏览器 / 系统文件打开器。
 *
 * 相同的 `open` 命令处理 URL 和本地文件路径。
 */

import { spawn } from "node:child_process";
import type { BrowserProvider } from "../types.js";

function safeOpen(arg: string): void {
  try {
    // 使用 spawn detached + unref，这样既不会阻塞 `open` 返回，
    // 也不会在 swarmflow 退出后使父进程保持存活。
    const child = spawn("open", [arg], { stdio: "ignore", detached: true });
    child.on("error", () => { /* 忽略错误 */ });
    child.unref();
  } catch {
    // 忽略 —— 调用方无论如何也无法处理
  }
}

export const darwinBrowser: BrowserProvider = {
  openUrl: safeOpen,
  openFile: safeOpen,
};