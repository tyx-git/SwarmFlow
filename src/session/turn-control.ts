/**
 * 轮次锁、中断、错误/生命周期幂等与 close。
 *
 * 锁与两个幂等标志（_turnErrorEntryWritten / _lifecycleEndedEmitted）必须在同一模块：
 * 每次进入临界区都把它们清零，是所有错误/生命周期只发一次的判据。
 */

import type { Agent } from "../agents/agent.js";
import type { LogEntry } from "../context/entry/types.js";
import type { SessionLog } from "./log.js";
import type { HookRuntime } from "../hooks/index.js";
import type { MCPClientManager } from "../clients/mcp/manager.js";
import type { AskRequest } from "../ask.js";
import type { ChildSessionManager } from "./children/manager.js";
import type { MessageEnvelope } from "./tree-types.js";
import { createAssistantText } from "../context/entry/factories.js";
import { stripContextTags } from "../context/context-tags.js";
import { discardInterruptedRoundReasoningInLog } from "./log-surgery.js";

/** 轮次控制所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface TurnControlHost {
  primaryAgent: Agent;
  onSaveRequest?: () => boolean;
  _log: LogEntry[];
  _logStore: SessionLog;
  _turnCount: number;
  _agentState: string;
  _activeAsk: AskRequest | null;
  _inbox: MessageEnvelope[];
  _pendingTurnState: unknown;
  _turnInFlight: Promise<string | void> | null;
  _currentTurnSignal: AbortSignal | null;
  _currentTurnAbortController: AbortController | null;
  _turnErrorEntryWritten: boolean;
  _lifecycleEndedEmitted: boolean;
  _childSessionManagerInstance: ChildSessionManager;
  hookRuntime: HookRuntime;
  _mcpManager?: MCPClientManager;
  _compactInProgress: boolean;
  _activeLogEntryId: string | null;
  _nextLogId(type: LogEntry["type"]): string;
  _appendEntry(entry: LogEntry, save?: boolean): void;
  _finishCurrentWork(status: "completed" | "interrupted" | "error", interruptHints?: string[]): void;
  _appendInterruptionSystemMessage(partialToolNames?: readonly string[], compactWasInterrupted?: boolean): void;
  _setSelfPhase(phase: unknown): void;
  appendErrorMessage(text: string, errorType?: string): void;
  appendStatusMessage(text: string, statusType?: string, ephemeral?: boolean): void;
  _recordSessionEvent(summary: string): void;
  _computeNextRoundIndex(turnIndex?: number): number;
  _completeMissingToolResultsFromLog(opts?: unknown): void;
  _emitTurnLifecycle(event: unknown): void;
  _isCompactAbortError(err: unknown): boolean;
  _cascadeKillRunningChildren(reason?: string): void;
  _waitForAllChildTurnsSettled(): Promise<void>;
  _suspendAllChildSessions(): void;
  _forceKillAllShells(): void;
  requestTurnInterrupt(): { accepted: true };
  denyAndInterruptPendingAsk(): { accepted: boolean; reason?: string; turnFinished?: boolean };
  _findEarliestPendingToolCallLogIndex(): number;
  _finalizeDrainInterruptedWork(fromLogIndex: number): void;
  _allocateContextId(): string;
  _collectInterruptHints(): string[];
  _handleInterruption(logLenBefore: number, accumulatedText: string, opts?: { activationCompleted?: boolean }): void;
  _recordTurnFailure(err: unknown, signal?: AbortSignal): void;
  _isTurnAbortError(err: unknown, signal?: AbortSignal): boolean;
  _recordTurnErrorEntry(err: unknown, signal?: AbortSignal): void;
  // 同簇：模块内按 host.X(...) 虚分派
  _withTurnLock<T>(fn: () => Promise<T>): Promise<T>;
  waitForTurnComplete(): Promise<void>;
}

/**
 * Promise-based turn lock. Ensures at most one turn entry point executes
 * at a time. Callers are serialized: if a turn is in flight, the next
 * caller waits for it to finish (which happens quickly after abort).
 */
export async function withTurnLock<T>(host: TurnControlHost, fn: () => Promise<T>): Promise<T> {
  // Claim the lock SYNCHRONOUSLY (before any await): the old
  // check-then-claim around an await let two same-tick callers both see a
  // free lock and run concurrently —e.g. two fire-and-forget submitTurn
  // frames arriving in one stdin chunk. Everything layered on this lock
  // (turn serialization, the error-entry once-flag, lifecycle pairing)
  // assumes real mutual exclusion.
  const prev = host._turnInFlight;
  let release!: () => void;
  const myGate = new Promise<void>((resolve) => { release = resolve; });
  // _turnInFlight resolves when the LAST queued claimant releases. Gate
  // promises only ever resolve (fn errors propagate to the caller, not the
  // gate), so the .then chain needs no rejection arm.
  const tail = prev ? prev.then(() => myGate) : myGate;
  host._turnInFlight = tail;
  if (prev) {
    await prev;
  }
  host._turnErrorEntryWritten = false;
  host._lifecycleEndedEmitted = false;
  try {
    return await fn();
  } finally {
    // Only the last claimant clears the field; intermediate finishes leave
    // it pointing at the still-pending tail so waitForTurnComplete works.
    if (host._turnInFlight === tail) {
      host._turnInFlight = null;
    }
    release();
  }
}

