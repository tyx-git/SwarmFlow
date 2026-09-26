import { spawnSync } from "node:child_process";

import type { SystemProxyConfig, SystemProxyProvider } from "../types.js";

const INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** `reg query` 输出中的值名 → WinInetRawValues 字段。 */
const FIELD_BY_VALUE_NAME: Record<string, keyof WinInetRawValues> = {
  AutoConfigURL: "autoConfigUrl",
  ProxyEnable: "proxyEnable",
  ProxyServer: "proxyServer",
  ProxyOverride: "proxyOverride",
};

/**
 * 一次 `reg query` 读出 Internet Settings 键下的全部目标值。
 *
 * 逐个值 `reg query ... /v <name>` 需要 4 次子进程派生，而 Windows 上
 * 单次派生约 150-250ms；不带 `/v` 的整键查询一次即可取回所有值。
 * `reg query` 对每个值打印一行：
 *     ProxyServer    REG_SZ    127.0.0.1:7890
 *     ProxyEnable    REG_DWORD    0x1
 * 值名不含空格，因此按空白切分是安全的。
 * 键不存在 / `reg` 不可用 / 非零退出时，全部字段保持 null。
 */
function readRegValues(): WinInetRawValues {
  const values: WinInetRawValues = {
    autoConfigUrl: null,
    proxyEnable: null,
    proxyServer: null,
    proxyOverride: null,
  };

  try {
    const result = spawnSync(
      "reg",
      ["query", INTERNET_SETTINGS_KEY],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0 || !result.stdout) return values;
    for (const line of result.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*(\S+)\s+REG_\w+\s+(.*)$/);
      if (!m) continue;
      const field = FIELD_BY_VALUE_NAME[m[1]!];
      if (!field) continue;
      values[field] = m[2]!.trim();
    }
  } catch {
    // `reg` 不可用；按「无系统代理」处理。
  }
  return values;
}

/** 当地址缺少协议时，添加 http:// 前缀。*/
function withScheme(addr: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(addr) ? addr : `http://${addr}`;
}

/**
 * 解析 WinINET ProxyServer 字符串。两种形状：
 *   - single:       "127.0.0.1:7890"          → 所有协议使用相同代理
 *   - per-protocol: "http=host:port;https=host:port;socks=host:port"
 * SOCKS/FTP 条目被忽略（HTTP_PROXY/HTTPS_PROXY 仅覆盖
 * http/https 目标）。
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
 * 将 WinINET ProxyOverride 字符串转换为 NO_PROXY 格式。分号分隔；
 * 特殊标记 "<local>" 表示 "绕过本地（intranet）主机名"，
 * 我们将其扩展为 curl/Node 风格 NO_PROXY 匹配理解的回环主机。
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

/** 原始 WinINET 注册表值，如 `reg query` 返回的那样（或 null）。*/
export interface WinInetRawValues {
  autoConfigUrl: string | null;
  proxyEnable: string | null;
  proxyServer: string | null;
  proxyOverride: string | null;
}

/**
 * 纯函数：将原始 WinINET 注册表值转换为 SystemProxyConfig。
 * 从 IO 中提取，以便可以在非 Windows 上对解析进行单元测试。
 */
export function parseWinInetProxy(v: WinInetRawValues): SystemProxyConfig | null {
  // A PAC script (auto-config) can't be resolved by reading the
  // registry —bail rather than guess. Manual env vars still apply.
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
    return parseWinInetProxy(readRegValues());
  },
};
