/**
 * 统一投递、排队用户输入、auto-resume 与 inbox 排空。
 *
 * 只搬"消息如何进入 inbox / 何时唤醒 / 如何转成日志条目"这层；
 * 真正的轮次执行仍在 Session（`_turnInner`），这里通过 host 虚分派调用。
 */

import type { LogEntry } from "../context/entry/types.js";
import { createUserMessage as createUserMessageEntry } from "../context/entry/factories.js";
import type { TaskStore } from "../tasks/store.js";
import type { DeliverMessageResult, MessageEnvelope } from "./tree-types.js";

/** 投递与排空所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface InboxHost {
  onSaveRequest?: () => void | boolean;
  _inbox: MessageEnvelope[];
  _log: LogEntry[];
  _agentState: string;
  _compactInProgress: boolean;
  _pendingTurnState: unknown;
  _autoResumeScheduled: boolean;
  _turnCount: number;
  _activeAsk: unknown;
  _shellManager: unknown;
  _withTurnLock<T>(fn: () => Promise<T>): Promise<T>;
  _turnInner(userInput: string, options?: { signal?: AbortSignal; inlineImages?: unknown[]; skipUserInput?: boolean }): Promise<string>;
  _recordTurnFailure(err: unknown): void;
  _recordInputReceived(
    inputKind: "user" | "compact",
    display: string,
    content: unknown,
    contextId?: string,
  ): { inputIndex: number; inputId: string; contextId: string };
  _allocateContextId(): string;
  _nextLogId(type: LogEntry["type"]): string;
  _appendEntry(entry: LogEntry, save?: boolean): void;
  _touchLog(): void;
  _appendDeliveredUserMessage(
    inputIndex: number,
    inputId: string,
    inputKind: "user" | "compact",
    display: string,
    content: unknown,
    contextId: string,
    tuiVisible?: boolean,
  ): void;
  _ensureTaskStore(): TaskStore;
  _notifyTaskListeners(): void;
  // 同簇方法：模块内按 `host.X(...)` 虚分派调用（保留实例覆盖语义）
  _deliverMessage(msg: MessageEnvelope): DeliverMessageResult;
  _getQueuedUserInputs(): Array<{ inputId: string; inboxIndex: number; message: MessageEnvelope; inputEntry: LogEntry }>;
  _maxLiveInputIndex(): number;
  _scheduleAutoResume(): void;
  _autoResumeFromIdle(): Promise<void>;
  _hasUnprocessedUserMessage(): boolean;
  _hasInboxMessages(): boolean;
  _hasWakingInboxMessages(): boolean;
  _clearCompletedTasksBeforeUserInput(): void;
  _beginActiveInput(
    inputKind: "user" | "compact",
    display: string,
    content: unknown,
  ): { inputIndex: number; inputId: string; contextId: string };
  _drainInboxAsEntries(): number;
}

/**
 * Unified message delivery entry point.
 * All states push to inbox. Idle state also schedules auto-resume.
 * Working/waiting: the activation boundary or await_event poll drains.
 */
export function deliverInboxMessage(host: InboxHost, msg: MessageEnvelope): DeliverMessageResult {
  // Compacting rewrites the conversation; user input arriving mid-compact
  // would be folded behind the marker and effectively vanish. Reject it
  // (Q6) —automatic messages still queue and are delivered after compact.
  if (msg.type === "user_input" && host._compactInProgress) {
    return { accepted: false, reason: "compact_in_progress" };
  }
  if (msg.type === "user_input" && msg.sender === "user") {
    const queued = host._getQueuedUserInputs();
    if (queued.length > 0) {
      return { accepted: false, reason: "queued_user_input_pending" };
    }
  }
  if (msg.type === "user_input" && msg.inputIndex === undefined) {
    const received = host._recordInputReceived("user", msg.content, msg.content);
    msg = {
      ...msg,
      inputId: received.inputId,
      inputIndex: received.inputIndex,
      contextId: received.contextId,
      tuiVisible: true,
    };
    host.onSaveRequest?.();
  }
  host._inbox.push(msg);
  // Ride-along messages (wake === false) never start a turn from idle;
  // they wait in the inbox and are drained when something else wakes the
  // agent (user input or a waking message).
  if (host._agentState === "idle" && msg.wake !== false) {
    host._scheduleAutoResume();
  }
  return { accepted: true };
}

/**
 * Public wrapper for TUI / GUI to deliver messages.
 * Preserves the original (source, content) signature for external callers.
 */
export function deliverMessage(host: InboxHost, source: "user" | "system", content: string): DeliverMessageResult {
  return host._deliverMessage({
    type: source === "user" ? "user_input" : "system_notice",
    sender: source,
    content,
    timestamp: Date.now(),
  });
}

