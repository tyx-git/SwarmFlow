/**
 * 轮次/工作单元簿记、round contextId 定位与中断提示。
 *
 * 只搬"记录轮次事实、定位某轮某次的 contextId、写中断提示"这层；
 * 日志本体（`SessionLog`）与日志手术函数仍在 Session / log-surgery。
 */

import type { AskRequest } from "../ask.js";
import type { LogEntry } from "../context/entry/types.js";
import { createInputReceived, createUserMessage as createUserMessageEntry } from "../context/entry/factories.js";
import type { SessionLog } from "./log.js";
import { getLogger } from "../logging/logger.js";
import {
  beginWorkIfNeededIn,
  finishWorkInLog,
  type LogSurgery,
} from "./log-surgery.js";

/** 轮次簿记所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface RoundTrackingHost {
  onSaveRequest?: () => void | boolean;
  _log: LogEntry[];
  _logSurgeryView(): LogSurgery;
  _turnCount: number;
  _agentState: string;
  _conversationStarted: boolean;
  _pendingTurnState: unknown;
  _lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  _lastIdleGcAt: number;
  _activeAsk: unknown;
  _logStore: SessionLog;
  _nextLogId(type: LogEntry["type"]): string;
  _allocateContextId(): string;
  _appendEntry(entry: LogEntry, save?: boolean): void;
  _touchLog(): void;
  // 同簇方法：模块内按 host.X(...) 虚分派调用
  _maybeRunIdleGc(): void;
  _computeNextRoundIndex(turnIndex?: number): number;
  _findToolCallEntry(toolCallId: string): LogEntry | undefined;
  _findRoundContextId(turnIndex: number, roundIndex: number): string | undefined;
  _activeWindowStartIdx(): number;
}
export function beginWorkIfNeeded(host: RoundTrackingHost): string {
  return beginWorkIfNeededIn(host._logSurgeryView());
}

export function finishCurrentWork(host: RoundTrackingHost, 
  status: "completed" | "interrupted" | "error",
  interruptHints?: string[],
): void {
  finishWorkInLog(host._logSurgeryView(), status, interruptHints);
  host.onSaveRequest?.();
  host._maybeRunIdleGc();
}

/**
 * Run an optional synchronous GC at work boundaries to keep saw-tooth heap
 * growth in check during long sessions. Throttled to once per 10s so
 * rapid interrupt/restart cycles don't pile up GC pauses, and only on
 * "completed" status —interrupted/error paths may be followed by an
 * immediate restart where pausing is more visible to the user.
 */
