/**
 * SessionPersistence 鈥?restore parsing + log surgery (P2.5).
 *
 * Replaces the shadow-Session trick: `parseRestoredState` turns a persisted
 * log into a plain `RestoredSessionState` data structure without touching any
 * Session. Everything that can fail (model resolution, log surgery) happens
 * here, in the parse stage 鈥?so a failed restore never pollutes the live
 * session; `Session._applyRestoredState` is then a single assignment pass.
 *
 * The log-surgery functions (deny-resolve open asks, normalize an
 * interrupted turn, complete missing tool_results, finish work) are shared
 * with the LIVE interrupt paths through the `LogSurgery` interface: the parse
 * stage drives them against a plain in-memory state, while Session drives the
 * same functions against a view of itself (`_logSurgeryView`) 鈥?one
 * implementation, no restore/live drift.
 *
 * Invariants (see Docs/session-refactor-plan-2026-06-11.md):
 *   1. The live session's log revision is never reset by a restore 鈥?apply
 *      only ever bumps it, so UI subscribers always detect the swap.
 *   2. Open asks are deny-resolved BEFORE interrupted-turn normalization
 *      (ESC-deny model): normalization must see them as completed
 *      tool_call 鈫?tool_result pairs.
 *   3. A restore that throws leaves the current session untouched (all
 *      throwing work is in the parse stage, on cloned data).
 */

import { allocateContextId } from "../context/context-rendering.js";
import {
  LogIdAllocator,
  createAskResolution,
  createToolResult as createToolResultEntry,
  createUserMessage as createUserMessageEntry,
  createWorkEnd,
  createWorkStart,
  type LogEntry,
} from "../context/log-entry.js";
import type { LogSessionMeta } from "../config/persistence.js";
import type { ModelConfig } from "../config/config.js";
import type { AskAuditRecord } from "../ask.js";
import type { ChildSessionPhase } from "../session-tree-types.js";
import type { PersistedModelSelection } from "../models/selection.js";
import { stampProviderRoundId } from "./session-log.js";

/** Tools whose interruption cannot leave partial effects behind. */
export const SAFE_INTERRUPT_TOOLS = new Set([
  "ask",
  "check_status",
  "summarize_context",
  "glob",
  "grep",
  "kill_agent",
  "list_dir",
  "read_file",
  "send",
  "show_context",
  "skill",
  "spawn",
  "time",
  "await_event",
  "web_fetch",
  "web_search",
  "bash_output",
]);

export function toolMayHavePartialEffects(toolName: string): boolean {
  return !SAFE_INTERRUPT_TOOLS.has(toolName);
}

// ------------------------------------------------------------------
// LogSurgery 鈥?the mutable surface log surgery operates on
// ------------------------------------------------------------------

/**
 * Implemented two ways: Session._logSurgeryView() proxies the live session
 * (appendEntry routes through the log store so revision/listeners fire),
 * while the parse stage uses a plain in-memory state.
 */
export interface LogSurgery {
  /** Live entry array 鈥?scans read it; all appends go through appendEntry. */
  readonly entries: LogEntry[];
  appendEntry(entry: LogEntry): void;
  nextLogId(type: LogEntry["type"]): string;
  allocateContextId(): string;
  /** Record a session event line (bounded recent-events list). */
  recordEvent(text: string): void;
  turnCount: number;
  workCount: number;
  currentWorkId: string | null;
  currentWorkStartedAt: number;
  lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  activeLogEntryId: string | null;
}

// ------------------------------------------------------------------
// Scan helpers (pure)
// ------------------------------------------------------------------

function computeNextRoundIndexIn(entries: readonly LogEntry[], turnIndex: number): number {
  let maxRound = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.turnIndex !== turnIndex) break;
    if (e.roundIndex !== undefined && e.roundIndex > maxRound) {
      maxRound = e.roundIndex;
    }
  }
  return maxRound + 1;
}

function activeWindowStartIdxIn(entries: readonly LogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      return i + 1;
    }
  }
  return 0;
}

