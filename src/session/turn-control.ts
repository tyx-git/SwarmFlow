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
 * 基于 Promise 的轮次锁，保证同一时刻只有一个轮次入口在执行。
 * 调用方串行化：若已有轮次在跑，下一个调用方等它结束
 *（abort 之后通常很快）。
 */
export async function withTurnLock<T>(host: TurnControlHost, fn: () => Promise<T>): Promise<T> {
  // 同步抢占锁（在任何 await 之前）：旧实现在 await 前后各检查一次再抢占，
  // 同一 tick 的两个调用方会同时看到空闲锁并并发执行——例如同一个 stdin
  // 块里到达的两帧 fire-and-forget submitTurn。依赖这把锁的所有机制
  //（轮次串行化、错误条目的一次性标志、生命周期配对）都以真正的互斥为前提。
  const prev = host._turnInFlight;
  let release!: () => void;
  const myGate = new Promise<void>((resolve) => { release = resolve; });
  // _turnInFlight 在最后一个排队者释放时才 resolve。Gate promise 只会
  // resolve（fn 的错误传给调用方而非 gate），所以 .then 链不需要处理拒绝。
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
    // 只有最后一个抢占者会清空该字段；中间者结束时保持它指向尚未完成的
    // tail，这样 waitForTurnComplete 才能正常工作。
    if (host._turnInFlight === tail) {
      host._turnInFlight = null;
    }
    release();
  }
}

/**
 * 等待正在执行的轮次结束。任何时候调用都安全。
 * resetForNewSession、close，以及需要确保上一轮完全收尾后再继续的调用方会用到。
 */
export async function waitForTurnComplete(host: TurnControlHost): Promise<void> {
  while (host._turnInFlight) {
    try { await host._turnInFlight; } catch { /* 忽略已中止轮次的错误 */ }
  }
}

/**
 * 为当前轮次准备并执行中断清理。
 *
 * 先拍一份不破坏投递状态的快照，再终止活跃 worker 并丢弃未消费的运行时状态。
 */
export function requestTurnInterrupt(host: TurnControlHost): { accepted: true } {
  // 只中止主回合。子代理和后台 shell 是独立的后台工作，会继续运行，
  // 可通过各自的管理 API 停止。
  //
  // 存在挂起的 ask 说明没有活着的回合可中止——回合在挂起时就已返回。
  // 所有停止入口都把该 ask 按 deny-and-stop 处理（Q9），让日志有明确结果，
  // 而不是留下孤立的 ask_request 和未决议的 tool_call。
  if (host._activeAsk) {
    const decision = host.denyAndInterruptPendingAsk();
    if (decision.accepted) return { accepted: true };
  }
  host._currentTurnAbortController?.abort();
  if (host._pendingTurnState) {
    // 已决议但未续跑的工作（已批准、尚未 resume）：把它收尾，
    // 否则已批准却没执行的 tool_call 会变成孤儿，污染后续每一次 API 投影。
    const startIdx = host._findEarliestPendingToolCallLogIndex();
    host._pendingTurnState = null;
    host._finalizeDrainInterruptedWork(startIdx);
  }
  return { accepted: true };
}

