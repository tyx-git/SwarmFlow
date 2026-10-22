/**
 * session RPC 的状态快照负载：类型与各域的构造器。
 */

import { basename, join } from "node:path";

import type { Session } from "../session.js";

import type { PermissionMode } from "../permissions/index.js";

import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from "./protocol.js";

interface MetaPayload {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly displayName: string;
  readonly sessionDir: string | null;
  readonly workDir: string;
  readonly modelConfigName: string;
  readonly modelProvider: string;
  readonly thinkingLevel: string;
  readonly accentColor: string | undefined;
  readonly turnCount: number;
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
}

interface StatusPayload {
  readonly currentTurnRunning: boolean;
  readonly sessionPhase: string;
  readonly lastTurnEndStatus: string | null;
  readonly pendingInboxCount: number;
  readonly lifetimeToolCallCount: number;
  readonly lastToolCallSummary: string;
  readonly lastInputTokens: number;
  readonly lastTotalTokens: number;
  readonly lastCacheReadTokens: number;
  readonly contextBudget: number;
  readonly activeLogEntryId: string | null;
  readonly hasPendingTurn: boolean;
  readonly permissionMode: PermissionMode;
}

interface McpStatusPayload {
  readonly configured: boolean;
  readonly error: string | null;
  readonly toolCount: number;
  readonly servers: readonly {
    readonly name: string;
    readonly state: string | null;
    readonly error: string | null;
    readonly tools: readonly string[];
  }[];
}

interface HooksStatusPayload {
  readonly available: boolean;
  readonly hooks: readonly {
    readonly name: string;
    readonly scope: string;
    readonly event: string;
    readonly matcher: string | null;
    readonly command: string;
    readonly failClosed: boolean;
  }[];
}

export interface ForkSessionPayload {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly title: string;
  readonly sourceSessionId: string;
}

interface AgentRuntimeSettingsPayload {
  readonly subAgentInheritMcp: boolean;
  readonly subAgentInheritHooks: boolean;
}
export function buildMeta(s: Session, workDir: string, sessionDir: string | null): MetaPayload {
  return {
    sessionId: sessionDir ? basename(sessionDir) : s.createdAt,
    title: s.getTitle(),
    displayName: s.getDisplayName(),
    sessionDir,
    workDir,
    modelConfigName: s.currentModelConfigName ?? "",
    modelProvider: s.primaryAgent?.modelConfig?.provider ?? "",
    thinkingLevel: s.thinkingLevel ?? "none",
    accentColor: s.accentColor,
    turnCount: s.turnCount,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: PROTOCOL_CAPABILITIES,
  };
}

export function buildStatus(s: Session): StatusPayload {
  return {
    currentTurnRunning: s.currentTurnRunning,
    sessionPhase: s.sessionPhase,
    lastTurnEndStatus: s.lastTurnEndStatus,
    pendingInboxCount: s.pendingInboxCount,
    lifetimeToolCallCount: s.lifetimeToolCallCount,
    lastToolCallSummary: s.lastToolCallSummary,
    lastInputTokens: s.lastInputTokens,
    lastTotalTokens: s.lastTotalTokens,
    lastCacheReadTokens: s.lastCacheReadTokens,
    contextBudget: s.contextBudget,
    activeLogEntryId: s.activeLogEntryId,
    hasPendingTurn: s.hasPendingTurnToResume(),
    permissionMode: s.permissionMode,
  };
}

export async function buildMcpStatus(s: Session): Promise<McpStatusPayload> {
  const manager = s.mcpManager;
  if (!manager) {
    return { configured: false, error: null, toolCount: 0, servers: [] };
  }

  try {
    if (typeof s.ensureMcpReady === "function") {
      await s.ensureMcpReady();
    } else if (typeof manager.connectAll === "function") {
      await manager.connectAll();
    }
  } catch (err) {
    return {
      configured: true,
      error: err instanceof Error ? err.message : String(err),
      toolCount: 0,
      servers: [],
    };
  }

  const tools = typeof manager.getAllTools === "function" ? manager.getAllTools() : [];
  const statuses = typeof manager.getServerStatuses === "function"
    ? manager.getServerStatuses()
    : [];
  const byServer = new Map<string, string[]>();

  for (const tool of tools) {
    const name = typeof tool.name === "string" ? tool.name : "";
    const parts = name.split("__");
    const server = parts.length >= 3 ? parts[1]! : "unknown";
    const originalName = parts.length >= 3 ? parts.slice(2).join("__") : name;
    const list = byServer.get(server) ?? [];
    if (originalName) list.push(originalName);
    byServer.set(server, list);
  }

  for (const status of statuses) {
    if (!byServer.has(status.name)) byServer.set(status.name, []);
  }

  return {
    configured: true,
    error: null,
    toolCount: tools.length,
    servers: [...byServer.entries()].map(([name, serverTools]) => {
      const status = statuses.find((item) => item.name === name);
      return {
        name,
        state: typeof status?.state === "string" ? status.state : null,
        error: typeof status?.error === "string" ? status.error : null,
        tools: [...serverTools].sort(),
      };
    }),
  };
}

export function buildHooksStatus(s: Session): HooksStatusPayload {
  const runtime = s.hookRuntime;
  if (!runtime) return { available: false, hooks: [] };
  const hooks = Array.isArray(runtime.hooks) ? runtime.hooks : [];
  return {
    available: true,
    hooks: hooks.map((hook) => {
      const matcher = hook.matcher
        ? [
            ...(hook.matcher.toolNames ?? []),
            ...(hook.matcher.agentIds ?? []),
          ].join(", ")
        : "";
      return {
        name: hook.name,
        scope: hook._scope ?? "unknown",
        event: hook.event,
        matcher: matcher.length > 0 ? matcher : null,
        command: `${hook.command}${hook.args?.length ? ` ${hook.args.join(" ")}` : ""}`,
        failClosed: hook.failClosed ?? false,
      };
    }),
  };
}

export function buildAgentRuntimeSettings(s: Session): AgentRuntimeSettingsPayload {
  return {
    subAgentInheritMcp: s.config?.subAgentInheritMcp ?? true,
    subAgentInheritHooks: s.config?.subAgentInheritHooks ?? true,
  };
}
