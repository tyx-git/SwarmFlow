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
import type { SessionLog } from "./log.js";

/** 投递与排空所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface InboxHost {
  onSaveRequest?: () => boolean;
  _inbox: MessageEnvelope[];
  _log: LogEntry[];
  _logStore: SessionLog;
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
 * 统一的投递入口。
 * 所有状态都先入 inbox；idle 状态还会安排 auto-resume。
 * working/waiting 状态由激活边界或 await_event 轮询来排空。
 */
export function deliverInboxMessage(host: InboxHost, msg: MessageEnvelope): DeliverMessageResult {
  // 压缩会重写对话；压缩中途到达的用户输入会被折到 marker 之后、等于消失。
  // 因此直接拒绝（Q6）——自动消息仍会排队，压缩结束后投递。
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
  // 搭车消息（wake === false）不会从 idle 启动回合；它们留在 inbox 里，
  // 等别的消息（用户输入或唤醒消息）把 agent 叫醒时一起排空。
  if (host._agentState === "idle" && msg.wake !== false) {
    host._scheduleAutoResume();
  }
  return { accepted: true };
}

/**
 * 供 TUI / GUI 投递消息的公开包装。
 * 保留原有的 (source, content) 签名，方便外部调用方。
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
  host._logStore.patchFlags([item.inputEntry.id], { discarded: true });
  if (host._turnCount === item.inputEntry.turnIndex) {
    host._turnCount = host._maxLiveInputIndex();
  }
  host.onSaveRequest?.();
  return item.message.content;
}

/**
 * 在 idle 状态安排一个 auto-resume 回合。当父 agent 没有活跃回合时，
 * 消息到达（子代理完成、shell 退出等）会用到它。否则排队的消息只会
 * 堆在日志里没人处理，直到用户手动开启新回合。
 */
export function scheduleAutoResume(host: InboxHost): void {
  if (host._autoResumeScheduled) return;
  if (host._activeAsk) return;
  if (host._pendingTurnState) return;
  host._autoResumeScheduled = true;
  queueMicrotask(() => {
    host._autoResumeScheduled = false;
    // 这里刻意丢弃 rejection（没有调用方 await），但失败并不静默：
    // _turnInner 的 catch 已写好错误日志条目，轮次生命周期的 "ended"
    // 事件也带上了该错误。
    void host._autoResumeFromIdle().catch(() => { /* 拒绝已消费；错误已通过日志和生命周期暴露 */ });
  });
}

/**
 * 跑一个只排空排队消息、不接受新用户输入的回合。
 * 会取轮次锁，与正常的 turn() 调用串行。
 */
export async function autoResumeFromIdle(host: InboxHost): Promise<void> {
  await host._withTurnLock(async () => {
    if (host._agentState !== "idle") return;
    if (host._activeAsk) return;
    if (host._pendingTurnState) return;
    // 没有可处理的内容就跳过：inbox 为空，且没有待回复的
    // user_message 条目。
    if (host._inbox.length === 0 && !host._hasUnprocessedUserMessage()) return;
    try {
      await host._turnInner("", { skipUserInput: true });
    } catch (err) {
      // 与 turn() 相同的兜底：否则 auto-resume 回合里循环前的失败
      // 会完全不可见（没有调用方 await 它）。
      host._recordTurnFailure(err);
      throw err;
    }
  });
}

/**
 * 从后往前扫日志，判断最近的轮次相关条目是否是尚未回复的 user_message
 *（其后没有 assistant_text/tool_call/reasoning）。auto-resume 用它决定：
 * finally 里的排空写了消息但模型没看到时，是否要再起一个回合。
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
    // "compact" 输入由压缩阶段自己消费，从不等待模型回复——把它算进来
    // 会让每次 /compact 之后都凭空多出 auto-resume 回合。
    // 保留旧的 "summarize" 输入类型可读，好让被中断的旧会话还能续跑未投递的回合。
    if (inputKind !== "user" && inputKind !== "summarize") continue;
    const inputId = entry.meta["inputId"];
    return typeof inputId === "string" && !delivered.has(inputId);
  }
  return false;
}

/**
 * 检查 inbox 里是否有待处理消息。
 */
export function hasInboxMessages(host: InboxHost): boolean {
  return host._inbox.length > 0;
}

/**
 * 检查 inbox 里是否有待处理的“唤醒型”消息。搭车消息（wake === false）
 * 不阻塞手动上下文命令——它们是等待下个回合的被动记录
 *（例如用户发起的 kill 通知）。
 */
export function hasWakingInboxMessages(host: InboxHost): boolean {
  return host._inbox.some((msg) => msg.wake !== false);
}

/** 真正投递用户输入前，清掉上一批已完成的任务列表。 */
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
 * 激活前的前置步骤，所有记录“新活跃输入”（用户消息或 /compact）的入口共用。
 * 这里是统一卡点，保证 wake:false 的先后顺序和“对话已开始”的边界：
 *
 *   1. 先到的搭车（wake:false）inbox 消息按到达顺序先落日志。
 *      `wake:false` 的意思是“别自己起回合”，而不是“插到下一个活跃输入后面”。
 *   2. 记录新的活跃输入。
 *
 * 写入面向模型的日志（user_message 还是 status 条目）仍由调用方负责——
 * 不同激活类型本就不同。“对话已开始”标志在那个投递点
 *（_appendDeliveredUserMessage）翻转，因此每条用户消息路径都会设上它。
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
 * 把排队的消息投递到面向模型的日志。
 *
 * 用户消息收到时就显示，但要等当前 provider 轮次结束后才在这里投递。
 * 这样才能保住 API 中的顺序：user A →assistant A →user B，
 * 即使 user B 是在 assistant A 还在流式输出时输入的。
 */
export function drainInboxAsEntries(host: InboxHost): number {
  if (host._inbox.length === 0) return 0;
  const messages = [...host._inbox];
  host._inbox = [];

  for (const msg of messages) {
    switch (msg.type) {
      case "user_input": {
        // 不变量：user_input 到达时 _deliverMessage 会同步填好这些字段，
        // 排空时不应遇到未准备好的消息。
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
