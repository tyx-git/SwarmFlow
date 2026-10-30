/** /mcp MCP 服务器列表与启停。 */

import { join } from "node:path";

import { loadGlobalSettings } from "../../config/settings/io.js";

import { persistSettingsPatch } from "../settings-patch.js";
import {
  type CommandContext,
  type CommandOption,
  type CommandOptionsContext,
  type SemanticColor,
} from "../types.js";

/**
 * 从设置中读取完整的 MCP 服务器列表（含已禁用项）。
 * 这是选择器的数据源——与 MCPClientManager 分开，后者只认识
 * 活跃（未禁用）的服务器。
 */
function getAllMcpServerNames(homeDir?: string): Map<string, { disabled: boolean }> {
  const settings = loadGlobalSettings(homeDir);
  const result = new Map<string, { disabled: boolean }>();
  if (settings.mcp_servers) {
    for (const [name, cfg] of Object.entries(settings.mcp_servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      result.set(name, { disabled: cfg.disabled === true });
    }
  }
  return result;
}

export function mcpOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const mcpManager = session?.mcpManager;
  const allServers = getAllMcpServerNames();
  if (allServers.size === 0 && !mcpManager) return [];

  // 来自MCPClientManager的运行时状态（仅限活动服务器）
  const statusMap = new Map<string, { state: string; toolCount: number; error?: string }>();
  if (mcpManager && typeof mcpManager.getServerStatuses === "function") {
    for (const s of mcpManager.getServerStatuses()) {
      statusMap.set(s.name, s);
    }
  }

  // 按服务器分组的工具
  const toolsByServer = new Map<string, string[]>();
  if (mcpManager) {
    for (const tool of mcpManager.getAllTools()) {
      const parts = tool.name.split("__");
      const server = parts.length >= 3 ? parts[1] : "unknown";
      if (!toolsByServer.has(server)) toolsByServer.set(server, []);
      toolsByServer.get(server)!.push(parts.length >= 3 ? parts.slice(2).join("__") : tool.name);
    }
  }

  const opts: CommandOption[] = [
    { label: "Reload config", value: "__reload__" },
  ];

  for (const [name, { disabled }] of allServers) {
    const status = statusMap.get(name);
    const children: CommandOption[] = [];

    if (disabled) {
      children.push({ label: "Enable", value: `${name}:enable` });
      opts.push({
        label: name,
        labelParts: [
          { text: name },
          { text: " · " },
          { text: "✗", color: "muted" },
          { text: " Disabled" },
        ],
        value: name,
        children,
      });
    } else {
      const connected = status?.state === "connected";
      const stateLabel = status?.state
        ? status.state.charAt(0).toUpperCase() + status.state.slice(1)
        : "Not connected";

      const parts: Array<{ text: string; color?: SemanticColor }> = [
        { text: name },
        { text: " · " },
        { text: connected ? "✓" : "✗", color: connected ? "success" : "error" },
        { text: ` ${stateLabel}` },
      ];
      if (connected && status!.toolCount > 0) {
        parts.push({ text: ` · ${status!.toolCount} tools` });
      }
      if (!connected && status?.error) {
        parts.push({ text: ` · ${status.error}` });
      }

      children.push({ label: "Reconnect", value: `${name}:reconnect` });
      children.push({ label: "Disable", value: `${name}:disable` });
      const serverTools = toolsByServer.get(name) ?? [];
      if (serverTools.length > 0) {
        children.push({
          label: `View tools (${serverTools.length})`,
          value: `${name}:tools`,
          children: serverTools.map((t) => ({ label: t, value: "", disabled: true })),
        });
      }

      opts.push({
        label: name,
        labelParts: parts,
        value: name,
        children,
      });
    }
  }

  return opts;
}

function setMcpServerDisabled(serverName: string, disabled: boolean, homeDir?: string): boolean {
  const settings = loadGlobalSettings(homeDir);
  const servers = settings.mcp_servers;
  if (!servers || !servers[serverName]) return false;

  if (disabled) {
    servers[serverName].disabled = true;
  } else {
    delete servers[serverName].disabled;
  }
  persistSettingsPatch({ mcp_servers: servers }, homeDir);
  return true;
}

