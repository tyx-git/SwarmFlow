/**
 * SessionPersistence —— 恢复解析 + 日志手术（P2.5）。
 *
 * 替换影子 Session 方案：parseRestoredState 将持久化日志转换为
 * 纯 RestoredSessionState 数据结构，而不触碰任何 Session 实例。
 * 所有可能失败的工作（模型解析、日志手术）都在此处的解析阶段完成——
 * 失败的恢复不会污染 live session；
 * Session._applyRestoredState 之后只是一个赋值传递。
 *
 * 日志手术函数（拒绝解决 open asks、中断 turn 正规化、
 * 完成缺失的 tool_results、结束 work）与 LIVE 中断路径
 * 通过 LogSurgery 接口共享：解析阶段在克隆数据上驱动它们，
 * 而 Session 在自身的视图（_logSurgeryView）上驱动相同函数——
 * 一个实现，无恢复/live 漂移。
 *
 * 不变式（详见 Docs/session-refactor-plan-2026-06-11.md）：
 *   1. Live session 的 log revision 绝不因恢复而重置——apply 只递增它，
 *      UI 订阅者始终检测到交换。
 *   2. Open asks 在中断 turn 正规化之前被拒绝解决（ESC-deny 模型）：
 *      正规化必须将它们视为已完成的 tool_call → tool_result 对。
 *   3. 恢复抛出时当前 session 保持不变（所有抛出的工作都在解析阶段，
 *      作用于克隆数据）。
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

/** 中断后不会留下部分副作用的工具。 */
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

/** 该工具中断后可能留下部分副作用。 */
export function toolMayHavePartialEffects(toolName: string): boolean {
  return !SAFE_INTERRUPT_TOOLS.has(toolName);
}

// ------------------------------------------------------------------
// LogSurgery —— 日志手术操作的可变表面
// ------------------------------------------------------------------

/**
 * 两种实现方式：
 * Session._logSurgeryView() 代理 live session
 *（appendEntry 经由日志存储触发 revision/listeners），
 * 而解析阶段使用纯内存状态。
 */
export interface LogSurgery {
  /** 实时条目数组——扫描读取；所有追加经由 appendEntry。 */
  readonly entries: LogEntry[];
  appendEntry(entry: LogEntry): void;
  nextLogId(type: LogEntry["type"]): string;
  allocateContextId(): string;
  /** 记录会话事件行（有限最近事件列表）。 */
  recordEvent(text: string): void;
  turnCount: number;
  workCount: number;
  currentWorkId: string | null;
  currentWorkStartedAt: number;
  lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  activeLogEntryId: string | null;
}

// ------------------------------------------------------------------
// 扫描辅助函数（纯函数）
// ------------------------------------------------------------------

/** 在给定 turn 中找到最后一个 round 的 roundIndex + 1。 */
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

/** 最近一次 live compact_marker 的起始索引之后的位置。 */
function activeWindowStartIdxIn(entries: readonly LogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      return i + 1;
    }
  }
  return 0;
}

/** 在活动窗口中按 toolCallId 查找 tool_call 条目。 */
function findToolCallEntryIn(entries: readonly LogEntry[], toolCallId: string): LogEntry | undefined {
  if (!toolCallId) return undefined;
  const windowStart = activeWindowStartIdxIn(entries);
  for (let i = windowStart; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.discarded) continue;
    if (entry.type !== "tool_call") continue;
    if (String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "") !== toolCallId) continue;
    return entry;
  }
  return undefined;
}

/** 在指定 turn/round 中查找 context_id。 */
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

/** 按 toolCallId 或 roundIndex 查找 context_id。 */
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
// 日志手术（live 中断路径和恢复解析共用）
// ------------------------------------------------------------------

/** 若无活动 work span 则开启一个；返回活动的 workId。 */
export function beginWorkIfNeededIn(s: LogSurgery): string {
  if (s.currentWorkId) return s.currentWorkId;
  s.workCount += 1;
  const workId = `work-${String(s.workCount).padStart(3, "0")}`;
  s.currentWorkId = workId;
  s.currentWorkStartedAt = performance.now();
  s.appendEntry(createWorkStart(s.nextLogId("work_start"), s.turnCount, workId));
  return workId;
}

