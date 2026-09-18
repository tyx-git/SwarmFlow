/**
 * Linux 浏览器 / 系统文件打开器。
 *
 * `xdg-open` 是打开 URL 和文件的标准 freedesktop.org 入口点，
 * 使用注册的默认处理程序。
 */

import { spawn } from "node:child_process";
import type { BrowserProvider } from "../types.js";

function safeOpen(arg: string): void {
  try {
    const child = spawn("xdg-open", [arg], { stdio: "ignore", detached: true });
    child.on("error", () => { /* ignore */ });
    child.unref();
  } catch {
    // ignore
  }
}

export const linuxBrowser: BrowserProvider = {
  openUrl: safeOpen,
  openFile: safeOpen,
};
