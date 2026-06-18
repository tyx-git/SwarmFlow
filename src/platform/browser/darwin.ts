/**
 * macOS browser / system-file opener.
 *
 * The same `open` command handles both URLs and local file paths.
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
    // ignore 鈥?caller has no recourse anyway
  }
}

export const darwinBrowser: BrowserProvider = {
  openUrl: safeOpen,
  openFile: safeOpen,
};