/** 关闭当前 work span（work_end 条目 + 记账）。 */
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
 * 从 fromIdx 往后扫描：每个没有匹配 tool_result 的 tool_call
 *（apiRole=assistant）追加一个含中断上下文的 tool_result。
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
 * 仅在中断 round 尚无持久化助手输出时丢弃推理，
 * 或当部分 tool-call 参数流使整个助手动作不可发送时。
 * 与部分文本配对的已完成思考是有效前缀，必须保留。
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
 * 正规化一个没有 work_end 的中断 turn（崩溃/挂起）：
 * 丢弃悬空推理、完成缺失的 tool_results、
 * 注入恢复 system-message、关闭 work span 为 interrupted。
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

  // 注入关于恢复的 system-message（与 live 中断格式相同）
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
 * 将每个 open ask_request 解决为 Deny/Decline，
 * 附带匹配的 error tool_result，使日志携带确定性结果（ESC-deny 模型）。
 * 必须在 normalizeInterruptedTurnInLog 之前运行。
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
// 恢复解析
// ------------------------------------------------------------------

/** 恢复的廉价运行时信号。 */
export interface RestoredRuntimeSignals {
  lifetimeToolCallCount: number;
  lastToolCallSummary: string;
  recentSessionEvents: string[];
  lastTurnEndStatus: "completed" | "interrupted" | "error" | null;
  selfPhase: ChildSessionPhase;
}

/** 从日志重建廉价运行时信号。 */
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
  /** 包装 resolvePersistedModelSelection。可能抛出。 */
  resolveModelSelection(meta: LogSessionMeta): {
    selectedConfigName: string;
    modelProvider?: string;
    modelSelectionKey?: string;
    modelId?: string;
  };
  /** 包装 config.getModel。可能抛出（未知模型 = 恢复失败）。 */
  getModelConfig(configName: string): ModelConfig;
  resolveThinkingLevel(modelName: string, preferredLevel: string): string;
  /** 当 meta 没有 initialModel 时的回退。 */
  describeInitialModelFallback(): string;
  /** 当 meta 没有 createdAt 时的回退。 */
  fallbackCreatedAt: string;
  /** 重建 ask 历史记录的来源 Agent 名称。 */
  agentName: string;
}

/** Session._applyRestoredState 赋值到 live session 的所有内容。 */
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
 * 将持久化日志解析为 RestoredSessionState。
 * 相对于 live session 是纯的：只操作（调用方克隆的）entries + allocator。
 * 所有可能抛出的工作（模型解析、手术）都在此处。
 */
export function parseRestoredState(
  deps: ParseRestoreDeps,
  meta: LogSessionMeta,
  entries: LogEntry[],
  idAllocator: LogIdAllocator,
): RestoredSessionState {
  // 模型解析优先——这是常见失败模式，在任何手术之前。
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

  // 从 entries 重建 usedContextIds / work count。
  const usedContextIds = new Set<string>();
  let workCount = 0;
  for (const e of entries) {
    const ctxId = (e.meta as Record<string, unknown>)["contextId"];
    if (ctxId) usedContextIds.add(String(ctxId));
    if (e.type === "work_start" && !e.discarded) workCount += 1;
  }

  // 从日志恢复最后 token 计数。若 token_update 无有效 usage，继续找上一个。
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

  // 在克隆数据上的纯手术状态。
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

  // ESC-deny 模型：先将 open asks 解决为 Deny/Decline，
  // 使后续正规化将它们视为已完成的 tool_call → tool_result 对，
  // 而非添加虚假的"中断"标记。
  resolveOpenAsksAsDenyInLog(surgery);
  normalizeInterruptedTurnInLog(surgery, "Last turn was interrupted unexpectedly and recovered after restart.");

  // 从 ask_resolution 条目重建 ask 历史。
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