export function getQueuedUserInputs(host: InboxHost): Array<{
  inputId: string;
  inboxIndex: number;
  message: MessageEnvelope;
  inputEntry: LogEntry;
}> {
  const deliveredInputIds = new Set<string>();
  for (const entry of host._log) {
    if (entry.discarded || entry.type !== "user_message") continue;
    const inputId = entry.meta["inputId"];
    if (typeof inputId === "string" && inputId.trim()) {
      deliveredInputIds.add(inputId);
    }
  }

  const queued: Array<{
    inputId: string;
    inboxIndex: number;
    message: MessageEnvelope;
    inputEntry: LogEntry;
  }> = [];
  for (let inboxIndex = 0; inboxIndex < host._inbox.length; inboxIndex++) {
    const message = host._inbox[inboxIndex];
    if (message.type !== "user_input" || message.sender !== "user") continue;
    if (!message.inputId || deliveredInputIds.has(message.inputId)) continue;
    const inputEntry = host._log.find((entry) => {
      if (entry.discarded || entry.type !== "input_received") return false;
      if (entry.meta["inputKind"] !== "user") return false;
      return entry.meta["inputId"] === message.inputId;
    });
    if (!inputEntry) continue;
    queued.push({ inputId: message.inputId, inboxIndex, message, inputEntry });
  }
  return queued;
}

export function maxLiveInputIndex(host: InboxHost): number {
  let max = 0;
  for (const entry of host._log) {
    if (entry.discarded) continue;
    if (entry.type !== "input_received" && entry.type !== "turn_start") continue;
    max = Math.max(max, entry.turnIndex);
  }
  return max;
}

export function restoreQueuedUserInput(host: InboxHost): string | null {
  const queued = host._getQueuedUserInputs();
  if (queued.length !== 1) return null;

  const item = queued[0];
  if (!item) return null;
  host._inbox.splice(item.inboxIndex, 1);
  item.inputEntry.discarded = true;
  if (host._turnCount === item.inputEntry.turnIndex) {
    host._turnCount = host._maxLiveInputIndex();
  }
  host._touchLog();
  host.onSaveRequest?.();
  return item.message.content;
}

/**
 * Schedule an auto-resume turn for the idle state. Used when messages arrive
 * (sub-agent completion, shell exit, etc.) while the parent agent has no
 * active turn. Without this, the queued messages would sit in the log
 * unprocessed until the user manually starts a new turn.
 */
export function scheduleAutoResume(host: InboxHost): void {
  if (host._autoResumeScheduled) return;
  if (host._activeAsk) return;
  if (host._pendingTurnState) return;
  host._autoResumeScheduled = true;
  queueMicrotask(() => {
    host._autoResumeScheduled = false;
    // The rejection itself is intentionally dropped (no caller awaits), but
    // the failure is NOT silent: _turnInner's catch already wrote the error
    // log entry and the turn-lifecycle "ended" event carried the error.
    void host._autoResumeFromIdle().catch(() => { /* rejection consumed; error already surfaced via log + lifecycle */ });
  });
}

/**
 * Run a turn that drains queued messages without taking new user input.
 * Acquires the turn lock to serialize with normal turn() calls.
 */
export async function autoResumeFromIdle(host: InboxHost): Promise<void> {
  await host._withTurnLock(async () => {
    if (host._agentState !== "idle") return;
    if (host._activeAsk) return;
    if (host._pendingTurnState) return;
    // Skip if there's nothing to process: no inbox messages AND no recent
    // user_message entry awaiting a response.
    if (host._inbox.length === 0 && !host._hasUnprocessedUserMessage()) return;
    try {
      await host._turnInner("", { skipUserInput: true });
    } catch (err) {
      // Same catch-all as turn(): without it, pre-loop failures in an
      // auto-resume turn would be fully invisible (no caller awaits this).
      host._recordTurnFailure(err);
      throw err;
    }
  });
}

/**
 * Scan the log backward to find whether the most recent turn-relevant entry
 * is a user_message that hasn't been responded to (no assistant_text/tool_call/
 * reasoning after it). Used by auto-resume to decide whether to fire a new
 * turn after a finally-block drain wrote messages without the model seeing
 * them.
 */
export function hasUnprocessedUserMessage(host: InboxHost): boolean {
  const delivered = new Set<string>();
  for (const entry of host._log) {
    if (entry.discarded) continue;
    if (entry.type !== "user_message") continue;
    const inputId = entry.meta["inputId"];
    if (typeof inputId === "string") delivered.add(inputId);
  }
  for (let i = host._log.length - 1; i >= 0; i--) {
    const entry = host._log[i];
    if (entry.discarded) continue;
    if (entry.type !== "input_received") continue;
    const inputKind = entry.meta["inputKind"];
    // "compact" inputs are consumed by the compact phase itself and never
    // await a model reply —counting them here would schedule ghost
    // auto-resume turns after every /compact.
    // Keep the old "summarize" input kind readable so interrupted legacy
    // sessions can still resume an undelivered turn.
    if (inputKind !== "user" && inputKind !== "summarize") continue;
    const inputId = entry.meta["inputId"];
    return typeof inputId === "string" && !delivered.has(inputId);
  }
  return false;
}

