/**
 * Normalise the OS-level system proxy into the HTTP_PROXY / HTTPS_PROXY
 * environment variables at startup.
 *
 * Why: Bun's `fetch` reads HTTP(S)_PROXY at request time, but on Windows
 * it does NOT read the WinINET system proxy (the setting most VPN/proxy
 * clients toggle). A user with the system proxy on but no env var set
 * would have every outbound fetch silently bypass the proxy and hang on
 * blocked hosts 鈥?the symptom that first surfaced as a self-update stuck
 * at "Downloading update..." against the GitHub release CDN. Populating
 * the env vars here makes every fetch (provider APIs, web search/fetch,
 * self-update) route through the proxy uniformly.
 *
 * An explicit env var always wins 鈥?this only fills in what's missing,
 * and is a no-op on POSIX (the provider returns null there). Idempotent.
 */

import { systemProxy } from "./platform/index.js";

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