/**
 * 基于结构化日志（v2）处理中断。
 *
 * 规则：
 * - 保留已完成的 reasoning，丢弃当前被中断轮次里不完整的 reasoning
 * - 把流式输出的部分文本落成 assistant_text
 * - 每个完整但缺少结果的 tool_call，补一条带上下文的 tool_result
 * - 只在 TUI 可见的部分（未闭合）tool_call，追加一条 user 角色的
 *   system-message，说明它们缺席 API 上下文的原因
 * - 注入一条关于中断的 user 角色 system-message
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

  // 把激活中途流式产生、尚未保存的部分文本落成条目。
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

  // 为已闭合但没有结果的 tool_call 生成带上下文的 tool_result。
  host._completeMissingToolResultsFromLog(logLenBefore);

  // 收集部分（未闭合）tool_call 的名字——它们只在 TUI 可见，
  // API 上下文里没有（apiRole=null）。需要让 agent 知道它们的存在。
  const partialToolNames: string[] = [];
  for (let i = logLenBefore; i < host._log.length; i++) {
    const e = host._log[i];
    if (e.type === "tool_call" && e.apiRole === null && !e.discarded) {
      const name = (e.meta as Record<string, unknown>)["toolName"];
      if (typeof name === "string") partialToolNames.push(name);
    }
  }

  // 构造中断用的 system-message（user 角色）。
  host._recordSessionEvent("interrupted by user");
  const compactWasInterrupted = host._compactInProgress;
  host._appendInterruptionSystemMessage(partialToolNames, compactWasInterrupted);
}

/**
 * 扫描当前轮次的日志条目，收集可读的中断提示。
 * 在 _handleInterruption 之后、写 turn_end 之前调用。
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
    // 兼容旧数据：结构化中断元数据出现之前创建的日志条目只能做字符串匹配。
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
 * 轮次在锁内（或刚好在锁外）任何位置失败时的完整失败处理：
 * 写错误日志条目，并在激活循环还没来得及发出 ended(error) 事件时补一个
 *（循环前的失败：存储、MCP、附件、回合前压缩、手动命令校验）。
 * 两部分在每次锁执行内都是幂等的，因此每一层 catch 都可以无脑调用。
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

/** 判断该错误是用户中断还是真正的失败。 */
export function isTurnAbortError(host: TurnControlHost, err: unknown, signal?: AbortSignal): boolean {
  // 错误名只是 provider/库的约定，不能证明是用户中断。只有会话当前的活跃
  // signal 能标识真正的取消；网络流断裂抛出的裸 AbortError 属于轮次失败，
  // 必须作为错误暴露出来。
  return signal?.aborted === true || host._isCompactAbortError(err);
}

/**
 * 为失败的轮次写用户可见的错误日志条目——每次轮次锁执行最多一次，
 * 且用户中断时从不写。错误可见性由 runtime 负责：所有 UI 都通过日志
 * 投影看到该条目。（历史上这条目由 TUI 的 catch 写入，导致 server 模式的
 * UI 完全看不到轮次错误。）
 */
export function recordTurnErrorEntry(host: TurnControlHost, err: unknown, signal?: AbortSignal): void {
  if (host._turnErrorEntryWritten) return;
  if (host._isTurnAbortError(err, signal)) return;
  if (host._activeAsk) return;
  host._turnErrorEntryWritten = true;
  host.appendErrorMessage(err instanceof Error ? err.message : String(err), "turn");
}

export async function closeSession(host: TurnControlHost): Promise<void> {
  // 1. 中断前先冻结根 inbox。子 inbox 无需冻结：
  // _suspendAllChildSessions 会持久化每个子会话的实时 inbox。
  const frozenRootInbox = [...host._inbox];

  // 2-3. 中断根回合并等待其完成
  host.requestTurnInterrupt();
  await host.waitForTurnComplete();

  // 4-5. 中止正在运行的子回合并等待其收尾
  host._cascadeKillRunningChildren("parent_kill");
  await host._waitForAllChildTurnsSettled();

  // 6. 挂起所有子会话（保留生命周期）
  host._suspendAllChildSessions();

  // 7. 持久化根会话（inbox 已冻结）
  // 调用方保存时会通过 getLogForPersistence 带上冻结的 inbox
  host._inbox = frozenRootInbox;

  // 8. 结束所有 shell
  host._forceKillAllShells();

  // 9. 触发 Stop 钩子（fire-and-forget）
  host.hookRuntime.fireAndForget("Stop", { event: "Stop", timestamp: Date.now() });
  host.hookRuntime.fireAndForget("SessionEnd", { event: "SessionEnd", timestamp: Date.now() });

  // 10. 关闭 MCP 连接
  if (host._mcpManager) {
    try {
      await host._mcpManager.closeAll();
    } catch (e) {
      console.warn("Error closing MCP connections:", e);
    }
  }
}
