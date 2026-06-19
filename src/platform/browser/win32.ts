/**
 * Windows 浏览器 / 系统文件打开器。
 *
 * 使用 cmd.exe 的 `start` 内置命令，它将参数分派到
 * Windows shell 的默认处理程序注册表（URL 浏览器，
 * 文件关联应用）。
 *
 * 引号是微妙的部分：
 *
 *   - `start` 逐词解析参数，带引号的第一个
 *     参数被解释为窗口标题。我们总是传递一个
 *     空的 `""` 标题槽，以便后续单词成为目标。
 *   - cmd.exe 用 `""` 转义内部双引号，而不是 `\"`。
 *   - Windows 上 Node 的 spawn() 默认在传递给
 *     cmd.exe 之前重新引用每个 argv 条目。使用 `windowsVerbatimArguments:
 *     true` 我们可以完全控制 cmd 实际看到的命令行，
 *     并避免双重引用。
 *
 * 不采取这些预防措施传递路径如 `C:\Program Files\Mozilla Firefox\firefox.exe`
 * 会导致 `start` 将每个单词解释为单独参数，
 * 并以 "Windows cannot find ..." 失败。
 */

import { spawn } from "node:child_process";
import type { BrowserProvider } from "../types.js";

function escapeForStart(arg: string): string {
  // cmd's quote escape is doubling the quote character. No backslashes.
  return `"${arg.replace(/"/g, '""')}"`;
}

function safeOpen(arg: string): void {
  try {
    const quoted = escapeForStart(arg);
    // windowsVerbatimArguments: don't let Node re-quote the args; we
    // built the exact command line we want cmd to see. The empty
    // first quoted token after `start` is the (intentionally blank)
    // window title.
    const child = spawn("cmd.exe", ["/c", "start", '""', quoted], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.on("error", () => { /* ignore */ });
    child.unref();
  } catch {
    // ignore
  }
}

export const win32Browser: BrowserProvider = {
  openUrl: safeOpen,
  openFile: safeOpen,
};
