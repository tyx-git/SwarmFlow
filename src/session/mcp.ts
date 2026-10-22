/**
 * MCP 连接生命周期、可用性快照与变更通知。
 *
 * 只搬何时连/何时重载/变更如何告知模型这层；具体客户端与工具注册由
 * clients/mcp 与 tools/runtime 负责。
 */

import type { Agent } from "../agents/agent.js";
import type { ToolExecutor } from "../agents/tool-loop/types.js";
import type { MCPClientManager } from "../clients/mcp/manager.js";
import { loadGlobalSettings, loadLocalSettings, mergeSettings, settingsToConfigInputs } from "../config/settings/io.js";
import { registerMcpTools } from "../tools/runtime.js";
import type { DeliverMessageResult, MessageEnvelope } from "./tree-types.js";

/** MCP 可用性快照：已连接服务器名与工具名（去重排序后）。 */
export interface McpAvailabilitySnapshot {
  servers: string[];
  tools: string[];
}

/** 一次可用性变更的明细，用于拼装系统通知。 */
export interface ToolAvailabilityNotice {
  reason: string;
  skillsEnabled?: string[];
  skillsDisabled?: string[];
  skillsAdded?: string[];
  skillsRemoved?: string[];
  mcpServersConnected?: string[];
  mcpServersDisconnected?: string[];
  mcpServersChanged?: string[];
  mcpToolsAdded?: string[];
  mcpToolsRemoved?: string[];
}

/** MCP 生命周期所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface McpHost {
  primaryAgent: Agent;
  agentTemplates: Record<string, Agent>;
  onMcpStatus?: (statuses: Array<{ name: string; state: string; toolCount: number; error?: string }>) => void;
  _mcpManager?: MCPClientManager;
  _mcpConnected: boolean;
  _mcpReadyPromise?: Promise<void>;
  _toolExecutors: Record<string, ToolExecutor>;
  _conversationStarted: boolean;
  _projectRoot: string;
  _deliverMessage(msg: MessageEnvelope): DeliverMessageResult;
  _withTurnLock<T>(fn: () => Promise<T>): Promise<T>;
  _sortedUnique(values: Iterable<string | undefined | null>): string[];
  _diffNames(before: Iterable<string>, after: Iterable<string>): { added: string[]; removed: string[] };
  // 以下方法在模块内按"虚分派"调用（host.X），以保留实例级覆盖/测试桩的语义。
  ensureMcpReady(): Promise<void>;
  _ensureMcp(): Promise<void>;
  _snapshotMcpAvailability(): McpAvailabilitySnapshot;
  _queueToolAvailabilityNotice(notice: ToolAvailabilityNotice): void;
  reloadMcp(options?: { notice?: boolean; reason?: string }): Promise<string>;
  reconnectMcpServer(serverName: string): Promise<boolean>;
}

export function getMcpManager(host: McpHost): MCPClientManager | undefined {
  return host._mcpManager;
}

export async function ensureMcpReady(host: McpHost): Promise<void> {
  await host._ensureMcp();
}

export async function ensureMcp(host: McpHost): Promise<void> {
  if (!host._mcpManager) return;
  if (host._mcpConnected) return;

  // Await bootstrap's fire-and-forget connectAll if available.
  if (host._mcpReadyPromise) {
    await host._mcpReadyPromise;
    host._mcpReadyPromise = undefined;
  }

  const agents = [host.primaryAgent, ...Object.values(host.agentTemplates)];
  host._mcpConnected = await registerMcpTools(
    host._mcpManager,
    host._toolExecutors,
    agents,
  );

  if (host.onMcpStatus && typeof host._mcpManager.getServerStatuses === "function") {
    host.onMcpStatus(host._mcpManager.getServerStatuses());
  }
}

export function snapshotMcpAvailability(host: McpHost): McpAvailabilitySnapshot {
  const manager = host._mcpManager;
  if (!manager) return { servers: [], tools: [] };

  const toolNames: string[] = [];
  const serverNames: string[] = [];

  try {
    if (typeof manager.getAllTools === "function") {
      for (const tool of manager.getAllTools()) {
        if (typeof tool.name !== "string") continue;
        toolNames.push(tool.name);
        const parts = tool.name.split("__");
        if (parts.length >= 3 && parts[0] === "mcp") {
          const serverName = parts[1];
          if (serverName) serverNames.push(serverName);
        }
      }
    }
  } catch { /* best effort */ }

  try {
    if (typeof manager.getServerStatuses === "function") {
      for (const status of manager.getServerStatuses()) {
        if (status.state === "connected") serverNames.push(status.name);
      }
    }
  } catch { /* best effort */ }

  return {
    servers: host._sortedUnique(serverNames),
    tools: host._sortedUnique(toolNames),
  };
}