/**
 * Check whether the inbox has pending messages.
 */
export function hasInboxMessages(host: InboxHost): boolean {
  return host._inbox.length > 0;
}

/**
 * Check whether the inbox has pending WAKING messages. Ride-along messages
 * (wake === false) don't block manual context commands —they are passive
 * records (e.g. user-initiated kill notices) that wait for the next turn.
 */
export function hasWakingInboxMessages(host: InboxHost): boolean {
  return host._inbox.some((msg) => msg.wake !== false);
}

/** Remove the previous completed task list when a real user input is delivered. */
export function clearCompletedTasksBeforeUserInput(host: InboxHost): void {
  const taskStore = host._ensureTaskStore();
  const tasks = taskStore.list();
  if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) {
    const { cleared, saveError } = taskStore.clearAll();
    if (cleared > 0) {
      if (saveError) console.warn(saveError);
      host._notifyTaskListeners();
    }
  }
}

/**
 * Pre-activation prelude shared by every entry that records a NEW active
 * input (user message or /compact). The single choke point that
 * enforces wake:false ordering and the "conversation has started" boundary:
 *
 *   1. Earlier-arrived ride-along (wake:false) inbox messages land in the log
 *      first, in arrival order. `wake:false` means "do not start a turn by
 *      itself", not "jump behind the next active input".
 *   2. The new active input is recorded.
 *
 * Delivery to the model-facing log (user_message vs status entry) stays with
 * the caller —it legitimately differs per activation kind. The
 * "conversation started" flag is flipped at that delivery point
 * (_appendDeliveredUserMessage), so every user-message path sets it.
 */
export function beginActiveInput(host: InboxHost, 
  inputKind: "user" | "compact",
  display: string,
  content: unknown,
): { inputIndex: number; inputId: string; contextId: string } {
  if (inputKind === "user") {
    host._clearCompletedTasksBeforeUserInput();
  }
  host._drainInboxAsEntries();
  return host._recordInputReceived(inputKind, display, content);
}

/**
 * Deliver queued messages to the model-facing log.
 *
 * User messages are displayed when received, then delivered here only after
 * the current provider round has finished. This preserves the API ordering:
 * user A →assistant A →user B, even when user B was typed while assistant A
 * was still streaming.
 */
export function drainInboxAsEntries(host: InboxHost): number {
  if (host._inbox.length === 0) return 0;
  const messages = [...host._inbox];
  host._inbox = [];

  for (const msg of messages) {
    switch (msg.type) {
      case "user_input": {
        // Invariant: _deliverMessage populates these fields synchronously
        // when user_input arrives. Drain should never see an unprepared one.
        if (msg.inputIndex === undefined || !msg.inputId || !msg.contextId) {
          throw new Error(
            "user_input must have inputId/inputIndex/contextId by drain time " +
            "(set in _deliverMessage). Got: " + JSON.stringify({
              inputId: msg.inputId,
              inputIndex: msg.inputIndex,
              contextId: msg.contextId,
            }),
          );
        }
        host._clearCompletedTasksBeforeUserInput();
        host._turnCount = Math.max(host._turnCount, msg.inputIndex);
        host._appendDeliveredUserMessage(
          msg.inputIndex,
          msg.inputId,
          "user",
          msg.content,
          msg.content,
          msg.contextId,
        );
        break;
      }
      case "peer_message": {
        const ctxId = host._allocateContextId();
        const entry = createUserMessageEntry(
          host._nextLogId("user_message"),
          host._turnCount,
          `[Agent ${msg.sender}]`,
          `<system-message>\n${msg.content}\n</system-message>`,
          ctxId,
          { tuiVisible: false, inputKind: "peer" },
        );
        entry.tuiVisible = false;
        host._appendEntry(entry, false);
        break;
      }
      case "system_notice": {
        const ctxId = host._allocateContextId();
        const display = msg.tuiVisible ? msg.content : "[System]";
        const entry = createUserMessageEntry(
          host._nextLogId("user_message"),
          host._turnCount,
          display,
          `<system-message>\n${msg.content}\n</system-message>`,
          ctxId,
          { tuiVisible: Boolean(msg.tuiVisible), inputKind: "system" },
        );
        if (!msg.tuiVisible) entry.tuiVisible = false;
        host._appendEntry(entry, false);
        break;
      }
    }
  }
  return messages.length;
}
