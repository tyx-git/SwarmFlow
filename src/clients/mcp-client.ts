/**
 * MCP (Model Context Protocol) client manager.
 *
 * Connects to one or more MCP servers, discovers their tools, and makes
 * them available as swarmflow ToolDef objects that can be injected into
 * any Agent's tool list.
 *
 * Lifecycle:
 *
 *   const manager = new MCPClientManager(serverConfigs);
 *   await manager.connectAll();
 *   const tools = manager.getAllTools();
 *   const result = await manager.callTool(namespacedName, args);
 *   await manager.closeAll();
 */

import type { MCPServerConfig } from "./config/config.js";
import { ToolDef, ToolResult } from "./providers/base.js";
import { VERSION } from "./version.js";
import { osCapabilities } from "./platform/index.js";
import { chmodSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

// ------------------------------------------------------------------
// Dynamic MCP SDK imports (optional dependency)
// ------------------------------------------------------------------

// These are populated lazily by _ensureMcpSdk()
let Client: any;
let StdioClientTransport: any;
let SSEClientTransport: any;
let mcpAvailable: boolean | undefined;

export const DEFAULT_MCP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "LANG",
  "LC_*",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_*",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function envKeyMatchesPattern(key: string, pattern: string): boolean {
  return globToRegExp(pattern).test(key);
}

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

function looksLikePathValue(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("~")) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.includes(path.sep);
}

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
  // SSE transport is optional even when the core SDK exists
  if (mcpAvailable && !SSEClientTransport) {
    try {
      const sseMod = await import("@modelcontextprotocol/sdk/client/sse.js");
      SSEClientTransport = sseMod.SSEClientTransport;
    } catch {
      // SSE not available 鈥?that's fine
    }
  }
  return mcpAvailable;
}

// ------------------------------------------------------------------
// MCPClientManager
// ------------------------------------------------------------------

/**
 * Manage connections to one or more MCP servers.
 *
 * Each server's tools are namespaced as `mcp__<server>__<tool>`
 * to avoid collisions with built-in swarmflow tools.
 */
export type McpServerState = "disconnected" | "connecting" | "connected" | "failed";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  toolCount: number;
  error?: string;
}

export class MCPClientManager {
  private _configs: MCPServerConfig[];
  private _configByName: Map<string, MCPServerConfig>;
  private _clients: Map<string, any> = new Map();        // server name -> Client
  private _transports: Map<string, any> = new Map();     // server name -> Transport
  private _toolDefs: Map<string, ToolDef> = new Map();   // namespaced -> ToolDef
  private _toolServer: Map<string, string> = new Map();  // namespaced -> server name
  private _toolOriginal: Map<string, string> = new Map();// namespaced -> original name
  private _serverTools: Map<string, string[]> = new Map();// server -> [namespaced names]
  private _serverState: Map<string, McpServerState> = new Map();
  private _serverError: Map<string, string> = new Map();
  private _connected = false;

  constructor(serverConfigs: MCPServerConfig[]) {
    this._configs = serverConfigs;
    this._configByName = new Map(serverConfigs.map((c) => [c.name, c]));
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  /**
   * Connect to all configured MCP servers and discover tools.
   * Idempotent 鈥?already connected servers are skipped.
   */
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
          `SSE transport requested for MCP server '${cfg.name}' but ` +
          "SSEClientTransport is not available",
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

    // Discover tools
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
  // Tool queries
  // ------------------------------------------------------------------

  /** Return all discovered MCP tools as ToolDef objects. */
  getAllTools(): ToolDef[] {
    return Array.from(this._toolDefs.values());
  }

  /** Return tools from a specific MCP server. */
  getToolsForServer(serverName: string): ToolDef[] {
    const names = this._serverTools.get(serverName) ?? [];
    return names
      .map((n) => this._toolDefs.get(n))
      .filter((td): td is ToolDef => td !== undefined);
  }

  /** Public reconnect 鈥?disconnect then reconnect a single server by name. */
  async reconnectServer(serverName: string): Promise<boolean> {
    return this._reconnectServer(serverName);
  }

  /** Public disconnect 鈥?disconnect a single server by name. */
  async disconnectServer(serverName: string): Promise<void> {
    return this._disconnectServer(serverName);
  }

  // ------------------------------------------------------------------
  // Tool execution
  // ------------------------------------------------------------------

  private async _reconnectServer(serverName: string): Promise<boolean> {
    const cfg = this._configByName.get(serverName);
    if (!cfg) return false;

    // 1. Clean up old tool registrations
    const oldTools = this._serverTools.get(serverName);
    if (oldTools) {
      for (const toolName of oldTools) {
        this._toolDefs.delete(toolName);
        this._toolServer.delete(toolName);
        this._toolOriginal.delete(toolName);
      }
      this._serverTools.delete(serverName);
    }

    // 2. Close old transport
    const oldTransport = this._transports.get(serverName);
    if (oldTransport) {
      try {
        await oldTransport.close();
      } catch {
        // ignore
      }
      this._transports.delete(serverName);
    }

    // 3. Remove stale client
    this._clients.delete(serverName);

    // 4. Reconnect
    try {
      await this._connectServer(cfg);
      return this._clients.has(cfg.name);
    } catch (err) {
      console.error(`MCP reconnect failed for '${serverName}':`, err);
      return false;
    }
  }

  /** Get status of all configured servers. */
  getServerStatuses(): McpServerStatus[] {
    return this._configs.map((cfg) => ({
      name: cfg.name,
      state: this._serverState.get(cfg.name) ?? "disconnected",
      toolCount: this._serverTools.get(cfg.name)?.length ?? 0,
      error: this._serverError.get(cfg.name),
    }));
  }

  /** Execute an MCP tool and return a swarmflow ToolResult. */
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
      // Distinguish connection errors from tool execution errors
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

      // Tool execution error 鈥?don't reconnect, just report
      return new ToolResult({ content: `ERROR: MCP tool '${originalName}' failed: ${errMsg}` });
    }
  }

  // ------------------------------------------------------------------
  // Reconfigure 鈥?diff-based reload (add/remove/reconnect changed)
  // ------------------------------------------------------------------

  /**
   * Apply a new set of server configs. Compared to the current set:
   *   - Removed servers are disconnected and their tools unregistered.
   *   - New servers are connected and their tools registered.
   *   - Changed servers (different config) are disconnected then reconnected.
   *   - Unchanged servers are left alone.
   *
   * Returns a summary of what happened.
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

    // 1. Remove servers no longer in config
    for (const name of oldByName.keys()) {
      if (!newByName.has(name)) {
        removed.push(name);
        await this._disconnectServer(name);
      }
    }

    // 2. Add new or reconnect changed servers
    for (const [name, cfg] of newByName) {
      const old = oldByName.get(name);
      if (!old) {
        // New server
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
        // Config changed 鈥?reconnect
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
      // else: unchanged 鈥?skip
    }

    // 3. Update internal config references
    this._configs = newConfigs;
    this._configByName = newByName;
    this._connected = this._clients.size > 0;

    return { added, removed, changed };
  }

  /** Disconnect a server and clean up all its registrations. */
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
  // Cleanup
  // ------------------------------------------------------------------

  /** Close all MCP server connections. */
  async closeAll(): Promise<void> {
    for (const [name, transport] of Array.from(this._transports.entries())) {
      try {
        await transport.close();
      } catch {
        console.warn(`Error closing MCP server '${name}'`);
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

/** Shallow comparison of two MCPServerConfig objects. */
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
