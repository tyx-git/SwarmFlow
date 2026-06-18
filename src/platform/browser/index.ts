import type { BrowserProvider } from "../types.js";
import { currentPlatform } from "../detect.js";
import { darwinBrowser } from "./darwin.js";
import { linuxBrowser } from "./linux.js";
import { win32Browser } from "./win32.js";

export function selectBrowser(): BrowserProvider {
  switch (currentPlatform()) {
    case "darwin": return darwinBrowser;
    case "linux":  return linuxBrowser;
    case "win32":  return win32Browser;
  }
}