/**
 * Wait for any in-flight turn to finish. Safe to call at any time.
 * Used by resetForNewSession, close, and callers that need to ensure
 * the previous turn has fully unwound before proceeding.
 */
export async function waitForTurnComplete(host: TurnControlHost): Promise<void> {
  while (host._turnInFlight) {
    try { await host._turnInFlight; } catch { /* ignore errors from aborted turns */ }
  }
}

/**
 * Prepare and execute interruption cleanup for the current turn.
 *
 * This captures a non-destructive delivery snapshot first, then kills active
 * workers and drops unconsumed runtime state.
 */
export function requestTurnInterrupt(host: TurnControlHost): { accepted: true } {
  // Abort main turn ONLY. Sub-agents and background shells are independent
  // background work —they continue running. They can be stopped through
  // their dedicated management APIs.
  //
  // A pending ask means there is no live turn to abort —the turn already
  // returned when it suspended. Every stop entry point resolves the ask as
  // deny-and-stop (Q9) so the log gets a definite outcome instead of an
  // orphan ask_request + unresolved tool_call.
  if (host._activeAsk) {
    const decision = host.denyAndInterruptPendingAsk();
    if (decision.accepted) return { accepted: true };
  }
  host._currentTurnAbortController?.abort();
  if (host._pendingTurnState) {
    // Suspended-but-resolved work (approval granted, resume not started):
    // finalize it so no approved-but-unexecuted tool_call survives as an
    // orphan that would poison every later API projection.
    const startIdx = host._findEarliestPendingToolCallLogIndex();
    host._pendingTurnState = null;
    host._finalizeDrainInterruptedWork(startIdx);
  }
  return { accepted: true };
}

/**
 * Handle interruption using structured log (v2).
 *
 * Rules:
 * - Keep completed reasoning, drop incomplete reasoning of the currently interrupted round
 * - Materialize partial streamed text as assistant_text
 * - For each complete tool_call lacking result, append contextual tool_result
 * - For partial (unclosed) tool_calls visible only in TUI, append a user-role
 *   system-message explaining their absence from the API context
 * - Inject a single user-role system-message about the interruption
 */
export function handleInterruption(host: TurnControlHost, 
  logLenBefore: number,
  accumulatedText: string,
  opts?: { activationCompleted?: boolean },
): void {
  const activationCompleted = opts?.activationCompleted ?? false;

  host._activeAsk = null;
  host._pendingTurnState = null;
  host._activeLogEntryId = null;
  if (!activationCompleted) {
    discardInterruptedRoundReasoningInLog(
      host._log,
      logLenBefore,
      host._turnCount,
      (ids, flags) => host._logStore.patchFlags(ids, flags),
    );
  }

  // Materialize any unsaved partial text from mid-activation streaming.
  let hasAssistantInActivation = false;
  for (let i = logLenBefore; i < host._log.length; i++) {
    if (host._log[i].type === "assistant_text" && !host._log[i].discarded) {
      hasAssistantInActivation = true;
    }
  }
  if (!activationCompleted && !hasAssistantInActivation) {
    const partialText = stripContextTags(accumulatedText).trim();
    if (partialText) {
      const partialContextId = host._allocateContextId();
      host._appendEntry(createAssistantText(
        host._nextLogId("assistant_text"),
        host._turnCount,
        host._computeNextRoundIndex(),
        partialText,
        partialText,
        partialContextId,
      ), false);
    }
  }

  // Generate contextual tool_results for closed tool_calls without results.
  host._completeMissingToolResultsFromLog(logLenBefore);

  // Collect names of partial (unclosed) tool_calls —visible in TUI but
  // invisible in API context (apiRole=null). Agent needs to know about them.
  const partialToolNames: string[] = [];
  for (let i = logLenBefore; i < host._log.length; i++) {
    const e = host._log[i];
    if (e.type === "tool_call" && e.apiRole === null && !e.discarded) {
      const name = (e.meta as Record<string, unknown>)["toolName"];
      if (typeof name === "string") partialToolNames.push(name);
    }
  }

  // Build the interruption system-message (user role).
  host._recordSessionEvent("interrupted by user");
  const compactWasInterrupted = host._compactInProgress;
  host._appendInterruptionSystemMessage(partialToolNames, compactWasInterrupted);
}

/**
 * Scan the current turn's log entries to collect human-readable interrupt hints.
 * Called after _handleInterruption, before writing turn_end.
 */
