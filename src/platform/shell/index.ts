import type { ShellProvider } from "../types.js";
import { currentPlatform } from "../detect.js";
import { posixShell } from "./posix.js";
import { win32Shell } from "./win32.js";

export function selectShell(): ShellProvider {
  switch (currentPlatform()) {
    case "darwin":
    case "linux":
      return posixShell;
    case "win32":
      return win32Shell;
  }
}