function findToolCallEntryIn(entries: readonly LogEntry[], toolCallId: string): LogEntry | undefined {
  if (!toolCallId) return undefined;
  const windowStart = activeWindowStartIdxIn(entries);
  for (let i = entries.length - 1; i >= windowStart; i--) {
    const entry = entries[i];
    if (entry.discarded) continue;
    if (entry.type !== "tool_call") continue;
    if (String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "") !== toolCallId) continue;
    return entry;
  }
  return undefined;
}

function findRoundContextIdIn(entries: readonly LogEntry[], turnIndex: number, roundIndex: number): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.turnIndex < turnIndex) break;
    if (entry.discarded) continue;
    if (entry.turnIndex !== turnIndex) continue;
    if (entry.roundIndex !== roundIndex) continue;
    const contextId = (entry.meta as Record<string, unknown>)["contextId"];
    if (typeof contextId === "string" && contextId.trim()) {
      return contextId;
    }
  }
  return undefined;
}

function findToolCallContextIdIn(
  surgery: LogSurgery,
  toolCallId: string,
  roundIndex?: number,
): string | undefined {
  const entry = findToolCallEntryIn(surgery.entries, toolCallId);
  const contextId = entry ? (entry.meta as Record<string, unknown>)["contextId"] : undefined;
  if (typeof contextId === "string" && contextId.trim()) {
    return contextId;
  }
  if (typeof roundIndex === "number") {
    return findRoundContextIdIn(surgery.entries, entry?.turnIndex ?? surgery.turnCount, roundIndex);
  }
  return undefined;
}

// ------------------------------------------------------------------
// Log surgery (shared by live interrupt paths and restore parsing)
// ------------------------------------------------------------------

/** Open a work span if none is active; returns the active workId. */
export function beginWorkIfNeededIn(s: LogSurgery): string {
  if (s.currentWorkId) return s.currentWorkId;
  s.workCount += 1;
  const workId = `work-${String(s.workCount).padStart(3, "0")}`;
  s.currentWorkId = workId;
  s.currentWorkStartedAt = performance.now();
  s.appendEntry(createWorkStart(s.nextLogId("work_start"), s.turnCount, workId));
  return workId;
}

/** Close the current work span with a status (work_end entry + bookkeeping). */
export function finishWorkInLog(
  s: LogSurgery,
  status: "completed" | "interrupted" | "error",
  interruptHints?: string[],
): void {
  const workId = s.currentWorkId ?? beginWorkIfNeededIn(s);
  const elapsedMs = s.currentWorkStartedAt > 0
    ? Math.round(performance.now() - s.currentWorkStartedAt)
    : undefined;
  s.appendEntry(createWorkEnd(
    s.nextLogId("work_end"),
    s.turnCount,
    workId,
    status,
    elapsedMs,
    interruptHints,
  ));
  s.lastTurnEndStatus = status;
  s.currentWorkId = null;
  s.currentWorkStartedAt = 0;
}

/**
 * Scan entries from `fromIdx` onwards: for each tool_call (apiRole=assistant)
 * that has no matching tool_result, append a contextual interrupted
 * tool_result with a system-message body.
 */
