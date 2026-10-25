/**
 * 会话恢复的解析/提交编排与持久化快照。
 *
 * 唯一的状态写入点 `_applyRestoredState` 仍留在 Session（它必须紧邻字段声明）；
 * 这里只负责"在克隆数据上解析 → 提交到活会话 → 产出持久化 meta"。
 */

import type { LogEntry } from "../context/entry/types.js";
import { LogIdAllocator } from "../context/entry/id-allocator.js";
import { createLogSessionMeta, type LogSessionMeta } from "../config/session-meta.js";
import type { SessionStore } from "../config/session-store.js";
import type { Agent } from "../agents/agent.js";
import type { Config } from "../config/loader.js";
import { resolvePersistedModelSelection, type PersistedModelSelection } from "../models/selection.js";
import type { ChildSessionManager } from "./children/manager.js";
import type { PreparedChildRestore } from "./children/types.js";
import { parseRestoredState, type RestoredSessionState } from "./log-surgery.js";
import {
  migrateMessageEnvelope,
  type ArchivedChildRecord,
  type ChildSessionLifecycle,
  type ChildSessionMetaRecord,
  type ChildSessionPhase,
  type MessageEnvelope,
} from "./tree-types.js";

/** 解析完成、尚未提交的恢复结果。 */
export interface PreparedSessionRestore {
  rootState: RestoredSessionState;
  children: PreparedChildRestore[];
  archivedRecords?: ArchivedChildRecord[];
  rootInbox?: MessageEnvelope[];
  warnings: string[];
}

/** 恢复/持久化所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface RestoreHost {
  primaryAgent: Agent;
  config: Config;
  _store: SessionStore | undefined;
  _sessionArtifactsOverride: string;
  _getArtifactsDirIfAvailable(): string | undefined;
  _childSessionManagerInstance: ChildSessionManager;
  _conversationStarted: boolean;
  _persistedModelSelection: PersistedModelSelection;
  _createdAt: string;
  _initialModel: string;
  _title: string | undefined;
  _promptCacheKey: string;
  _inbox: MessageEnvelope[];
  _turnCount: number;
  _compactCount: number;
  workCount: number;
  idCounters: Record<string, number>;
  lifetimeToolCallCount: number;
  lastToolCallSummary: string;
  recentSessionEvents: readonly string[];
  lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  sessionPhase: ChildSessionPhase;
  usageTotals: { input: number; output: number; cacheRead: number };
  usageFirstInput: number;
  usageFirstUserMessageTokens: number;
  _thinkingLevel: string;
  _currentTurnSignal: AbortSignal | null;
  _currentTurnAbortController: AbortController | null;
  _turnInFlight: Promise<string | void> | null;
  _subAgentCounter: number;
  _childSessions: Map<string, import("./children/types.js").ChildSessionHandle>;
  _archivedChildren: Map<string, ArchivedChildRecord>;
  _projectRoot: string;
  _describeInitialModel(): string;
  _generateSummary(): string;
  _resetTransientState(): void;
  _resetHookContextForNewSession(): void;
  _applyRestoredState(state: RestoredSessionState): void;
  _bumpLogRevision(): void;
  _notifyLogListeners(): void;
  _entriesHaveRealUserMessage(entries: Iterable<LogEntry>): boolean;
  _log: LogEntry[];
  _mcpConnected: boolean;
  prepareRestoreFromLog(meta: LogSessionMeta, entries: LogEntry[], idAllocator: LogIdAllocator): PreparedSessionRestore;
  commitPreparedRestore(prepared: PreparedSessionRestore): string[];
}
/**
 * Restore session from a loaded log.
 */
export function prepareRestoreFromLog(host: RestoreHost, 
  meta: LogSessionMeta,
  entries: LogEntry[],
  _idAllocator: LogIdAllocator,
  opts?: { bounded?: boolean },
): PreparedSessionRestore {
  if ((meta.childSessions?.length ?? 0) > 0 && !host._sessionArtifactsOverride && !host._getArtifactsDirIfAvailable()) {
    throw new Error(
      "Cannot restore child sessions before the session store is bound to the target session directory.",
    );
  }

  // Parse on cloned data —everything that can fail (model resolution, log
  // surgery) happens here, so a failed restore never pollutes the live
  // session (see session/log-surgery.ts).
  const clonedEntries = structuredClone(entries) as LogEntry[];
  const clonedAllocator = new LogIdAllocator();
  // 有界恢复只带窗口条目；已截断/标记前的前缀计数从 meta.json 补。
  clonedAllocator.restoreCounters(meta.idCounters);
  clonedAllocator.mergeFrom(clonedEntries);
  const rootState = parseRestoredState(
    {
      bounded: opts?.bounded === true,
      resolveModelSelection: (m) => resolvePersistedModelSelection(host, {
        modelConfigName: m.modelConfigName || undefined,
        modelProvider: m.modelProvider,
        modelSelectionKey: m.modelSelectionKey,
        modelId: m.modelId,
      }),
      getModelConfig: (configName) => host.config.getModel(configName),
      describeInitialModelFallback: () => host._describeInitialModel(),
      fallbackCreatedAt: host._createdAt,
      agentName: host.primaryAgent.name,
    },
    meta,
    clonedEntries,
    clonedAllocator,
  );

  const warnings: string[] = [];
  const allChildMeta = meta.childSessions ?? [];
  // Restore ALL children as full Session instances (including archived) so
  // TUI can display them and read their logs. _archivedChildren is only
  // populated on close/reset, not on restore.
  const children = host._childSessionManagerInstance.prepareChildRestores(allChildMeta, warnings);

  // Root inbox from meta
  const rootInbox = (meta.inbox ?? []).map((raw) => migrateMessageEnvelope(raw as unknown as Record<string, unknown>));

  return { rootState, children, rootInbox, warnings };
}

