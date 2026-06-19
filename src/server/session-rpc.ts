/**
 * Session 的 RPC 方法绑定。
 *
 * 将精选的 `Session` 方法/属性子集映射到 JSON-RPC 方法名。
 * 每个绑定接收原始 `params`（JSON 值）并返回可 JSON 序列化的结果。
 *
 * 还订阅 Session 日志/状态变化，并向对端发出事件。
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { RpcServer } from "./rpc-transport.js";
import type { Session } from "../session.js";
import type { LogEntry } from "../context/log-entry.js";
import type { PermissionMode } from "../permissions/index.js";
import { projectToTuiEntries } from "../context/log-projection.js";
import { randomSessionId, saveGlobalSettingsPatch, saveLog, SessionStore, type AgentModelEntry, type ModelTierEntry } from "../config/persistence.js";
import { applySessionRestore } from "../session-resume.js";
import { getTierEligibleThinkingLevels, getThinkingLevels } from "../config/config.js";
import { createModelTierEntry } from "../models/selection.js";

export interface SessionRpcOptions {
  readonly session: Session;
  readonly server: RpcServer;
  readonly sessionDir: string | null;
  readonly workDir: string;
  /** 在服务器完全关闭时调用。 */
  readonly onShutdown: () => Promise<void>;
}

/** 适合 JSON 序列化的日志条目快照。 */
type SerializedLogEntry = LogEntry;

/**
 * 线路协议版本，在 `ready` 元数据中公布。当事件负载或方法契约发生不兼容变化时递增。
 * 能力字符串让客户端无需版本计算即可检测新增能力。
 */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_CAPABILITIES = [
  /** session.getProjectedLog / session.getProjectedChildLog */
  "projectedLog",
  /** ask.pending / ask.resolved 由真实运行时订阅驱动（包括子 ask） */
  "askEvents",
  /** turn.started / turn.ended 由运行时为所有回合发出（包括自动恢复） */
  "turnLifecycle",
  /** turn.ended 可能携带 status "waiting"（回合停驻在待处理 ask 上） */
  "waitingStatus",
  /** server.crashed 在致命进程错误时发出 */
  "crashEvent",
] as const;

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

