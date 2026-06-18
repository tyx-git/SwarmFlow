/**
 * Windows browser / system-file opener.
 *
 * Uses cmd.exe's `start` builtin, which dispatches the argument to
 * the Windows shell's default-handler registry (browser for URLs,
 * associated app for files).
 *
 * Quoting is the subtle part:
 *
 *   - `start` parses its arguments word-by-word, and a quoted first
 *     argument is interpreted as the window title. We always pass an
 *     empty `""` title slot so subsequent words become the target.
 *   - cmd.exe escapes internal double-quotes with `""`, not `\"`.
 *   - Node's spawn() on Windows by default re-quotes each argv entry
 *     before handing it to cmd.exe. With `windowsVerbatimArguments:
 *     true` we get full control over the command line cmd actually
 *     sees and can avoid double-quoting.
 *
 * Passing a path like `C:\Program Files\Mozilla Firefox\firefox.exe`
 * without these precautions causes `start` to interpret each word as
 * a separate argument and fail with "Windows cannot find ...".
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
