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
import type { LogEntry } from "../context/entry/types.js";
import type { PermissionMode } from "../permissions/index.js";
import { projectToTuiEntries } from "../context/projection/tui.js";
import { randomSessionId } from "../config/storage-layout.js";
import { saveGlobalSettingsPatch } from "../config/settings/io.js";
import { SessionStore } from "../config/session-store.js";
import { applySessionRestore } from "../session/resume.js";
import { getSubAgentThinkingLevels } from "../config/model-capabilities.js";
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from "./protocol.js";
import {
  buildAgentRuntimeSettings,
  buildHooksStatus,
  buildMcpStatus,
  buildMeta,
  buildStatus,
} from "./session-status-payloads.js";
import { forkSessionDirectory } from "./session-fork.js";
import {
  expectObject,
  expectPermissionMode,
  expectString,
  optNumber,
  optString,
} from "./rpc-arg-guards.js";

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


interface SessionStoreAccess {
  _store?: {
    sessionDir?: string;
  };
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

  const saveSessionLog = (): boolean => {
    const currentDir = getCurrentSessionDir();
    if (!currentDir) return false;
    try {
      const { meta } = session.getLogForPersistence();
      if (meta.turnCount === 0) return true;
      return session.persistToDisk();
    } catch (err) {
      server.emit("server.stderr", {
        text: `[autosave] ${err instanceof Error ? err.message : String(err)}\n`,
      });
      return false;
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

  server.on("session.restoreSession", async (params) => {
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

    const result = await applySessionRestore(session, store, target.path);
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

  server.on("session.getTaskState", () => session.getTaskState());

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
        supportsMultimodal: m.supportsMultimodal,
        agentThinkingLevels: getSubAgentThinkingLevels(m.model).length === 0
          ? ["none"]
          : getSubAgentThinkingLevels(m.model),
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


  // ── Skills ──
  server.on("session.listSkills", () => session.getAllSkillNames());
  server.on("session.setSkillEnabled", async (params) => {
    const p = expectObject(params, "session.setSkillEnabled");
    const name = expectString(p, "name", "session.setSkillEnabled");
    const enabled = p["enabled"] === true;
    session.setSkillEnabled(name, enabled);
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
    // 与 /skills 命令一致：立即重扫并应用到当前会话，不再等待 /reload。
    const report = await session.applySkillsFromCommand();
    return {
      ok: true,
      pendingReload: false,
      added: report.added,
      removed: report.removed,
      total: report.total,
    };
  });

  server.on("session.reloadConfiguration", () => session.reloadConfigurationFromCommand());

  // ── 标题 ──
  server.on("session.setTitle", (params) => {
    const p = expectObject(params, "session.setTitle");
    const title = expectString(p, "title", "session.setTitle");
    session.setTitle(title);
    saveSessionLog();
    return { ok: true };
  });

  server.on("session.fork", (params) => {
    const p = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
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
    return forkSessionDirectory(currentDir, {
      inheritPromptCacheKey: typeof p["inheritPromptCacheKey"] === "boolean"
        ? p["inheritPromptCacheKey"]
        : session.forkInheritPromptCacheKey,
    });
  });

  // ── 运行时诊断 ──
  server.on("session.getMcpStatus", () => buildMcpStatus(session));
  server.on("session.getHooksStatus", () => buildHooksStatus(session));

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
  server.on("session.getRewindTargets", async () => session.getRewindTargetsAsync?.() ?? session.getRewindTargets());
  server.on("session.rewind", (params) => {
    const p = expectObject(params, "session.rewind");
    const toTurnIndex = optNumber(p, "toTurnIndex");
    if (typeof toTurnIndex !== "number") {
      throw new Error("session.rewind: 'toTurnIndex' must be a number");
    }
    return session.rewindConversation(toTurnIndex);
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

  // 任务清单变更（tasks.json 为权威，内存为读路径）：进程外 UI 直接拿内存态。
  const onTaskChange = (): void => {
    server.emit("task.changed", { state: session.getTaskState() });
  };
  const unsubscribeTasks = session.subscribeTaskState(onTaskChange);
  disposers.push(unsubscribeTasks);

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
    const saved = saveSessionLog();
    if (sessionDir && sessionDir !== previousDir) {
      server.emit("ready", buildMeta(session, workDir, sessionDir));
    }
    server.emit("session.saved", { revision: session.getLogRevision() });
    return saved;
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
