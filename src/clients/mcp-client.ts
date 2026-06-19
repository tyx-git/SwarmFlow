/**
 * MCP（Model Context Protocol）客户端管理器。
 *
 * 连接一个或多个 MCP 服务器，发现其工具，并将其作为 swarmflow ToolDef 对象提供，
 * 可注入任意 Agent 的工具列表。
 *
 * 生命周期：
 *   const manager = new MCPClientManager(serverConfigs);
 *   await manager.connectAll();
 *   const tools = manager.getAllTools();
 *   const result = await manager.callTool(namespacedName, args);
 *   await manager.closeAll();
 *
 * 工具名称遵循 mcp__<server>__<tool> 命名空间隔离，避免与内置工具冲突。
 */

import type { MCPServerConfig } from "../config/config.js";
import { ToolDef, ToolResult } from "../providers/base.js";
import { VERSION } from "../version.js";
import { osCapabilities } from "../platform/index.js";
import { chmodSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

// ------------------------------------------------------------------
// 动态 MCP SDK 导入（可选依赖）
// ------------------------------------------------------------------

// 由 _ensureMcpSdk() 惰性填充
let Client: any;
let StdioClientTransport: any;
let SSEClientTransport: any;
let mcpAvailable: boolean | undefined;

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

/** 惰性加载 MCP SDK，返回是否可用。 */
async function ensureMcpSdk(): Promise<boolean> {
  if (mcpAvailable !== undefined) return mcpAvailable;
  try {
    const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    Client = sdk.Client;
    const stdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
    StdioClientTransport = stdioMod.StdioClientTransport;
    mcpAvailable = true;
  } catch {
    mcpAvailable = false;
  }
  // SSE transport 即使 SDK 存在也是可选的
  if (mcpAvailable && !SSEClientTransport) {
    try {
      const sseMod = await import("@modelcontextprotocol/sdk/client/sse.js");
      SSEClientTransport = sseMod.SSEClientTransport;
    } catch {
      // SSE 不可用——没关系
    }
  }
  return mcpAvailable;
}

// ------------------------------------------------------------------
// MCPClientManager
// ------------------------------------------------------------------

export type McpServerState = "disconnected" | "connecting" | "connected" | "failed";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  toolCount: number;
  error?: string;
}

/**
 * MCPClientManager —— 管理到一个或多个 MCP 服务器的连接。
 *
 * 工具命名空间隔离（mcp__<server>__<tool>），连接状态追踪，
 * 差量重配置（add/remove/change 检测）。
 */
export class MCPClientManager {
  private _configs: MCPServerConfig[];
  private _configByName: Map<string, MCPServerConfig>;
  private _clients = new Map<string, any>();
  private _transports = new Map<string, any>();
  private _toolDefs = new Map<string, ToolDef>();
  private _toolServer = new Map<string, string>();
  private _toolOriginal = new Map<string, string>();
  private _serverTools = new Map<string, string[]>();
  private _serverState = new Map<string, McpServerState>();
  private _serverError = new Map<string, string>();
  private _connected = false;

  constructor(serverConfigs: MCPServerConfig[]) {
    this._configs = serverConfigs;
    this._configByName = new Map(serverConfigs.map((c) => [c.name, c]));
  }

  // ------------------------------------------------------------------
  // 连接
  // ------------------------------------------------------------------

  /** 连接所有配置的 MCP 服务器并发现工具。幂等——已连接服务器跳过。 */
  async connectAll(): Promise<void> {
    const available = await ensureMcpSdk();
    if (!available) {
      throw new Error(
        "The '@modelcontextprotocol/sdk' package is required for MCP support. " +
          "Install it with: npm install @modelcontextprotocol/sdk",
      );
    }

    if (!this._configs.length) {
      this._connected = true;
      return;
    }

    for (const cfg of this._configs) {
      if (this._clients.has(cfg.name)) continue;
      this._serverState.set(cfg.name, "connecting");
      try {
        await this._connectServer(cfg);
        this._serverState.set(cfg.name, "connected");
        this._serverError.delete(cfg.name);
      } catch (err) {
        this._serverState.set(cfg.name, "failed");
        this._serverError.set(cfg.name, err instanceof Error ? err.message : String(err));
        console.error(`Failed to connect to MCP server '${cfg.name}':`, err);
      }
    }
    this._connected = this._clients.size === this._configs.length;
  }

