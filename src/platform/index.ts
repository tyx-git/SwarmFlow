/**
 * Platform Abstraction Layer 鈥?entry point.
 *
 * Business code imports providers from this module. Per-OS
 * implementations live in `shell/`, `clipboard/`, `browser/`, and
 * `binary-asset/` subdirectories. The selectors at the bottom of this
 * file pick the active implementation once at module load time so the
 * choice is fixed for the process lifetime.
 *
 * Discipline: nothing outside `src/platform/` should consult
 * `process.platform` or branch on OS. When you need a new
 * capability, define an interface in `types.ts`, ship an
 * implementation for darwin/linux/win, and import it through here.
 */

import { selectShell } from "./shell/index.js";
import { selectClipboard } from "./clipboard/index.js";
import { selectBrowser } from "./browser/index.js";
import { selectBinaryAsset } from "./binary-asset/index.js";
import { selectOsCapabilities } from "./os-capabilities/index.js";
import { selectSystemProxy } from "./system-proxy/index.js";

export const shell = selectShell();
export const clipboard = selectClipboard();
export const browser = selectBrowser();
export const binaryAsset = selectBinaryAsset();
export const osCapabilities = selectOsCapabilities();
export const systemProxy = selectSystemProxy();

export type {
  ShellKind,
  ShellProvider,
  ShellSpawnRequest,
  ClipboardProvider,
  ClipboardImage,
  ClipboardImageMediaType,
  BrowserProvider,
  BinaryAssetProvider,
  OsCapabilities,
  SystemProxyConfig,
  SystemProxyProvider,
  PlatformProviders,
} from "./types.js";

export { isRemoteSession } from "./detect.js";