export function completeMissingToolResultsInLog(s: LogSurgery, fromIdx: number): void {
  const pendingToolCalls: Array<{
    id: string;
    name: string;
    roundIndex?: number;
    contextId?: string;
    execState?: string;
  }> = [];
  const resolvedToolCallIds = new Set<string>();

  for (let i = fromIdx; i < s.entries.length; i++) {
    const e = s.entries[i];
    if (e.type === "tool_call") {
      if (e.apiRole !== "assistant") continue;
      const meta = e.meta as Record<string, unknown>;
      pendingToolCalls.push({
        id: (meta["toolCallId"] as string) ?? "",
        name: (meta["toolName"] as string) ?? "",
        roundIndex: e.roundIndex,
        contextId: typeof meta["contextId"] === "string" ? meta["contextId"] as string : undefined,
        execState: typeof meta["toolExecState"] === "string" ? meta["toolExecState"] as string : undefined,
      });
    } else if (e.type === "tool_result") {
      resolvedToolCallIds.add((e.meta as Record<string, unknown>)["toolCallId"] as string);
    }
  }

  for (const tc of pendingToolCalls) {
    if (resolvedToolCallIds.has(tc.id)) continue;
    if (!tc.id) continue;
    let detail: string;
    const executionInterrupted = tc.execState === "running";
    const partialEffectsPossible = executionInterrupted && toolMayHavePartialEffects(tc.name);
    if (tc.execState === "running") {
      detail = partialEffectsPossible
        ? "Tool execution was interrupted and may have had partial effects."
        : "Tool execution was interrupted.";
    } else {
      detail = `Tool \`${tc.name}\` was not executed.`;
    }
    const content = `<system-message>\nLast turn was interrupted by the user.\n${detail}\n</system-message>`;
    s.appendEntry(createToolResultEntry(
      s.nextLogId("tool_result"),
      s.turnCount,
      tc.roundIndex ?? computeNextRoundIndexIn(s.entries, s.turnCount),
      {
        toolCallId: tc.id,
        toolName: tc.name,
        content,
        toolSummary: detail,
      },
      {
        isError: false,
        contextId: tc.contextId,
        interrupt: {
          kind: executionInterrupted ? "execution_interrupted" : "not_started",
          partialEffectsPossible,
        },
        previewText: detail,
        previewDim: true,
      },
    ));
  }
}

/**
 * Drop reasoning only when the interrupted round has no durable assistant
 * output yet, or when a partial tool-call argument stream made the whole
 * assistant action non-sendable. Completed thinking paired with partial text
 * is a valid prefix and must be preserved.
 */
export function discardInterruptedRoundReasoningInLog(
  entries: readonly LogEntry[],
  fromIdx: number,
  interruptedTurnIndex: number,
): void {
  let latestRound: number | undefined;

  for (let i = fromIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.discarded || entry.turnIndex !== interruptedTurnIndex) continue;
    if (entry.roundIndex !== undefined && (latestRound === undefined || entry.roundIndex > latestRound)) {
      latestRound = entry.roundIndex;
    }
  }

  if (latestRound === undefined) return;

  let hasAssistantText = false;
  let hasClosedToolCall = false;
  let hasPartialToolCall = false;

  for (let i = fromIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.discarded || entry.turnIndex !== interruptedTurnIndex || entry.roundIndex !== latestRound) continue;
    if (entry.type === "assistant_text") hasAssistantText = true;
    if (entry.type === "tool_call" && entry.apiRole === "assistant") hasClosedToolCall = true;
    if (entry.type === "tool_call" && entry.apiRole === null) hasPartialToolCall = true;
  }

  for (let i = fromIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.discarded || entry.turnIndex !== interruptedTurnIndex || entry.roundIndex !== latestRound) continue;
    if (entry.type !== "reasoning") continue;
    const reasoningComplete = (entry.meta as Record<string, unknown>)["reasoningComplete"] === true;
    if (hasPartialToolCall || (!reasoningComplete && !hasAssistantText && !hasClosedToolCall)) {
      entry.discarded = true;
    }
  }
}

/**
 * Normalize a turn that ended without a work_end (crash / suspend): discard
 * dangling reasoning, complete missing tool_results, inject a recovery
 * system-message, and close the work span as interrupted.
 */
export function normalizeInterruptedTurnInLog(s: LogSurgery, message: string): void {
  let turnStartIndex = -1;
  let interruptedTurnIndex = -1;

  for (let i = s.entries.length - 1; i >= 0; i--) {
    const entry = s.entries[i];
    if (entry.discarded) continue;
    if (entry.type === "turn_end" || entry.type === "work_end") {
      break;
    }
    if (entry.type === "turn_start" || entry.type === "input_received") {
      turnStartIndex = i;
      interruptedTurnIndex = entry.turnIndex;
      break;
    }
  }

  if (turnStartIndex < 0 || interruptedTurnIndex < 0) return;
  s.activeLogEntryId = null;

  discardInterruptedRoundReasoningInLog(s.entries, turnStartIndex, interruptedTurnIndex);

  const originalTurnCount = s.turnCount;
  s.turnCount = interruptedTurnIndex;
  completeMissingToolResultsInLog(s, turnStartIndex);

  // Inject <system-message> about the recovery (same format as live interrupt).
  const interruptionContent = `<system-message>\n${message}\n</system-message>`;
  const interruptionCtxId = s.allocateContextId();
  const interruptionEntry = createUserMessageEntry(
    s.nextLogId("user_message"),
    interruptedTurnIndex,
    "",
    interruptionContent,
    interruptionCtxId,
  );
  interruptionEntry.tuiVisible = false;
  interruptionEntry.displayKind = null;
  s.appendEntry(interruptionEntry);
  finishWorkInLog(s, "interrupted");
  s.turnCount = originalTurnCount;
  s.recordEvent("recovered interrupted turn");
}