  /** 连接单个 MCP 服务器并发现其工具。 */
  private async _connectServer(cfg: MCPServerConfig): Promise<void> {
    let transport: any;

    if (cfg.transport === "stdio") {
      const env = buildMcpServerEnv(cfg);
      ensureCredentialFilePermissions(cfg.name, env);
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: Object.keys(env).length > 0 ? env : undefined,
        stderr: "pipe",
      });
    } else if (cfg.transport === "sse") {
      if (!SSEClientTransport) {
        console.warn(
          `SSE transport requested for MCP server '${cfg.name}' but SSEClientTransport is not available`,
        );
        return;
      }
      transport = new SSEClientTransport(validateMcpSseUrl(cfg.name, cfg.url));
    } else {
      console.warn(`Unknown MCP transport '${cfg.transport}' for server '${cfg.name}'`);
      return;
    }

    const client = new Client(
      { name: "swarmflow", version: VERSION },
      { capabilities: {} },
    );
    await client.connect(transport);

    this._clients.set(cfg.name, client);
    this._transports.set(cfg.name, transport);

    // 发现工具并注册为 ToolDef
    const response = await client.listTools();
    const namespacedNames: string[] = [];
    for (const tool of response.tools) {
      const nsName = `mcp__${cfg.name}__${tool.name}`;
      const td: ToolDef = {
        name: nsName,
        description: `[MCP:${cfg.name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        summaryTemplate: `{agent} is calling ${tool.name} via MCP:${cfg.name}`,
        tuiPolicy: { partialReveal: "closed" },
      };
      this._toolDefs.set(nsName, td);
      this._toolServer.set(nsName, cfg.name);
      this._toolOriginal.set(nsName, tool.name);
      namespacedNames.push(nsName);
    }
    this._serverTools.set(cfg.name, namespacedNames);
  }

  // ------------------------------------------------------------------
  // 工具查询
  // ------------------------------------------------------------------

  /** 返回所有已发现的 MCP 工具（ToolDef 数组）。 */
  getAllTools(): ToolDef[] {
    return Array.from(this._toolDefs.values());
  }

  /** 返回指定服务器的已发现工具。 */
  getToolsForServer(serverName: string): ToolDef[] {
    const names = this._serverTools.get(serverName) ?? [];
    return names
      .map((n) => this._toolDefs.get(n))
      .filter((td): td is ToolDef => td !== undefined);
  }

  /** 公开重连——按名称重连单个服务器。 */
  async reconnectServer(serverName: string): Promise<boolean> {
    return this._reconnectServer(serverName);
  }

  /** 公开断开——按名称断开单个服务器。 */
  async disconnectServer(serverName: string): Promise<void> {
    return this._disconnectServer(serverName);
  }

  // ------------------------------------------------------------------
  // 工具执行
  // ------------------------------------------------------------------

  /** 重新连接服务器（断开旧连接 + 重新连接 + 重新发现工具）。 */
  private async _reconnectServer(serverName: string): Promise<boolean> {
    const cfg = this._configByName.get(serverName);
    if (!cfg) return false;

    // 1. 清理旧工具注册
    const oldTools = this._serverTools.get(serverName);
    if (oldTools) {
      for (const toolName of oldTools) {
        this._toolDefs.delete(toolName);
        this._toolServer.delete(toolName);
        this._toolOriginal.delete(toolName);
      }
      this._serverTools.delete(serverName);
    }

    // 2. 关闭旧 transport
    const oldTransport = this._transports.get(serverName);
    if (oldTransport) {
      try { await oldTransport.close(); } catch { /* ignore */ }
      this._transports.delete(serverName);
    }

    // 3. 移除旧 client
    this._clients.delete(serverName);

    // 4. 重新连接
    try {
      await this._connectServer(cfg);
      return this._clients.has(cfg.name);
    } catch (err) {
      console.error(`MCP reconnect failed for '${serverName}':`, err);
      return false;
    }
  }

  /** 返回所有已配置服务器的状态。 */
  getServerStatuses(): McpServerStatus[] {
    return this._configs.map((cfg) => ({
      name: cfg.name,
      state: this._serverState.get(cfg.name) ?? "disconnected",
      toolCount: this._serverTools.get(cfg.name)?.length ?? 0,
      error: this._serverError.get(cfg.name),
    }));
  }

  /**
   * 执行 MCP 工具并返回 swarmflow ToolResult。
   * 自动重连丢失的连接；区分连接错误和工具执行错误。
   */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const serverName = this._toolServer.get(namespacedName);
    if (!serverName) {
      return new ToolResult({ content: `ERROR: Unknown MCP tool '${namespacedName}'` });
    }

    let client = this._clients.get(serverName);
    if (!client) {
      if (await this._reconnectServer(serverName)) {
        client = this._clients.get(serverName);
      }
      if (!client) {
        this._serverState.set(serverName, "failed");
        return new ToolResult({ content: `ERROR: MCP server '${serverName}' is not connected` });
      }
    }

    const originalName = this._toolOriginal.get(namespacedName)!;

    const extractText = (result: any): string => {
      const parts: string[] = [];
      for (const block of result.content) {
        if (block.text !== undefined) {
          parts.push(block.text);
        } else {
          parts.push(String(block));
        }
      }
      return parts.join("\n");
    };

    try {
      const result = await client.callTool({ name: originalName, arguments: args });
      return new ToolResult({ content: extractText(result) });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConnectionError = /ECONNREFUSED|EPIPE|ENOTFOUND|ETIMEDOUT|transport|disconnect/i.test(errMsg);

      if (isConnectionError) {
        console.warn(`MCP server '${serverName}' connection lost, attempting reconnect`);
        this._serverState.set(serverName, "connecting");
        if (await this._reconnectServer(serverName)) {
          this._serverState.set(serverName, "connected");
          client = this._clients.get(serverName);
          if (client) {
            try {
              const result = await client.callTool({ name: originalName, arguments: args });
              return new ToolResult({ content: extractText(result) });
            } catch (e2) {
              this._serverState.set(serverName, "failed");
              return new ToolResult({
                content: `ERROR: MCP tool '${originalName}' failed after reconnect: ${e2}`,
              });
            }
          }
        }
        this._serverState.set(serverName, "failed");
        return new ToolResult({ content: `ERROR: MCP server '${serverName}' connection lost: ${errMsg}` });
      }

      // 工具执行错误——不断开连接，仅报告
      return new ToolResult({ content: `ERROR: MCP tool '${originalName}' failed: ${errMsg}` });
    }
  }

  // ------------------------------------------------------------------
  // 重配置——差量更新（新增/移除/变更/不变）
  // ------------------------------------------------------------------

  /**
   * 应用新服务器配置集。对比当前配置：
   * - 移除的服务器：断开并注销工具
   * - 新增的服务器：连接并注册工具
   * - 变更的服务器：断开并重连
   * - 不变的服务器：跳过
   *
   * 返回变更摘要。
   */
  async reconfigure(
    newConfigs: MCPServerConfig[],
  ): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const available = await ensureMcpSdk();
    if (!available) {
      return { added: [], removed: [], changed: [] };
    }

    const oldByName = this._configByName;
    const newByName = new Map(newConfigs.map((c) => [c.name, c]));

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    // 1. 移除不再存在的服务器
    for (const name of oldByName.keys()) {
      if (!newByName.has(name)) {
        removed.push(name);
        await this._disconnectServer(name);
      }
    }

    // 2. 新增或变更的服务器
    for (const [name, cfg] of newByName) {
      const old = oldByName.get(name);
      if (!old) {
        // 新增
        added.push(name);
        this._serverState.set(name, "connecting");
        try {
          await this._connectServer(cfg);
          this._serverState.set(name, "connected");
          this._serverError.delete(name);
        } catch (err) {
          this._serverState.set(name, "failed");
          this._serverError.set(name, err instanceof Error ? err.message : String(err));
        }
      } else if (!mcpConfigEqual(old, cfg)) {
        // 变更了配置——重连
        changed.push(name);
        await this._disconnectServer(name);
        this._serverState.set(name, "connecting");
        try {
          await this._connectServer(cfg);
          this._serverState.set(name, "connected");
          this._serverError.delete(name);
        } catch (err) {
          this._serverState.set(name, "failed");
          this._serverError.set(name, err instanceof Error ? err.message : String(err));
        }
      }
      // 不变：跳过
    }

    // 3. 更新内部配置引用
    this._configs = newConfigs;
    this._configByName = newByName;
    this._connected = this._clients.size > 0;

    return { added, removed, changed };
  }

  /** 断开单个服务器并清理所有相关注册。 */
  private async _disconnectServer(name: string): Promise<void> {
    const oldTools = this._serverTools.get(name);
    if (oldTools) {
      for (const toolName of oldTools) {
        this._toolDefs.delete(toolName);
        this._toolServer.delete(toolName);
        this._toolOriginal.delete(toolName);
      }
      this._serverTools.delete(name);
    }

    const transport = this._transports.get(name);
    if (transport) {
      try { await transport.close(); } catch { /* ignore */ }
      this._transports.delete(name);
    }
    this._clients.delete(name);
    this._serverState.delete(name);
    this._serverError.delete(name);
  }

  // ------------------------------------------------------------------
  // 清理
  // ------------------------------------------------------------------

  /** 关闭所有 MCP 服务器连接。 */
  async closeAll(): Promise<void> {
    for (const [, transport] of Array.from(this._transports.entries())) {
      try {
        await transport.close();
      } catch {
        console.warn(`Error closing MCP server`);
      }
    }
    this._clients.clear();
    this._transports.clear();
    this._toolDefs.clear();
    this._toolServer.clear();
    this._toolOriginal.clear();
    this._serverTools.clear();
    this._connected = false;
  }
}

/** 两个 MCPServerConfig 是否浅层相等（用于 reconfigure 变更检测）。 */
function mcpConfigEqual(a: MCPServerConfig, b: MCPServerConfig): boolean {
  if (a.transport !== b.transport) return false;
  if (a.command !== b.command) return false;
  if (a.url !== b.url) return false;
  if (a.args.length !== b.args.length || a.args.some((v, i) => v !== b.args[i])) return false;
  const aKeys = Object.keys(a.env).sort();
  const bKeys = Object.keys(b.env).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i] || a.env[aKeys[i]] !== b.env[bKeys[i]]) return false;
  }
  return true;
}
