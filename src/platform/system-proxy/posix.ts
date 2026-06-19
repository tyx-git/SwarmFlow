import type { SystemProxyProvider } from "../types.js";

/**
 * POSIX 没有 Bun 的 `fetch` 忽略的注册表样式代理存储：
 * macOS/Linux 用户通过 HTTP_PROXY / HTTPS_PROXY 环境变量配置 CLI 代理，
 * Bun 已经遵守。我们故意不调用 `scutil --proxy`（macOS）或
 * gsettings（GNOME）：这些描述 GUI 应用程序代理，终端
 * 工具通常不会继承，采用它们会令期望仅 env 行为的用户感到困惑。
 * 返回 null 使 env 变量在 POSIX 上保持单一真实来源。
 */
export const posixSystemProxy: SystemProxyProvider = {
  id: "posix-noop",
  getSystemProxy() {
    return null;
  },
};