/**
 * Resolve every open ask_request as Deny/Decline with a matching error
 * tool_result, so the log carries a definite outcome (ESC-deny model).
 * Must run BEFORE normalizeInterruptedTurnInLog.
 */
export function resolveOpenAsksAsDenyInLog(s: LogSurgery): void {
  const resolvedAskIds = new Set<string>();
  for (const e of s.entries) {
    if (e.discarded) continue;
    if (e.type === "ask_resolution") {
      resolvedAskIds.add(String((e.meta as Record<string, unknown>)["askId"] ?? ""));
    }
  }

  const openAsks: LogEntry[] = [];
  for (const e of s.entries) {
    if (e.discarded) continue;
    if (e.type !== "ask_request") continue;
    const askId = String((e.meta as Record<string, unknown>)["askId"] ?? "");
    if (!resolvedAskIds.has(askId)) openAsks.push(e);
  }
  if (openAsks.length === 0) return;

  for (const askEntry of openAsks) {
    const askId = String((askEntry.meta as Record<string, unknown>)["askId"] ?? "");
    const askKind = String((askEntry.meta as Record<string, unknown>)["askKind"] ?? "agent_question");
    const roundIndex = typeof (askEntry.meta as Record<string, unknown>)["roundIndex"] === "number"
      ? ((askEntry.meta as Record<string, unknown>)["roundIndex"] as number)
      : (askEntry.roundIndex ?? computeNextRoundIndexIn(s.entries, s.turnCount));
    const payload = askEntry.content as Record<string, unknown> | null;
    const toolCallId = String((askEntry.meta as Record<string, unknown>)["toolCallId"] ?? "");

    if (askKind === "approval") {
      const toolName = String(payload?.["toolName"] ?? "");
      s.appendEntry(createAskResolution(
        s.nextLogId("ask_resolution"),
        askEntry.turnIndex,
        { choice: "Deny", toolName, restored: true },
        askId,
        "approval",
      ));
      if (toolCallId) {
        const ctxId = findToolCallContextIdIn(s, toolCallId, roundIndex)
          ?? s.allocateContextId();
        s.appendEntry(createToolResultEntry(
          s.nextLogId("tool_result"),
          askEntry.turnIndex,
          roundIndex,
          {
            toolCallId,
            toolName: toolName || "bash",
            content: "ERROR: Tool execution was cancelled before user decision (session restored).",
            toolSummary: `${toolName || "tool"} cancelled`,
          },
          { isError: true, contextId: ctxId },
        ));
      }
    } else {
      s.appendEntry(createAskResolution(
        s.nextLogId("ask_resolution"),
        askEntry.turnIndex,
        { declined: true, restored: true },
        askId,
        "agent_question",
      ));
      const askToolCallId = toolCallId || (payload?.["toolCallId"] as string | undefined) || "ask";
      const ctxId = findToolCallContextIdIn(s, askToolCallId, roundIndex)
        ?? s.allocateContextId();
      s.appendEntry(createToolResultEntry(
        s.nextLogId("tool_result"),
        askEntry.turnIndex,
        roundIndex,
        {
          toolCallId: askToolCallId,
          toolName: "ask",
          content: "ERROR: User declined to answer the question (session restored).",
          toolSummary: "ask declined",
        },
        { isError: true, contextId: ctxId },
      ));
    }
  }
}

