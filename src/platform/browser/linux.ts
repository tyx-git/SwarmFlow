/**
 * Linux browser / system-file opener.
 *
 * `xdg-open` is the standard freedesktop.org entry point for opening
 * URLs and files with the registered default handler.
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