export async function cmdMcp(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const hint = ctx.showHint ?? ctx.showMessage;

  // 优先使用带 turn lock 的命令变体，避免 MCP 重载与回合重叠；
  // 旧会话形状回退到不带锁的方法。
  const reloadMcpLocked = (reason: string): Promise<string> =>
    typeof session.reloadMcpFromCommand === "function"
      ? session.reloadMcpFromCommand(reason)
      : session.reloadMcp({ reason });

  // 确保 MCP 已就绪（已连接时无操作）。使用带 turn lock 的变体，
  // 避免连接预热与回合重叠。
  try {
    if (typeof session.ensureMcpReadyFromCommand === "function") {
      await session.ensureMcpReadyFromCommand();
    } else if (typeof session.ensureMcpReady === "function") {
      await session.ensureMcpReady();
    }
  } catch { /* 继续-状态将显示失败 */ }

  const allServers = getAllMcpServerNames(ctx.swarmflowHomeDir);
  if (allServers.size === 0) {
    ctx.showMessage(
      "No MCP servers configured.\n" +
      "Add servers to settings.json under \"mcp_servers\".",
    );
    return;
  }

  let action = args.trim();

  if (!action && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      mcpOptions({ session, store: ctx.store }),
      { title: "MCP Servers" },
    );
    if (!picked) return;
    action = picked.value;
  }

  if (action === "__reload__") {
    try {
      hint("Reloading MCP servers…");
      const report = await reloadMcpLocked("the user reloaded MCP configuration");
      hint(report);
    } catch (err) {
      hint(`Reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const colonIdx = action.indexOf(":");
  if (colonIdx > 0) {
    const serverName = action.slice(0, colonIdx);
    const op = action.slice(colonIdx + 1);
    const mcpManager = session.mcpManager;

    if (op === "reconnect") {
      hint(`Connecting MCP server '${serverName}'…`);
      if (typeof session.reconnectMcpServerFromCommand === "function") {
        const ok = await session.reconnectMcpServerFromCommand(serverName);
        hint(ok ? `${serverName}: reconnected` : `${serverName}: reconnect failed`);
      } else if (typeof session.reconnectMcpServer === "function") {
        const ok = await session.reconnectMcpServer(serverName);
        hint(ok ? `${serverName}: reconnected` : `${serverName}: reconnect failed`);
      } else if (mcpManager && typeof mcpManager.reconnectServer === "function") {
        const ok = await mcpManager.reconnectServer(serverName);
        hint(ok ? `${serverName}: reconnected` : `${serverName}: reconnect failed`);
        if (session.onMcpStatus && typeof mcpManager.getServerStatuses === "function") {
          session.onMcpStatus(mcpManager.getServerStatuses());
        }
      }
      return;
    }

    if (op === "disable" || op === "enable") {
      const disabled = op === "disable";
      if (setMcpServerDisabled(serverName, disabled, ctx.swarmflowHomeDir)) {
        try {
          if (!disabled) hint(`Connecting MCP server '${serverName}'…`);
          const report = await reloadMcpLocked(
            `the user ${disabled ? "disabled" : "enabled"} MCP server '${serverName}'`,
          );
          hint(`${serverName}: ${disabled ? "disabled" : "enabled"} (${report})`);
        } catch (err) {
          hint(`${serverName}: ${disabled ? "disabled" : "enabled"} (reload failed: ${err instanceof Error ? err.message : String(err)})`);
        }
      } else {
        hint(`Server "${serverName}" not found in settings.`);
      }
      return;
    }
  }

  // 非交互式环境的回退
  const enabledCount = [...allServers.values()].filter((s) => !s.disabled).length;
  hint(`MCP: ${allServers.size} server(s), ${enabledCount} enabled. Use picker for details.`);
}