export function collectInterruptHints(host: TurnControlHost): string[] {
  const hints: string[] = [];
  const turnIdx = host._turnCount;
  let hasDiscardedReasoning = false;
  let hasPartialEffects = false;
  let hasIncompleteArgs = false;

  for (const e of host._log) {
    if (e.turnIndex !== turnIdx) continue;
    if (e.type === "reasoning" && e.discarded) {
      hasDiscardedReasoning = true;
    }
    if (e.type === "tool_call" && e.apiRole === null && !e.discarded) {
      hasIncompleteArgs = true;
    }
    if (e.type === "tool_result") {
      const interrupt = (e.meta as Record<string, unknown>)["interrupt"] as Record<string, unknown> | undefined;
      if (interrupt?.["partialEffectsPossible"] === true) {
        hasPartialEffects = true;
      }
      if (interrupt?.["incompleteArguments"] === true) {
        hasIncompleteArgs = true;
      }
    }
    // Legacy string matching for log entries created before structured interrupt metadata.
    if (e.type === "tool_result" && typeof e.display === "string") {
      if (e.display.includes("may have had partial effects")) {
        hasPartialEffects = true;
      }
      if (e.display.includes("Incomplete arguments")) {
        hasIncompleteArgs = true;
      }
    }
  }

  if (hasDiscardedReasoning) {
    hints.push("Thinking was discarded and not transmitted to the model.");
  }
  if (hasPartialEffects) {
    hints.push("Some tools may have had partial effects.");
  }
  if (hasIncompleteArgs) {
    hints.push("Some tools had incomplete arguments and were not executed.");
  }
  return hints;
}

/**
 * Full failure surface for a turn that died anywhere inside (or just
 * outside) the turn lock: error log entry + a lifecycle ended(error) event
 * if the activation loop never got to emit one (pre-loop failures:
 * storage, MCP, attachments, before-turn compact, manual-command
 * validation). Both halves are idempotent per lock execution, so every
 * catch layer can call this unconditionally.
 */
export function recordTurnFailure(host: TurnControlHost, err: unknown, signal?: AbortSignal): void {
  host._recordTurnErrorEntry(err, signal);
  if (host._lifecycleEndedEmitted) return;
  if (host._isTurnAbortError(err, signal)) return;
  if (host._activeAsk) return;
  host._lifecycleEndedEmitted = true;
  host._emitTurnLifecycle({
    phase: "ended",
    turnIndex: host._turnCount,
    status: "error",
    error: err instanceof Error ? err.message : String(err),
  });
}

/** True when the error is a user interrupt rather than a real failure. */
export function isTurnAbortError(host: TurnControlHost, err: unknown, signal?: AbortSignal): boolean {
  // Error names are provider/library conventions and are not proof of a
  // user interrupt. Only the session's active signal identifies an actual
  // cancellation; a bare AbortError from a broken network stream is a turn
  // failure and must be surfaced as error.
  return signal?.aborted === true || host._isCompactAbortError(err);
}

/**
 * Write the user-visible error log entry for a failed turn —at most once
 * per turn-lock execution, and never for user interrupts. The runtime owns
 * error visibility: all UIs see the entry via log projection. (Historically
 * the TUI's catch wrote this entry, which left server-mode UIs blind to
 * turn errors.)
 */
export function recordTurnErrorEntry(host: TurnControlHost, err: unknown, signal?: AbortSignal): void {
  if (host._turnErrorEntryWritten) return;
  if (host._isTurnAbortError(err, signal)) return;
  if (host._activeAsk) return;
  host._turnErrorEntryWritten = true;
  host.appendErrorMessage(err instanceof Error ? err.message : String(err), "turn");
}

export async function closeSession(host: TurnControlHost): Promise<void> {
  // 1. Freeze the root inbox before interrupt. Child inboxes need no
  // freezing: _suspendAllChildSessions persists each child's live inbox.
  const frozenRootInbox = [...host._inbox];

  // 2-3. Interrupt root turn and wait for it to complete
  host.requestTurnInterrupt();
  await host.waitForTurnComplete();

  // 4-5. Abort running child turns and wait for them to settle
  host._cascadeKillRunningChildren("parent_kill");
  await host._waitForAllChildTurnsSettled();

  // 6. Suspend all child sessions (preserves lifecycle)
  host._suspendAllChildSessions();

  // 7. Persist root session (inbox is frozen)
  // The frozen inbox will be included via getLogForPersistence if caller saves
  host._inbox = frozenRootInbox;

  // 8. Kill all shells
  host._forceKillAllShells();

  // 9. Fire Stop hooks (fire-and-forget)
  host.hookRuntime.fireAndForget("Stop", { event: "Stop", timestamp: Date.now() });
  host.hookRuntime.fireAndForget("SessionEnd", { event: "SessionEnd", timestamp: Date.now() });

  // 10. Close MCP connections
  if (host._mcpManager) {
    try {
      await host._mcpManager.closeAll();
    } catch (e) {
      console.warn("Error closing MCP connections:", e);
    }
  }
}
