import { spawnSync } from "node:child_process";

import type { SystemProxyConfig, SystemProxyProvider } from "../types.js";

const INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * Read one value from the WinINET Internet Settings registry key.
 * `reg query` prints a line like:
 *     ProxyServer    REG_SZ    127.0.0.1:7890
 *     ProxyEnable    REG_DWORD    0x1
 * Returns the trimmed value, or null if the value is absent / the query
 * fails (key missing, `reg` unavailable, non-zero exit).
 */
function readRegValue(name: string): string | null {
  try {
    const result = spawnSync(
      "reg",
      ["query", INTERNET_SETTINGS_KEY, "/v", name],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0 || !result.stdout) return null;
    const m = result.stdout.match(
      new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "m"),
    );
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Prepend an http:// scheme when the address lacks one. */
function withScheme(addr: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(addr) ? addr : `http://${addr}`;
}

/**
 * Parse a WinINET ProxyServer string. Two shapes:
 *   - single:       "127.0.0.1:7890"          鈫?same proxy for all schemes
 *   - per-protocol: "http=host:port;https=host:port;socks=host:port"
 * SOCKS/FTP entries are ignored (HTTP_PROXY/HTTPS_PROXY only cover
 * http/https targets).
 */
function parseProxyServer(raw: string): { http?: string; https?: string } {
  if (!raw.includes("=")) {
    const url = withScheme(raw);
    return { http: url, https: url };
  }
  const out: { http?: string; https?: string } = {};
  for (const part of raw.split(";")) {
    const [proto, addr] = part.split("=", 2);
    if (!addr) continue;
    const key = proto?.trim().toLowerCase();
    const url = withScheme(addr.trim());
    if (key === "http") out.http = url;
    else if (key === "https") out.https = url;
  }
  // A common config sets only http=; reuse it for https targets so
  // HTTPS downloads (the GitHub release CDN) still route through it.
  if (out.http && !out.https) out.https = out.http;
  return out;
}

/**
 * Convert a WinINET ProxyOverride string to NO_PROXY form. Semicolon
 * separated; the special token "<local>" means "bypass for local
 * (intranet) hostnames", which we expand to the loopback hosts that
 * curl/Node-style NO_PROXY matching understands.
 */
function parseBypass(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const hosts = raw
    .split(";")
    .map((h) => h.trim())
    .filter(Boolean)
    .flatMap((h) => (h === "<local>" ? ["localhost", "127.0.0.1", "::1"] : [h]));
  return hosts.length ? hosts.join(",") : undefined;
}

/** Raw WinINET registry values, as returned by `reg query` (or null). */
export interface WinInetRawValues {
  autoConfigUrl: string | null;
  proxyEnable: string | null;
  proxyServer: string | null;
  proxyOverride: string | null;
}

/**
 * Pure: turn raw WinINET registry values into a SystemProxyConfig.
 * Extracted from the IO so the parsing can be unit-tested off-Windows.
 */
export function parseWinInetProxy(v: WinInetRawValues): SystemProxyConfig | null {
  // A PAC script (auto-config) can't be resolved by reading the
  // registry 鈥?bail rather than guess. Manual env vars still apply.
  if (v.autoConfigUrl) return null;

  // REG_DWORD prints as hex ("0x1"); accept a decimal "1" defensively.
  if (!v.proxyEnable || !(/^0x0*1$/i.test(v.proxyEnable) || v.proxyEnable === "1")) {
    return null;
  }

  if (!v.proxyServer) return null;
  const { http, https } = parseProxyServer(v.proxyServer);
  if (!http && !https) return null;

  return {
    httpProxy: http,
    httpsProxy: https,
    noProxy: parseBypass(v.proxyOverride),
  };
}

export const win32SystemProxy: SystemProxyProvider = {
  id: "win32-wininet",
  getSystemProxy(): SystemProxyConfig | null {
    return parseWinInetProxy({
      autoConfigUrl: readRegValue("AutoConfigURL"),
      proxyEnable: readRegValue("ProxyEnable"),
      proxyServer: readRegValue("ProxyServer"),
      proxyOverride: readRegValue("ProxyOverride"),
    });
  },
};
