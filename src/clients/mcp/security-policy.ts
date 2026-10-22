/**
 * MCP（Model Context Protocol）客户端。
 *
 * 连接一个或多个 MCP 服务器，发现其工具，并将其作为 swarmflow ToolDef 对象提供，
 * 可注入任意 Agent 的工具列表。工具名称遵循 mcp__<server>__<tool> 命名空间隔离，
 * 避免与内置工具冲突。
 */

import type { MCPServerConfig } from "../../config/types.js";
import { osCapabilities } from "../../platform/index.js";
import { chmodSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/** 默认环境变量允许列表（白名单 + 通配符支持）。 */
export const DEFAULT_MCP_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "LANG", "LC_*",
  "TERM", "COLORTERM", "NO_COLOR", "TZ", "TMPDIR", "TMP", "TEMP",
  "XDG_*", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SSH_AUTH_SOCK", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA",
];

/** 将 glob 通配符模式转换为正则。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** 环境变量名是否匹配 glob 模式。 */
function envKeyMatchesPattern(key: string, pattern: string): boolean {
  return globToRegExp(pattern).test(key);
}

/** 判断环境变量名是否指向凭证文件路径（需要 0o600 权限）。 */
function isCredentialFileEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (normalized === "GOOGLE_APPLICATION_CREDENTIALS") return true;
  if (normalized === "AWS_SHARED_CREDENTIALS_FILE") return true;
  if (normalized === "AWS_CONFIG_FILE") return true;
  if (normalized === "KUBECONFIG") return true;
  if (normalized === "NETRC") return true;
  return (
    normalized.endsWith("_FILE") &&
    /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CRED|CERT|AUTH)/.test(normalized)
  ) || normalized.includes("CREDENTIALS_FILE");
}

/** 判断环境变量值是否像文件路径。 */
function looksLikePathValue(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("~")) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.includes(path.sep);
}

/**
 * 确保凭证文件权限为 0o600（仅所有者读写）。
 * Windows 上跳过（不支持 POSIX 权限）。
 */
export function ensureCredentialFilePermissions(
  serverName: string,
  env: Record<string, string>,
): void {
  if (!osCapabilities.supportsPosixPermissions) return;
  for (const [key, rawValue] of Object.entries(env)) {
    if (!isCredentialFileEnvKey(key)) continue;
    if (!looksLikePathValue(rawValue)) continue;
    const filePath = rawValue.replace(/^~(?=$|\/|\\)/, homedir());
    if (!existsSync(filePath)) continue;
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if ((st.mode & 0o077) === 0) continue;
    try {
      chmodSync(filePath, 0o600);
      console.warn(
        `Tightened credential file permissions for MCP server '${serverName}' (${key}) to 0o600: ${filePath}`,
      );
    } catch (err) {
      console.warn(
        `Credential file for MCP server '${serverName}' should be 0o600 (${key}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** 验证 SSE URL 格式（协议、凭证禁止嵌入）。 */
export function validateMcpSseUrl(serverName: string, rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid SSE URL for MCP server '${serverName}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP server '${serverName}' SSE URL must use http/https (got ${parsed.protocol})`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `MCP server '${serverName}' SSE URL must not embed credentials`,
    );
  }
  return parsed;
}

/**
 * 构建 MCP 服务器的完整环境变量集合。
 * 由继承的环境变量经过白名单过滤后与服务器特定变量合并。
 */
export function buildMcpServerEnv(
  cfg: MCPServerConfig,
  inheritedEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const allowlist = [...DEFAULT_MCP_ENV_ALLOWLIST, ...(cfg.envAllowlist ?? [])];
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (typeof value !== "string") continue;
    if (!allowlist.some((p) => envKeyMatchesPattern(key, p))) continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    out[key] = value;
  }
  return out;
}
