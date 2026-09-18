import type { SystemProxyProvider } from "../types.js";
import { currentPlatform } from "../detect.js";
import { posixSystemProxy } from "./posix.js";
import { win32SystemProxy } from "./win32.js";

export function selectSystemProxy(): SystemProxyProvider {
  switch (currentPlatform()) {
    case "darwin": return posixSystemProxy;
    case "linux":  return posixSystemProxy;
    case "win32":  return win32SystemProxy;
  }
}