export function maybeRunIdleGc(host: RoundTrackingHost): void {
  if (host._lastTurnEndStatus !== "completed") return;
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") return;
  const now = Date.now();
  if (now - host._lastIdleGcAt < 10_000) return;
  host._lastIdleGcAt = now;
  try {
    gc();
    getLogger("session").debug("idleGc:ran");
  } catch (err) {
    getLogger("session").warn("idleGc:failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

export function appendInterruptionSystemMessage(host: RoundTrackingHost, 
  partialToolNames: readonly string[] = [],
  compactWasInterrupted = false,
): void {
  const msgParts: string[] = ["Last turn was interrupted by the user."];
  for (const name of partialToolNames) {
    msgParts.push(`You tried to use tool \`${name}\` but the call was interrupted before completion. The tool call is not visible in your context because it was not fully transmitted.`);
  }
  if (compactWasInterrupted) {
    msgParts.push("Context compaction was in progress and has been canceled due to this interruption.");
  }
  const interruptionContent = `<system-message>\n${msgParts.join("\n")}\n</system-message>`;
  const interruptionCtxId = host._allocateContextId();
  const interruptionEntry = createUserMessageEntry(
    host._nextLogId("user_message"),
    host._turnCount,
    "",
    interruptionContent,
    interruptionCtxId,
  );
  interruptionEntry.tuiVisible = false;
  interruptionEntry.displayKind = null;
  host._appendEntry(interruptionEntry, false);
}

/**
 * Record an input_received entry.
 *
 * `_turnCount` (the "current input index" used by subsequent provider rounds)
 * advances to this new input ONLY when the agent is idle. While the agent
 * is working/waiting, the new input gets its own higher inputIndex but
 * `_turnCount` stays put —round entries from the in-flight activation must
 * keep using the current input's index until drain delivers the new one.
 */
export function recordInputReceived(host: RoundTrackingHost, 
  inputKind: "user" | "compact",
  display: string,
  content: unknown,
  contextId?: string,
): { inputIndex: number; inputId: string; contextId: string } {
  let maxInputIndex = host._turnCount;
  for (const entry of host._log) {
    if (entry.discarded) continue;
    if (entry.type === "input_received" && entry.turnIndex > maxInputIndex) {
      maxInputIndex = entry.turnIndex;
    }
  }
  const inputIndex = maxInputIndex + 1;
  const inputId = host._nextLogId("input_received");
  const inputContextId = contextId ?? host._allocateContextId();
  // Advance the current input index only when nothing is in flight or
  // suspended: a pending ask / pending resume still owns the current turn,
  // and its bookkeeping (tool_calls awaiting results) must keep pairing up.
  if (host._agentState === "idle" && !host._activeAsk && !host._pendingTurnState) {
    host._turnCount = inputIndex;
  }
  host._appendEntry(
    createInputReceived(
      inputId,
      inputIndex,
      inputId,
      inputKind,
      display,
      content,
      inputContextId,
      { tuiVisible: true, sender: "user" },
    ),
    false,
  );
  return { inputIndex, inputId, contextId: inputContextId };
}

export function appendDeliveredUserMessage(host: RoundTrackingHost, 
  inputIndex: number,
  inputId: string,
  inputKind: "user" | "compact",
  display: string,
  content: unknown,
  contextId: string,
  tuiVisible = true,
): void {
  // The canonical point a real user message enters the model log —every
  // active-input and drain path funnels here. Mark the conversation started so
  // tool-availability notices are suppressed only before the first user
  // message, regardless of which path delivered it.
  if (inputKind === "user") host._conversationStarted = true;
  host._appendEntry(
    createUserMessageEntry(
      host._nextLogId("user_message"),
      inputIndex,
      display,
      content,
      contextId,
      { tuiVisible, inputId, inputKind },
    ),
    false,
  );
}

/** Compute the next roundIndex for the given turn based on existing entries. */
export function computeNextRoundIndex(host: RoundTrackingHost, turnIndex: number = host._turnCount): number {
  let maxRound = -1;
  for (let i = host._log.length - 1; i >= 0; i--) {
    const e = host._log[i];
    if (e.turnIndex !== turnIndex) break;
    if (e.roundIndex !== undefined && e.roundIndex > maxRound) {
      maxRound = e.roundIndex;
    }
  }
  return maxRound + 1;
}

export function findRoundContextId(host: RoundTrackingHost, turnIndex: number, roundIndex: number): string | undefined {
  for (let i = host._log.length - 1; i >= 0; i--) {
    const entry = host._log[i];
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

export function resolveOutputRoundContextId(host: RoundTrackingHost, turnIndex: number, roundIndex: number): string {
  const roundContextId = host._findRoundContextId(turnIndex, roundIndex);
  return roundContextId ?? host._allocateContextId();
}

export function retagRoundEntries(host: RoundTrackingHost, turnIndex: number, roundIndex: number, contextId: string): void {
  let changed = false;
  for (let i = host._log.length - 1; i >= 0; i--) {
    const entry = host._log[i];
    if (entry.turnIndex < turnIndex) break;
    if (entry.discarded) continue;
    if (entry.turnIndex !== turnIndex) continue;
    if (entry.roundIndex !== roundIndex) continue;
    if (
      entry.type !== "assistant_text" &&
      entry.type !== "reasoning" &&
      entry.type !== "no_reply"
    ) {
      continue;
    }
    if ((entry.meta as Record<string, unknown>)["contextId"] === contextId) continue;
    (entry.meta as Record<string, unknown>)["contextId"] = contextId;
    changed = true;
  }
  if (changed) host._touchLog();
}

/** Index of the first entry after the last live compact_marker (active window start). */
export function activeWindowStartIdx(host: RoundTrackingHost): number {
  return host._logStore.activeWindowStartIdx();
}

/**
 * Find a tool_call entry by id within the active window (newest first).
 * Not scoped to the current turn: ask bookkeeping must keep pairing with
 * its tool_call even when the turn counter has moved on.
 */
export function findToolCallEntry(host: RoundTrackingHost, toolCallId: string): LogEntry | undefined {
  if (!toolCallId) return undefined;
  const windowStart = host._activeWindowStartIdx();
  for (let i = host._log.length - 1; i >= windowStart; i--) {
    const entry = host._log[i];
    if (entry.discarded) continue;
    if (entry.type !== "tool_call") continue;
    if (String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "") !== toolCallId) continue;
    return entry;
  }
  return undefined;
}

/** Turn/round anchor for ask bookkeeping, derived from the gated tool_call. */
export function toolCallAnchor(host: RoundTrackingHost, toolCallId: string, ask?: AskRequest | null): { turnIndex: number; roundIndex: number } {
  const entry = host._findToolCallEntry(toolCallId);
  const turnIndex = ask?.turnIndex ?? entry?.turnIndex ?? host._turnCount;
  const roundIndex = ask?.roundIndex ?? entry?.roundIndex ?? host._computeNextRoundIndex(turnIndex);
  return { turnIndex, roundIndex };
}

export function findToolCallContextId(host: RoundTrackingHost, toolCallId: string, roundIndex?: number): string | undefined {
  const entry = host._findToolCallEntry(toolCallId);
  const contextId = entry ? (entry.meta as Record<string, unknown>)["contextId"] : undefined;
  if (typeof contextId === "string" && contextId.trim()) {
    return contextId;
  }
  if (typeof roundIndex === "number") {
    return host._findRoundContextId(entry?.turnIndex ?? host._turnCount, roundIndex);
  }
  return undefined;
}
