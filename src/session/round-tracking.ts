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
  onSaveRequest?: () => boolean;
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
 * 在工作边界按需跑一次同步 GC，抑制长会话中的锯齿状堆增长。
 * 限流为每 10s 最多一次，避免快速的中断/重启循环堆积 GC 停顿；
 * 且只在 "completed" 状态下执行——interrupted/error 之后
 * 可能立刻重启，此时停顿对用户更明显。
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
 * 记录一条 input_received 条目。
 *
 * 只有当 agent 空闲时，`_turnCount`（后续 provider 轮次使用的"当前输入索引"）
 * 才推进到这条新输入。agent 正在工作/等待时，新输入会拿到自己更大的 inputIndex，
 * 但 `_turnCount` 保持不动——进行中的 activation 产生的 round 条目
 * 必须继续沿用当前输入的索引，直到 drain 把新输入送达。
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
  // 仅在没有进行中或挂起的轮次时才推进当前输入索引：
  // 待处理的 ask / 待恢复的 resume 仍占着当前轮，
  // 其簿记（等待结果的 tool_calls）必须继续配对。
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
  // 真实用户消息进入模型日志的规范入口——所有 active-input 与 drain 路径都汇到这里。
  // 在此标记会话已开始，使工具可用性通知只在首条用户消息之前被抑制，
  // 无论消息由哪条路径投递。
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

/** 根据现有条目计算指定 turn 的下一个 roundIndex。 */
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

/** 最后一个 live compact_marker 之后第一条条目的索引（活动窗口起点）。 */
export function activeWindowStartIdx(host: RoundTrackingHost): number {
  return host._logStore.activeWindowStartIdx();
}

/**
 * 在活动窗口内按 id 查找 tool_call 条目（从新到旧）。
 * 不限于当前 turn：即使 turn 计数器已经推进，
 * ask 簿记仍要与对应的 tool_call 保持配对。
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

/** ask 簿记使用的 turn/round 锚点，取自触发闸门的 tool_call。 */
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