interface SessionStoreAccess {
  _store?: {
    sessionDir?: string;
  };
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

interface ForkSessionPayload {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly title: string;
  readonly sourceSessionId: string;
}

const PERMISSION_MODES = new Set<PermissionMode>(["read_only", "reversible", "yolo"]);
const MODEL_TIER_LEVELS = ["high", "medium", "low"] as const;
type ModelTierLevel = typeof MODEL_TIER_LEVELS[number];

interface ModelTierStatusPayload {
  readonly tiers: readonly {
    readonly level: ModelTierLevel;
    readonly provider: string | null;
    readonly selectionKey: string | null;
    readonly modelId: string | null;
    readonly thinkingLevel: string | null;
    readonly configName: string | null;
    readonly label: string;
  }[];
}

interface AgentRuntimeSettingsPayload {
  readonly subAgentInheritMcp: boolean;
  readonly subAgentInheritHooks: boolean;
  readonly agentModelPins: number;
}

interface AgentModelPinsPayload {
  readonly templates: readonly {
    readonly name: string;
    readonly description: string | null;
    readonly provider: string | null;
    readonly selectionKey: string | null;
    readonly modelId: string | null;
    readonly thinkingLevel: string | null;
    readonly configName: string | null;
    readonly label: string;
  }[];
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

function buildStatus(s: Session): StatusPayload {
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

async function buildMcpStatus(s: Session): Promise<McpStatusPayload> {
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

function buildHooksStatus(s: Session): HooksStatusPayload {
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

function buildModelTierStatus(s: Session): ModelTierStatusPayload {
  const tiers = (s.config?.modelTiers ?? {}) as Partial<Record<ModelTierLevel, ModelTierEntry>>;
  return {
    tiers: MODEL_TIER_LEVELS.map((level) => {
      const entry = tiers[level];
      if (!entry) {
        return {
          level,
          provider: null,
          selectionKey: null,
          modelId: null,
          thinkingLevel: null,
          configName: null,
          label: "Inherits main model",
        };
      }
      const configName = typeof s.config?.findModelConfigName === "function"
        ? s.config.findModelConfigName(entry.provider, entry.model_id)
          ?? s.config.findModelConfigName(entry.provider, entry.selection_key)
        : null;
      return {
        level,
        provider: entry.provider,
        selectionKey: entry.selection_key,
        modelId: entry.model_id,
        thinkingLevel: entry.thinking_level,
        configName: configName ?? null,
        label: configName ?? `${entry.provider}:${entry.selection_key || entry.model_id}`,
      };
    }),
  };
}

function buildAgentRuntimeSettings(s: Session): AgentRuntimeSettingsPayload {
  const agentModels = s.config?.agentModels;
  return {
    subAgentInheritMcp: s.config?.subAgentInheritMcp ?? true,
    subAgentInheritHooks: s.config?.subAgentInheritHooks ?? true,
    agentModelPins: agentModels && typeof agentModels === "object"
      ? Object.keys(agentModels).length
      : 0,
  };
}

function buildAgentModelPins(s: Session): AgentModelPinsPayload {
  const pins = (s.config?.agentModels ?? {}) as Record<string, AgentModelEntry>;
  const templates = Object.entries(s.agentTemplates ?? {}).map(([name, agent]) => {
    const entry = pins[name];
    if (!entry) {
      return {
        name,
        description: typeof agent?.description === "string" && agent.description.trim()
          ? agent.description.trim()
          : null,
        provider: null,
        selectionKey: null,
        modelId: null,
        thinkingLevel: null,
        configName: null,
        label: "Uses tier or main model",
      };
    }
    const configName = typeof s.config?.findModelConfigName === "function"
      ? s.config.findModelConfigName(entry.provider, entry.model_id)
        ?? s.config.findModelConfigName(entry.provider, entry.selection_key)
      : null;
    return {
      name,
      description: typeof agent?.description === "string" && agent.description.trim()
        ? agent.description.trim()
        : null,
      provider: entry.provider,
      selectionKey: entry.selection_key,
      modelId: entry.model_id,
      thinkingLevel: entry.thinking_level,
      configName: configName ?? null,
      label: configName ?? `${entry.provider}:${entry.selection_key || entry.model_id}`,
    };
  });
  return { templates: templates.sort((a, b) => a.name.localeCompare(b.name)) };
}

function defaultTierThinkingLevel(modelId: string): string {
  if (getThinkingLevels(modelId).length === 0) return "none";
  const eligible = getTierEligibleThinkingLevels(modelId);
  if (eligible.length === 0) {
    throw new Error(`Model '${modelId}' has no eligible sub-agent thinking levels.`);
  }
  return eligible[eligible.length - 1]!;
}

function expectModelTierLevel(
  params: Record<string, unknown>,
  key: string,
  method: string,
): ModelTierLevel {
  const level = expectString(params, key, method);
  if (!MODEL_TIER_LEVELS.includes(level as ModelTierLevel)) {
    throw new Error(`${method}: '${key}' must be one of high, medium, low`);
  }
  return level as ModelTierLevel;
}

function forkSessionDirectory(sourceDir: string): ForkSessionPayload {
  if (!existsSync(join(sourceDir, "log.json"))) {
    throw new Error("session.fork: cannot fork an empty session");
  }

  const projectDir = dirname(sourceDir);
  const sourceSessionId = basename(sourceDir);
  let newSessionId = randomSessionId();
  let newDir = join(projectDir, newSessionId);
  for (let attempt = 0; existsSync(newDir) && attempt < 8; attempt += 1) {
    newSessionId = randomSessionId();
    newDir = join(projectDir, newSessionId);
  }
  if (existsSync(newDir)) {
    throw new Error("session.fork: failed to allocate a unique session directory");
  }

  try {
    cpSync(sourceDir, newDir, { recursive: true, errorOnExist: true });
  } catch (err) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`session.fork: copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const nowIso = new Date().toISOString();
    const metaPath = join(newDir, "meta.json");
    const logPath = join(newDir, "log.json");
    const meta = readJsonRecord(metaPath);
    const logData = readJsonRecord(logPath);
    const sourceTitle = firstString(meta.title, logData.title, meta.summary, logData.summary);
    const branchTitle = sourceTitle.startsWith("(branch) ")
      ? sourceTitle
      : `(branch) ${sourceTitle || sourceSessionId}`.trim();

    meta.session_id = newSessionId;
    meta.created_at = nowIso;
    meta.last_active_at = nowIso;
    meta.title = branchTitle;
    meta.forked_from_session_id = sourceSessionId;
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    logData.session_id = newSessionId;
    logData.created_at = nowIso;
    logData.updated_at = nowIso;
    logData.title = branchTitle;
    logData.forked_from_session_id = sourceSessionId;
    writeFileSync(logPath, `${JSON.stringify(logData, null, 2)}\n`);

    return {
      sessionId: newSessionId,
      sessionDir: newDir,
      title: branchTitle,
      sourceSessionId,
    };
  } catch (err) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`session.fork: metadata patch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${basename(filePath)} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function expectObject(params: unknown, method: string): Record<string, unknown> {
  if (params == null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${method}: params must be an object`);
  }
  return params as Record<string, unknown>;
}

function expectString(params: Record<string, unknown>, key: string, method: string): string {
  const v = params[key];
  if (typeof v !== "string") throw new Error(`${method}: '${key}' must be a string`);
  return v;
}

function optString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

function optNumber(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function expectPermissionMode(
  params: Record<string, unknown>,
  key: string,
  method: string,
): PermissionMode {
  const v = expectString(params, key, method);
  if (!PERMISSION_MODES.has(v as PermissionMode)) {
    throw new Error(`${method}: '${key}' must be one of read_only, reversible, yolo`);
  }
  return v as PermissionMode;
}

/**
 * 在给定服务器上注册所有 session 相关 RPC 处理器，
 * 并连接日志变化和状态转换的事件发射。
 */
export function registerSessionRpc(opts: SessionRpcOptions): { dispose: () => void } {
  const { session, server, workDir, onShutdown } = opts;
  let sessionDir = opts.sessionDir;
  const disposers: Array<() => void> = [];


  const getCurrentSessionDir = (): string | null => {
    const liveDir = (session as unknown as SessionStoreAccess)._store?.sessionDir;
    if (typeof liveDir === "string" && liveDir.length > 0) {
      sessionDir = liveDir;
      return liveDir;
    }
    return sessionDir;
  };

  const saveSessionLog = (): void => {
    const currentDir = getCurrentSessionDir();
    if (!currentDir) return;
    try {
      const { meta, entries } = session.getLogForPersistence();
      if (meta.turnCount === 0) return;
      saveLog(currentDir, meta, [...entries]);
    } catch (err) {
      server.emit("server.stderr", {
        text: `[autosave] ${err instanceof Error ? err.message : String(err)}\n`,
      });
    }
  };

  // ── 生命周期 ──
  server.on("server.hello", () => ({
    name: "swarmflow-server",
    protocolVersion: PROTOCOL_VERSION,
    capabilities: PROTOCOL_CAPABILITIES,
  }));

  server.on("server.shutdown", async () => {
    // 调度关闭，以便先返回响应。
    setImmediate(() => {
      void onShutdown();
    });
    return { ok: true };
  });

  // ── Session 元数据 ──
  server.on("session.getMeta", () => buildMeta(session, workDir, sessionDir));
  server.on("session.getStatus", () => buildStatus(session));

  server.on("session.listProjectSessions", () => {
    const store = new SessionStore({ projectPath: workDir });
    return store.listSessions();
  });

  server.on("session.restoreSession", (params) => {
    if (session.currentTurnRunning) {
      throw new Error("session.restoreSession: cannot restore while a turn is running");
    }

    const p = expectObject(params, "session.restoreSession");
    const requestedSessionId = expectString(p, "sessionId", "session.restoreSession");
    const store = new SessionStore({ projectPath: workDir });
    const target = store
      .listSessions()
      .find((item) => item.sessionId === requestedSessionId || basename(item.path) === requestedSessionId);

    if (!target) {
      throw new Error(`session.restoreSession: session not found in this workspace: ${requestedSessionId}`);
    }

    const result = applySessionRestore(session, store, target.path);
    if (!result.ok) {
      throw new Error(result.error ?? "session.restoreSession: restore failed");
    }

    sessionDir = target.path;
    const meta = buildMeta(session, workDir, sessionDir);
    server.emit("ready", meta);
    server.emit("log.changed", {
      revision: session.getLogRevision(),
      activeLogEntryId: session.activeLogEntryId,
      status: buildStatus(session),
      restored: true,
    });
    return { ...meta, warnings: result.warnings };
  });

  // ── 日志访问 ──
  server.on("session.getLogRevision", () => session.getLogRevision());

  server.on("session.getLogSnapshot", (params) => {
    const p = expectObject(params, "session.getLogSnapshot");
    const sinceRevision = optNumber(p, "sinceRevision");
    // 始终返回完整日志，因为我们不跟踪每个条目的修订版本。
    // `sinceRevision` 参数保留给未来的增量更新。
    void sinceRevision;
    const entries: SerializedLogEntry[] = [...session.log];
    return {
      revision: session.getLogRevision(),
      entries,
      activeLogEntryId: session.activeLogEntryId,
    };
  });

  server.on("session.getChildLog", (params) => {
    const p = expectObject(params, "session.getChildLog");
    const childId = expectString(p, "childId", "session.getChildLog");
    const entries = session.getChildSessionLog(childId);
    return entries ? [...entries] : null;
  });

  // ── 投影日志（能力 "projectedLog"） ──
  // 返回服务端计算的规范 TUI 投影（ConversationEntry[]），
  // 让进程外 UI 渲染与 TUI 相同的对话，
  // 而不是在原始 LogEntry[] 上重新实现配对/过滤。
  // 上方 raw-log 方法为旧客户端保留。
  server.on("session.getProjectedLog", () => ({
    revision: session.getLogRevision(),
    activeLogEntryId: session.activeLogEntryId,
    entries: projectToTuiEntries(session.log),
  }));

  server.on("session.getProjectedChildLog", (params) => {
    const p = expectObject(params, "session.getProjectedChildLog");
    const childId = expectString(p, "childId", "session.getProjectedChildLog");
    const entries = session.getChildSessionLog(childId);
    return entries ? projectToTuiEntries(entries) : null;
  });

  server.on("session.getChildSnapshots", () => session.getChildSessionSnapshots());

  server.on("session.getPlanState", () => session.getPlanState());

  // ── 回合提交 ──
  // 即发即忘：不要让 RPC 响应阻塞到回合完成。
  // turn.started / turn.ended 来自运行时的回合生命周期订阅（此函数底部），
  // 它覆盖回合锁内的每条失败路径（预激活失败会发出单独 ended(error)），
  // 也覆盖没有 RPC 调用者的回合（自动恢复、批准后恢复）。
  // catch 只消费 rejection，确保服务器进程不会触发 unhandledRejection。
  const fireAndForgetTurn = (run: () => Promise<unknown>): { ok: true } => {
    void run().catch(() => { /* 由运行时通过日志 + 生命周期暴露 */ });
    return { ok: true };
  };

  server.on("session.submitTurn", (params) => {
    const p = expectObject(params, "session.submitTurn");
    const input = expectString(p, "input", "session.submitTurn");
    return fireAndForgetTurn(() => session.turn(input));
  });

  server.on("session.resumePendingTurn", () =>
    fireAndForgetTurn(() => session.resumePendingTurn()));

  server.on("session.requestTurnInterrupt", () => session.requestTurnInterrupt());
  server.on("session.cancelCurrentTurn", () => {
    session.cancelCurrentTurn();
    return { ok: true };
  });
  server.on("session.interruptAllChildAgents", () => {
    session.interruptAllChildAgents();
    return { ok: true };
  });
  server.on("session.hasRunningChildAgents", () => session.hasRunningChildAgents());
  server.on("session.denyPendingAsk", () => ({ denied: session.denyPendingAsk() }));
  server.on("session.getShellReport", () => {
    const getReport = (session as unknown as { _buildShellReport?: () => string })._buildShellReport;
    return typeof getReport === "function" ? getReport.call(session) : "No shells tracked.";
  });
  server.on("session.killAllShells", () => {
    session.killAllShells();
    return { ok: true };
  });

  server.on("session.setPermissionMode", (params) => {
    const p = expectObject(params, "session.setPermissionMode");
    const mode = expectPermissionMode(p, "mode", "session.setPermissionMode");
    session.permissionMode = mode;
    server.emit("permission.changed", { mode });
    return buildStatus(session);
  });

  // ── Ask 解析 ──
  server.on("session.getPendingAsk", () => session.getPendingAsk());

  server.on("session.resolveApprovalAsk", (params) => {
    const p = expectObject(params, "session.resolveApprovalAsk");
    const askId = expectString(p, "askId", "session.resolveApprovalAsk");
    const choiceIndex = optNumber(p, "choiceIndex") ?? 0;
    session.resolveApprovalAsk(askId, choiceIndex);
    return { ok: true };
  });

  server.on("session.resolveAgentQuestionAsk", (params) => {
    const p = expectObject(params, "session.resolveAgentQuestionAsk");
    const askId = expectString(p, "askId", "session.resolveAgentQuestionAsk");
    const decision = p["decision"] as { answers: unknown[] } | undefined;
    if (!decision || !Array.isArray(decision.answers)) {
      throw new Error("session.resolveAgentQuestionAsk: 'decision.answers' must be an array");
    }
    session.resolveAgentQuestionAsk(askId, decision as never);
    return { ok: true };
  });

  // ── 模型选择 ──
  server.on("session.listAvailableModels", () => {
    const cfg = session.config;
    return cfg.modelNames.map((name) => {
      const m = cfg.getModel(name);
      return {
        name,
        provider: m.provider,
        model: m.model,
        contextLength: m.contextLength,
        supportsThinking: m.supportsThinking,
        supportsMultimodal: m.supportsMultimodal,
        tierThinkingLevels: getThinkingLevels(m.model).length === 0
          ? ["none"]
          : getTierEligibleThinkingLevels(m.model),
      };
    });
  });

  server.on("session.selectModel", (params) => {
    const p = expectObject(params, "session.selectModel");
    const name = expectString(p, "name", "session.selectModel");
    session.switchModel(name);
    server.emit("model.changed", { name });
    return buildMeta(session, workDir, sessionDir);
  });

  server.on("session.getModelTiers", () => buildModelTierStatus(session));

  server.on("session.setModelTier", (params) => {
    const p = expectObject(params, "session.setModelTier");
    const level = expectModelTierLevel(p, "level", "session.setModelTier");
    const current = (session.config?.modelTiers ?? {}) as Partial<Record<ModelTierLevel, ModelTierEntry>>;
    const next: Partial<Record<ModelTierLevel, ModelTierEntry>> = { ...current };
    const modelName = p["modelName"];

    if (modelName === null || modelName === undefined || modelName === "") {
      delete next[level];
    } else {
      if (typeof modelName !== "string") {
        throw new Error("session.setModelTier: 'modelName' must be a string or null");
      }
      const modelConfig = session.config.getModel(modelName);
      const thinkingLevel = optString(p, "thinkingLevel")
        ?? defaultTierThinkingLevel(modelConfig.model);
      const entry = createModelTierEntry({
        provider: modelConfig.provider,
        selectionKey: modelConfig.model,
        modelId: modelConfig.model,
      }, thinkingLevel);
      next[level] = entry;
    }

    saveGlobalSettingsPatch({ model_tiers: next });
    const mutableConfig = session.config as unknown as { _modelTiers?: typeof next };
    if (mutableConfig._modelTiers !== undefined) {
      mutableConfig._modelTiers = next;
    }
    server.emit("model.tiers.changed", buildModelTierStatus(session));
    return buildModelTierStatus(session);
  });

  server.on("session.getAgentRuntimeSettings", () => buildAgentRuntimeSettings(session));

  server.on("session.setAgentRuntimeSettings", (params) => {
    const p = expectObject(params, "session.setAgentRuntimeSettings");
    const mutableConfig = session.config as unknown as {
      _subAgentInheritMcp?: boolean;
      _subAgentInheritHooks?: boolean;
    };
    const patch: {
      sub_agent_inherit_mcp?: boolean;
      sub_agent_inherit_hooks?: boolean;
    } = {};

    if (typeof p["subAgentInheritMcp"] === "boolean") {
      patch.sub_agent_inherit_mcp = p["subAgentInheritMcp"];
      if (mutableConfig._subAgentInheritMcp !== undefined) {
        mutableConfig._subAgentInheritMcp = p["subAgentInheritMcp"];
      }
    }
    if (typeof p["subAgentInheritHooks"] === "boolean") {
      patch.sub_agent_inherit_hooks = p["subAgentInheritHooks"];
      if (mutableConfig._subAgentInheritHooks !== undefined) {
        mutableConfig._subAgentInheritHooks = p["subAgentInheritHooks"];
      }
    }

    if (Object.keys(patch).length > 0) saveGlobalSettingsPatch(patch);
    server.emit("agent.runtime.changed", buildAgentRuntimeSettings(session));
    return buildAgentRuntimeSettings(session);
  });

  server.on("session.getAgentModelPins", () => buildAgentModelPins(session));

  server.on("session.setAgentModelPin", (params) => {
    const p = expectObject(params, "session.setAgentModelPin");
    const templateName = expectString(p, "templateName", "session.setAgentModelPin");
    if (!session.agentTemplates?.[templateName]) {
      throw new Error(`session.setAgentModelPin: unknown template '${templateName}'`);
    }

    const current = (session.config?.agentModels ?? {}) as Record<string, AgentModelEntry>;
    const next: Record<string, AgentModelEntry> = { ...current };
    const modelName = p["modelName"];

    if (modelName === null || modelName === undefined || modelName === "") {
      delete next[templateName];
    } else {
      if (typeof modelName !== "string") {
        throw new Error("session.setAgentModelPin: 'modelName' must be a string or null");
      }
      const modelConfig = session.config.getModel(modelName);
      const thinkingLevel = optString(p, "thinkingLevel")
        ?? defaultTierThinkingLevel(modelConfig.model);
      next[templateName] = createModelTierEntry({
        provider: modelConfig.provider,
        selectionKey: modelConfig.model,
        modelId: modelConfig.model,
      }, thinkingLevel);
    }

    saveGlobalSettingsPatch({ agent_models: next });
    const mutableConfig = session.config as unknown as { _agentModels?: typeof next };
    if (mutableConfig._agentModels !== undefined) {
      mutableConfig._agentModels = next;
    }
    server.emit("agent.models.changed", buildAgentModelPins(session));
    return buildAgentModelPins(session);
  });

  // ── Skills ──
  server.on("session.listSkills", () => session.getAllSkillNames());
  server.on("session.setSkillEnabled", (params) => {
    const p = expectObject(params, "session.setSkillEnabled");
    const name = expectString(p, "name", "session.setSkillEnabled");
    const enabled = p["enabled"] === true;
    session.setSkillEnabled(name, enabled);
    const report = session.reloadSkills();
    const disabledSkills = session
      .getAllSkillNames()
      .filter((skill) => !skill.enabled)
      .map((skill) => skill.name);
    try {
      saveGlobalSettingsPatch({
        disabled_skills: disabledSkills.length > 0 ? disabledSkills : undefined,
      });
    } catch {
      // 运行时 skill 状态已经更新；持久化尽力而为。
    }
    return { ok: true, report };
  });

  // ── 标题 ──
  server.on("session.setTitle", (params) => {
    const p = expectObject(params, "session.setTitle");
    const title = expectString(p, "title", "session.setTitle");
    session.setTitle(title);
    saveSessionLog();
    return { ok: true };
  });

  server.on("session.fork", () => {
    if (session.currentTurnRunning) {
      throw new Error("session.fork: cannot fork while a turn is running");
    }
    const childSnapshots = typeof session.getChildSessionSnapshots === "function"
      ? session.getChildSessionSnapshots()
      : [];
    const liveChildren = childSnapshots.filter((child) => (
      child.lifecycle === "running" || child.lifecycle === "blocked"
    ));
    if (liveChildren.length > 0) {
      throw new Error("session.fork: cannot fork while sub-agents are running");
    }

    saveSessionLog();
    const currentDir = getCurrentSessionDir();
    if (!currentDir) {
      throw new Error("session.fork: no active persisted session");
    }
    return forkSessionDirectory(currentDir);
  });

  // ── 运行时诊断 ──
  server.on("session.getMcpStatus", () => buildMcpStatus(session));
  server.on("session.getHooksStatus", () => buildHooksStatus(session));

  // ── 手动上下文命令 ──
  server.on("session.summarize", (params) => {
    const p = expectObject(params, "session.summarize");
    const targetContextIds = p["targetContextIds"] as string[] | undefined;
    const focusPrompt = optString(p, "focusPrompt");
    return fireAndForgetTurn(() => session.runManualSummarize({
      targetContextIds: targetContextIds ?? undefined,
      focusPrompt: focusPrompt ?? undefined,
    }));
  });

  server.on("session.compact", (params) => {
    const p = expectObject(params, "session.compact");
    const instruction = optString(p, "instruction");
    return fireAndForgetTurn(() => session.runManualCompact(instruction));
  });

  // ── 后台 shell（徽章 / 选择器 / 详情页签） ──
  server.on("session.getBackgroundShellSnapshots", () => session.getBackgroundShellSnapshots());
  server.on("session.getBackgroundShellDetail", (params) => {
    const p = expectObject(params, "session.getBackgroundShellDetail");
    const id = optString(p, "id");
    if (!id) throw new Error("session.getBackgroundShellDetail: 'id' is required");
    const maxChars = optNumber(p, "maxChars");
    return session.getBackgroundShellDetail(id, maxChars !== undefined ? { maxChars } : undefined);
  });
  server.on("session.stopBackgroundShell", async (params) => {
    const p = expectObject(params, "session.stopBackgroundShell");
    const id = optString(p, "id");
    if (!id) throw new Error("session.stopBackgroundShell: 'id' is required");
    return { message: await session.stopBackgroundShell(id) };
  });

  // ── 回退 ──
  server.on("session.getRewindTargets", () => session.getRewindTargets());
  server.on("session.rewind", (params) => {
    const p = expectObject(params, "session.rewind");
    const toTurnIndex = optNumber(p, "toTurnIndex");
    if (typeof toTurnIndex !== "number") {
      throw new Error("session.rewind: 'toTurnIndex' must be a number");
    }
    return session.rewindConversation(toTurnIndex);
  });

  // ── 总结选择器支持 ──
  server.on("session.getSummarizeTargets", () => session.getSummarizeTargets());
  server.on("session.getContextIdsForTurnRange", (params) => {
    const p = expectObject(params, "session.getContextIdsForTurnRange");
    const startTurn = optNumber(p, "startTurn");
    const endTurn = optNumber(p, "endTurn");
    if (typeof startTurn !== "number" || typeof endTurn !== "number") {
      throw new Error("session.getContextIdsForTurnRange: 'startTurn' and 'endTurn' must be numbers");
    }
    return session.getContextIdsForTurnRange(startTurn, endTurn);
  });

  // ── 订阅 ──
  // 合并日志变化发射：TUI 每回合会触发数百次 subscribeLog。
  // 我们调度一个微任务，用最新 revision 只发射一次。
  let pendingLogEmit = false;
  let lastEmittedRevision = -1;
  const onLogChange = (): void => {
    if (pendingLogEmit) return;
    pendingLogEmit = true;
    queueMicrotask(() => {
      pendingLogEmit = false;
      const revision = session.getLogRevision();
      if (revision === lastEmittedRevision) return;
      lastEmittedRevision = revision;
      server.emit("log.changed", {
        revision,
        activeLogEntryId: session.activeLogEntryId,
        status: buildStatus(session),
      });
    });
  };
  const unsubscribeLog = session.subscribeLog(onLogChange);
  disposers.push(unsubscribeLog);

  const onPlanChange = (): void => {
    server.emit("plan.changed", { state: session.getPlanState() });
  };
  const unsubscribePlan = session.subscribePlan(onPlanChange);
  disposers.push(unsubscribePlan);

  // Ask 事件 — 由运行时真实 ask 订阅驱动（能力 "askEvents"）。
  // 与旧的日志变化轮询不同，这也会观察永远不会触及根日志的子 session ask。
  // 对旧客户端而言，线路事件和去重行为保持不变。
  let lastAskId: string | null = null;
  const onAskChange = (): void => {
    const ask = session.getPendingAsk();
    const askId = ask?.id ?? null;
    if (askId !== lastAskId) {
      lastAskId = askId;
      if (ask) server.emit("ask.pending", ask);
      else server.emit("ask.resolved", {});
    }
  };
  const unsubscribeAsk = session.subscribeAsk(onAskChange);
  disposers.push(unsubscribeAsk);

  // 回合生命周期 — 从运行时转发（能力 "turnLifecycle"）。
  // 覆盖每次 activation-loop 运行，包括没有 RPC 调用者的自动恢复和批准后恢复回合。
  // 状态 "waiting" 表示回合停驻在待处理 ask 上（能力 "waitingStatus"）。
  const unsubscribeLifecycle = session.subscribeTurnLifecycle((event) => {
    if (event.phase === "started") {
      server.emit("turn.started", { turnCount: session.turnCount });
      return;
    }
    server.emit("turn.ended", {
      status: event.status,
      turnCount: session.turnCount,
      ...(event.error !== undefined ? { error: event.error } : {}),
    });
  });
  disposers.push(unsubscribeLifecycle);

  // 检查点保存：Session 期望外部持久化器。
  session.onSaveRequest = () => {
    const previousDir = sessionDir;
    saveSessionLog();
    if (sessionDir && sessionDir !== previousDir) {
      server.emit("ready", buildMeta(session, workDir, sessionDir));
    }
    server.emit("session.saved", { revision: session.getLogRevision() });
  };

  return {
    dispose: () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          // ignore
        }
      }
    },
  };
}