export function queueToolAvailabilityNotice(host: McpHost, notice: ToolAvailabilityNotice): void {
  if (!host._conversationStarted) return;

  const sections: string[] = [
    `Tool availability changed because ${notice.reason}.`,
    "This is normal runtime behavior; do not infer from this change alone that your earlier answer or reasoning was wrong. Use the skills and MCP tools currently available in this turn.",
  ];

  const addList = (label: string, items: string[] | undefined): void => {
    const values = host._sortedUnique(items ?? []);
    if (values.length === 0) return;
    sections.push("", `${label}:`);
    for (const value of values) sections.push(`- ${value}`);
  };

  addList("Skills enabled", notice.skillsEnabled);
  addList("Skills disabled", notice.skillsDisabled);
  addList("Skills now available after reload", notice.skillsAdded);
  addList("Skills no longer available after reload", notice.skillsRemoved);
  addList("MCP servers connected", notice.mcpServersConnected);
  addList("MCP servers disconnected", notice.mcpServersDisconnected);
  addList("MCP servers reconnected or changed", notice.mcpServersChanged);
  addList("MCP tools now available", notice.mcpToolsAdded);
  addList("MCP tools no longer available", notice.mcpToolsRemoved);

  if (sections.length <= 2) return;

  host._deliverMessage({
    type: "system_notice",
    sender: "system",
    timestamp: Date.now(),
    content: sections.join("\n"),
    wake: false,
    tuiVisible: false,
  });
}

/**
 * Reload MCP servers from settings. Reads global + local settings,
 * reconfigures the MCPClientManager, and notifies the TUI.
 * Returns a human-readable summary of what changed.
 */
