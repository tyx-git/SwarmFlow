/**
 * 在启动时将操作系统级别的系统代理规范化为 HTTP_PROXY / HTTPS_PROXY
 * 环境变量。
 *
 * 原因：Bun 的 `fetch` 在请求时读取 HTTP(S)_PROXY，但在 Windows 上
 * 它不会读取 WinINET 系统代理（大多数 VPN/代理客户端切换的设置）。
 * 如果用户开启了系统代理但未设置环境变量，每个出站 fetch 都会
 * 静默绕过代理并在被阻塞的主机上挂起——这个问题最初表现为
 * 卡在 "Downloading update..." 的自更新（GitHub release CDN）。
 * 在这里填充环境变量可使所有 fetch（提供商 API、网络搜索/获取、
 * 自更新）统一通过代理路由。
 *
 * 显式环境变量始终优先——此处仅填充缺失的，且在 POSIX 上为
 * 空操作（提供商返回 null）。幂等操作。
 */

import { systemProxy } from "../platform/index.js";

/** 将系统代理应用到环境变量中（如缺失） */
export function applySystemProxyToEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const hasProxyEnv =
    env["HTTPS_PROXY"] ||
    env["https_proxy"] ||
    env["HTTP_PROXY"] ||
    env["http_proxy"];
  if (hasProxyEnv) return; // explicit configuration wins

  const cfg = systemProxy.getSystemProxy();
  if (!cfg) return;

  if (cfg.httpsProxy) {
    env["HTTPS_PROXY"] = cfg.httpsProxy;
    env["https_proxy"] = cfg.httpsProxy;
  }
  if (cfg.httpProxy) {
    env["HTTP_PROXY"] = cfg.httpProxy;
    env["http_proxy"] = cfg.httpProxy;
  }
  if (cfg.noProxy && !env["NO_PROXY"] && !env["no_proxy"]) {
    env["NO_PROXY"] = cfg.noProxy;
    env["no_proxy"] = cfg.noProxy;
  }
}