// ------------------------------------------------------------------
// Restore parsing
// ------------------------------------------------------------------

export interface RestoredRuntimeSignals {
  lifetimeToolCallCount: number;
  lastToolCallSummary: string;
  recentSessionEvents: string[];
  lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  selfPhase: ChildSessionPhase;
}

/** Rebuild the cheap runtime signals (tool counts, recent events) from a log. */
function rebuildRuntimeSignalsIn(entries: readonly LogEntry[]): RestoredRuntimeSignals {
  const signals: RestoredRuntimeSignals = {
    lifetimeToolCallCount: 0,
    lastToolCallSummary: "",
    recentSessionEvents: [],
    lastTurnEndStatus: null,
    selfPhase: "idle",
  };
  const recordEvent = (summary: string): void => {
    const text = summary.trim();
    if (!text) return;
    signals.recentSessionEvents.push(text);
    if (signals.recentSessionEvents.length > 5) {
      signals.recentSessionEvents.shift();
    }
  };

  for (const entry of entries) {
    if (entry.discarded) continue;
    if (entry.type === "tool_call" && entry.apiRole === "assistant") {
      signals.lifetimeToolCallCount += 1;
      signals.lastToolCallSummary = entry.display || signals.lastToolCallSummary;
      if (entry.display) recordEvent(entry.display);
    }
    if (entry.type === "tool_result") {
      const content = entry.content;
      if (content && typeof content === "object") {
        const toolSummary = String((content as Record<string, unknown>)["toolSummary"] ?? "").trim();
        if (toolSummary) {
          signals.lastToolCallSummary = toolSummary;
          recordEvent(toolSummary);
        }
      }
    }
    if (entry.type === "turn_end" || entry.type === "work_end") {
      const status = (entry.meta as Record<string, unknown>)["status"];
      if (status === "completed" || status === "interrupted" || status === "error") {
        signals.lastTurnEndStatus = status;
      }
    }
  }
  return signals;
}

export interface ParseRestoreDeps {
  /** Wraps resolvePersistedModelSelection(session, 鈥?. May throw. */
  resolveModelSelection(meta: LogSessionMeta): {
    selectedConfigName: string;
    modelProvider?: string;
    modelSelectionKey?: string;
    modelId?: string;
  };
  /** Wraps config.getModel. May throw (unknown model = failed restore). */
  getModelConfig(configName: string): ModelConfig;
  resolveThinkingLevel(modelName: string, preferredLevel: string): string;
  /** Fallback when meta carries no initialModel. */
  describeInitialModelFallback(): string;
  /** Fallback when meta carries no createdAt. */
  fallbackCreatedAt: string;
  /** Agent name recorded as the source of rebuilt ask-history records. */
  agentName: string;
}

/** Everything Session._applyRestoredState assigns onto the live session. */
export interface RestoredSessionState {
  modelConfig: ModelConfig;
  persistedModelSelection: PersistedModelSelection;
  preferredThinkingLevel: string;
  thinkingLevel: string;
  entries: LogEntry[];
  idAllocator: LogIdAllocator;
  usedContextIds: Set<string>;
  turnCount: number;
  workCount: number;
  compactCount: number;
  createdAt: string;
  initialModel: string;
  title: string | undefined;
  cachedSummary: string | undefined;
  lastInputTokens: number;
  lastTotalTokens: number;
  lastCacheReadTokens: number;
  signals: RestoredRuntimeSignals;
  askHistory: AskAuditRecord[];
}

/**
 * Parse a persisted log into a RestoredSessionState. Pure with respect to the
 * live session: operates only on the (caller-cloned) entries + allocator.
 * All throwing work (model resolution, surgery) happens here.
 */
