import type { ClipboardProvider } from "../types.js";
import { currentPlatform } from "../detect.js";
import { darwinClipboard } from "./darwin.js";
import { linuxClipboard } from "./linux.js";
import { win32Clipboard } from "./win32.js";

export function selectClipboard(): ClipboardProvider {
  switch (currentPlatform()) {
    case "darwin": return darwinClipboard;
    case "linux":  return linuxClipboard;
    case "win32":  return win32Clipboard;
  }
}