export async function reloadMcp(host: McpHost, options?: { notice?: boolean; reason?: string }): Promise<string> {
  const before = host._snapshotMcpAvailability();
  const globalSettings = loadGlobalSettings();
  const localSettings = loadLocalSettings(host._projectRoot);
  const effective = Object.keys(localSettings).length > 0
    ? mergeSettings(globalSettings, localSettings)
    : globalSettings;
  const { mcpServers } = settingsToConfigInputs(effective);

  if (host._mcpManager) {
    const mcpResult = await host._mcpManager.reconfigure(mcpServers);

    host._mcpConnected = false;
    await host._ensureMcp();

    const changes: string[] = [];
    if (mcpResult.added.length) changes.push(`+${mcpResult.added.join(", ")}`);
    if (mcpResult.removed.length) changes.push(`-${mcpResult.removed.join(", ")}`);
    if (mcpResult.changed.length) changes.push(`~${mcpResult.changed.join(", ")}`);

    const allTools = host._mcpManager.getAllTools();
    const after = host._snapshotMcpAvailability();
    const serverDiff = host._diffNames(before.servers, after.servers);
    const toolDiff = host._diffNames(before.tools, after.tools);
    if (options?.notice !== false) {
      host._queueToolAvailabilityNotice({
        reason: options?.reason ?? "MCP configuration was reloaded",
        mcpServersConnected: serverDiff.added,
        mcpServersDisconnected: serverDiff.removed,
        mcpServersChanged: mcpResult.changed,
        mcpToolsAdded: toolDiff.added,
        mcpToolsRemoved: toolDiff.removed,
      });
    }

    if (host.onMcpStatus && typeof host._mcpManager.getServerStatuses === "function") {
      host.onMcpStatus(host._mcpManager.getServerStatuses());
    }

    return `MCP: ${allTools.length} tool(s)` +
      (changes.length ? ` (${changes.join("; ")})` : " (no changes)");
  }

  if (mcpServers.length > 0) {
    const { MCPClientManager } = await import("../clients/mcp/manager.js");
    host._mcpManager = new MCPClientManager(mcpServers) as unknown as MCPClientManager;
    host._mcpConnected = false;
    await host._ensureMcp();
    const allTools = host._mcpManager!.getAllTools();
    const after = host._snapshotMcpAvailability();
    const serverDiff = host._diffNames(before.servers, after.servers);
    const toolDiff = host._diffNames(before.tools, after.tools);
    if (options?.notice !== false) {
      host._queueToolAvailabilityNotice({
        reason: options?.reason ?? "MCP configuration was reloaded",
        mcpServersConnected: serverDiff.added,
        mcpServersDisconnected: serverDiff.removed,
        mcpToolsAdded: toolDiff.added,
        mcpToolsRemoved: toolDiff.removed,
      });
    }

    if (host.onMcpStatus && typeof host._mcpManager!.getServerStatuses === "function") {
      host.onMcpStatus(host._mcpManager!.getServerStatuses());
    }

    return `MCP: initialized ${mcpServers.length} server(s), ${allTools.length} tool(s)`;
  }

  return "MCP: no servers configured";
}

export async function reconnectMcpServer(host: McpHost, serverName: string): Promise<boolean> {
  if (!host._mcpManager || typeof host._mcpManager.reconnectServer !== "function") return false;
  const before = host._snapshotMcpAvailability();
  const ok = await host._mcpManager.reconnectServer(serverName);
  host._mcpConnected = false;
  await host._ensureMcp();
  const after = host._snapshotMcpAvailability();
  const serverDiff = host._diffNames(before.servers, after.servers);
  const toolDiff = host._diffNames(before.tools, after.tools);
  host._queueToolAvailabilityNotice({
    reason: `the user reconnected MCP server '${serverName}'`,
    mcpServersConnected: serverDiff.added,
    mcpServersDisconnected: serverDiff.removed,
    mcpServersChanged: [serverName],
    mcpToolsAdded: toolDiff.added,
    mcpToolsRemoved: toolDiff.removed,
  });
  if (host.onMcpStatus && typeof host._mcpManager.getServerStatuses === "function") {
    host.onMcpStatus(host._mcpManager.getServerStatuses());
  }
  return ok;
}

// Command-facing MCP mutation: acquire the turn lock so the connect/disconnect
// (and the ride-along notice it queues) cannot overlap a turn's tool snapshot.
// The bare reloadMcp/reconnectMcpServer stay lock-free on purpose —the reload
// path that needs them runs either inside a turn's tool execution or wrapped by
// a command-side _withTurnLock, and _withTurnLock is not reentrant, so
// re-locking there would deadlock.
export async function reloadMcpFromCommand(host: McpHost, reason: string): Promise<string> {
  return host._withTurnLock(() => host.reloadMcp({ reason }));
}

export async function reconnectMcpServerFromCommand(host: McpHost, serverName: string): Promise<boolean> {
  return host._withTurnLock(() => host.reconnectMcpServer(serverName));
}

// The /mcp command warms up MCP status before showing the picker. That ensure
// can connect servers (mutating agent.tools), so it must serialize against
// turns just like the reload/reconnect variants —no MCP connection work on
// the command side may run concurrently with a turn's tool snapshot.
export async function ensureMcpReadyFromCommand(host: McpHost): Promise<void> {
  return host._withTurnLock(() => host.ensureMcpReady());
}