export function parseRestoredState(
  deps: ParseRestoreDeps,
  meta: LogSessionMeta,
  entries: LogEntry[],
  idAllocator: LogIdAllocator,
): RestoredSessionState {
  // Model resolution first 鈥?the common failure mode, before any surgery.
  const selection = deps.resolveModelSelection(meta);
  const modelConfig = deps.getModelConfig(selection.selectedConfigName);
  const preferredThinkingLevel = meta.thinkingLevel ?? "";
  const thinkingLevel = deps.resolveThinkingLevel(modelConfig.model, preferredThinkingLevel);
  const persistedModelSelection: PersistedModelSelection = {
    modelConfigName: selection.selectedConfigName,
    modelProvider: selection.modelProvider,
    modelSelectionKey: selection.modelSelectionKey,
    modelId: selection.modelId,
  };

  // Rebuild usedContextIds / work count from entries.
  const usedContextIds = new Set<string>();
  let workCount = 0;
  for (const e of entries) {
    const ctxId = (e.meta as Record<string, unknown>)["contextId"];
    if (ctxId) usedContextIds.add(String(ctxId));
    if (e.type === "work_start" && !e.discarded) workCount += 1;
  }

  // Restore last token counts from log. A zero token_update means the provider
  // ended without usable usage data, so keep looking for the last real count.
  let lastInputTokens = 0;
  let lastTotalTokens = 0;
  let lastCacheReadTokens = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "token_update") {
      const inputTokens = (entries[i].meta as Record<string, unknown>)["inputTokens"] as number;
      if (!Number.isFinite(inputTokens) || inputTokens <= 0) continue;
      lastInputTokens = inputTokens;
      lastTotalTokens = ((entries[i].meta as Record<string, unknown>)["totalTokens"] as number) ?? inputTokens;
      lastCacheReadTokens = ((entries[i].meta as Record<string, unknown>)["cacheReadTokens"] as number) ?? 0;
      break;
    }
  }

  const signals = rebuildRuntimeSignalsIn(entries);

  // Plain surgery state over the cloned data.
  const surgery: LogSurgery = {
    entries,
    appendEntry(entry: LogEntry): void {
      stampProviderRoundId(entry);
      entries.push(entry);
    },
    nextLogId: (type) => idAllocator.next(type),
    allocateContextId: () => allocateContextId(usedContextIds),
    recordEvent(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      signals.recentSessionEvents.push(trimmed);
      if (signals.recentSessionEvents.length > 5) {
        signals.recentSessionEvents.shift();
      }
    },
    turnCount: meta.turnCount,
    workCount,
    currentWorkId: null,
    currentWorkStartedAt: 0,
    get lastTurnEndStatus() {
      return signals.lastTurnEndStatus;
    },
    set lastTurnEndStatus(status) {
      signals.lastTurnEndStatus = status;
    },
    activeLogEntryId: null,
  };

  // ESC-deny model: resolve open asks as Deny/Decline FIRST so the
  // subsequent normalization sees them as completed tool_call 鈫?tool_result
  // pairs and doesn't add spurious "interrupted" markers.
  resolveOpenAsksAsDenyInLog(surgery);
  normalizeInterruptedTurnInLog(surgery, "Last turn was interrupted unexpectedly and recovered after restart.");

  // Rebuild ask history from ask_resolution entries.
  const askHistory: AskAuditRecord[] = [];
  for (const e of entries) {
    if (e.type === "ask_resolution" && !e.discarded) {
      const m = e.meta as Record<string, unknown>;
      askHistory.push({
        askId: String(m["askId"] ?? ""),
        kind: (m["askKind"] as AskAuditRecord["kind"]) ?? "agent_question",
        summary: "",
        decidedAt: new Date(e.timestamp).toISOString(),
        decision: "answered",
        source: { agentId: deps.agentName },
      });
    }
  }

  return {
    modelConfig,
    persistedModelSelection,
    preferredThinkingLevel,
    thinkingLevel,
    entries,
    idAllocator,
    usedContextIds,
    turnCount: meta.turnCount,
    workCount: surgery.workCount,
    compactCount: meta.compactCount,
    createdAt: meta.createdAt || deps.fallbackCreatedAt,
    initialModel: ((meta as unknown as Record<string, unknown>)["initialModel"] as string | undefined) || deps.describeInitialModelFallback(),
    title: meta.title,
    cachedSummary: meta.summary || undefined,
    lastInputTokens,
    lastTotalTokens,
    lastCacheReadTokens,
    signals,
    askHistory,
  };
}
