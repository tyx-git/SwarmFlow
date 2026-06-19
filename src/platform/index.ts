/**
 * 平台抽象层 — 入口点。
 *
 * 业务代码从本模块导入 providers。每个操作系统
 * 的实现位于 `shell/`、`clipboard/`、`browser/` 和
 * `binary-asset/` 子目录中。此文件底部的选择器在模块
 * 加载时选择活动实现一次，因此选择在进程生命周期内是固定的。
 *
 * 原则：`src/platform/` 之外的代码不应咨询
 * `process.platform` 或在操作系统上分支。当需要新
 * 能力时，在 `types.ts` 中定义接口，为 darwin/linux/win
 * 交付实现，并通过此处导入。
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