export function commitPreparedRestore(host: RestoreHost, prepared: PreparedSessionRestore): string[] {
  const warnings = [...prepared.warnings];

  host._resetTransientState();
  host._resetHookContextForNewSession();
  host._mcpConnected = false;
  host._currentTurnSignal = null;
  host._currentTurnAbortController = null;
  host._turnInFlight = null;
  host._applyRestoredState(prepared.rootState);

  host._childSessionManagerInstance.clearTables();
  host._subAgentCounter = 0;
  warnings.push(...host._childSessionManagerInstance.commitPreparedChildren(prepared.children));

  // Restore root inbox from meta
  if (prepared.rootInbox && prepared.rootInbox.length > 0) {
    host._inbox = [...prepared.rootInbox];
  }

  host._bumpLogRevision();
  host._notifyLogListeners();
  return warnings;
}

export function restoreFromLog(host: RestoreHost, 
  meta: LogSessionMeta,
  entries: LogEntry[],
  idAllocator: LogIdAllocator,
): void {
  const prepared = host.prepareRestoreFromLog(meta, entries, idAllocator);
  host.commitPreparedRestore(prepared);
}

/**
 * Get log data for persistence (v2).
 * Returns meta + entries suitable for persistToDisk().
 */
export function getLogForPersistence(host: RestoreHost): { meta: LogSessionMeta; entries: readonly LogEntry[] } {
  // Include both active and archived children in persistence meta
  const childSessionsMeta: ChildSessionMetaRecord[] = [
    ...[...host._childSessions.values()].map((handle) => ({
      id: handle.id,
      numericId: handle.numericId,
      template: handle.template,
      mode: handle.mode,
      lifecycle: handle.lifecycle,
      status: handle.status,
      outcome: handle.lastOutcome,
      terminationCause: handle.terminationCause,
      order: handle.order,
      // Released one-shots have no Session (and by definition no live
      // inbox) —this read must tolerate null or every root save after
      // the first settled one-shot would throw.
      inbox: handle.session && handle.session._inbox.length > 0
        ? [...handle.session._inbox]
        : undefined,
    })),
    ...[...host._archivedChildren.values()].map((record) => ({
      id: record.id,
      numericId: record.numericId,
      template: record.template,
      mode: record.mode,
      lifecycle: "archived" as ChildSessionLifecycle,
      status: record.status,
      outcome: record.outcome,
      terminationCause: record.terminationCause,
      order: record.order,
    })),
  ];
  return {
    meta: createLogSessionMeta({
      createdAt: host._createdAt,
      initialModel: host._initialModel,
      projectPath: host._projectRoot,
      modelConfigName: host._persistedModelSelection.modelConfigName ?? "",
      modelProvider: host._persistedModelSelection.modelProvider,
      modelSelectionKey: host._persistedModelSelection.modelSelectionKey,
      modelId: host._persistedModelSelection.modelId,
      promptCacheAffinityKey: host._promptCacheKey,
      turnCount: host._turnCount,
      compactCount: host._compactCount,
      thinkingLevel: host._thinkingLevel,
      title: host._title,
      summary: host._generateSummary(),
      childSessions: childSessionsMeta,
      inbox: host._inbox.length > 0 ? [...host._inbox] : undefined,
      workCount: host.workCount,
      idCounters: host.idCounters,
      lifetimeToolCallCount: host.lifetimeToolCallCount,
      lastToolCallSummary: host.lastToolCallSummary,
      recentSessionEvents: [...host.recentSessionEvents],
      lastTurnEndStatus: host.lastTurnEndStatus ?? undefined,
      selfPhase: host.sessionPhase,
      tokens: host.usageTotals,
      firstInput: host.usageFirstInput,
      firstUserMessageTokens: host.usageFirstUserMessageTokens,
    }),
    entries: host._log,
  };
}
