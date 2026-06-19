/**
 * macOS 浏览器 / 系统文件打开器。
 *
 * 相同的 `open` 命令处理 URL 和本地文件路径。
 */

import { spawn } from "node:child_process";
import type { BrowserProvider } from "../types.js";

function safeOpen(arg: string): void {
  try {
    // spawn detached + unref so we don't block on `open` returning
    // and don't keep the parent process alive once swarmflow exits.
    const child = spawn("open", [arg], { stdio: "ignore", detached: true });
    child.on("error", () => { /* ignore */ });
    child.unref();
  } catch {
    // ignore —caller has no recourse anyway
  }
}

export const darwinBrowser: BrowserProvider = {
  openUrl: safeOpen,
  openFile: safeOpen,
};
