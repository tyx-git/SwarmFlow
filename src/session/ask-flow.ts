/**
 * ask 订阅、提问执行、两类决议与子会话路由。
 *
 * 只搬"挂起—决议—续跑"这条链；ask 的日志条目构造与轮次锁仍在既有模块，
 * 这里通过 host 虚分派调用。
 */

import { randomUUID } from "node:crypto";

import {
  ASK_CUSTOM_OPTION_LABEL,
  ASK_DISCUSS_OPTION_LABEL,
  AskPendingError,
  toPendingAskUi,
  type AgentQuestion,
  type AgentQuestionDecision,
  type AgentQuestionItem,
  type ApprovalRequest,
  type AskAuditRecord,
  type AskRequest,
  type PendingAskUi,
} from "../ask.js";
import { createAskResolution, createToolResult as createToolResultEntry } from "../context/entry/factories.js";
import type { LogEntry } from "../context/entry/types.js";
import type { ApprovalOffer, PermissionAdvisor, PermissionRule } from "../permissions/index.js";
import { type ProgressLevel, type ProgressReporter } from "../logging/progress.js";
import { ToolResult } from "../providers/response.js";
import type { Agent } from "../agents/agent.js";
import type { ChildSessionHandle } from "./children/types.js";
import type { ChildSessionManager } from "./children/manager.js";

/** ask 流程所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface AskHost {
  primaryAgent: Agent;
  permissionMode: string;
  onSaveRequest?: () => boolean;
  _activeAsk: AskRequest | null;
  _askHistory: AskAuditRecord[];
  _askListeners: Set<() => void>;
  _pendingTurnState: unknown;
  _progress?: ProgressReporter;
  _permissionAdvisor: PermissionAdvisor;
  _turnCount: number;
  _currentTurnAbortController: AbortController | null;
  _childSessionManagerInstance: ChildSessionManager;
  _childSessions: Map<string, ChildSessionHandle>;
  _nextLogId(type: LogEntry["type"]): string;
  _appendEntry(entry: LogEntry, save?: boolean): void;
  _allocateContextId(): string;
  _notifyLogListeners(): void;
  _toolCallAnchor(toolCallId: string, ask?: AskRequest | null): { turnIndex: number; roundIndex: number };
  _findToolCallContextId(toolCallId: string, roundIndex?: number): string | undefined;
  _findEarliestPendingToolCallLogIndex(): number;
  _finalizeDrainInterruptedWork(fromLogIndex: number): void;
  _finishChildTurn(handle: ChildSessionHandle, error?: unknown): void;
  _buildAgentQuestionToolResult(questions: AgentQuestionItem[], decision: AgentQuestionDecision): ToolResult;
  _buildAgentQuestionPreview(questions: AgentQuestionItem[], decision: AgentQuestionDecision): string;
  // 同簇方法：模块内按 host.X(...) 虚分派调用
  _notifyAskChanged(): void;
  _emitAskRequestedProgress(ask: AskRequest): void;
  _emitAskResolvedProgress(askId: string, decision: string, askKind?: string): void;
  getPendingAsk(): PendingAskUi | null;
  denyPendingAsk(): boolean;
  resolveAgentQuestionAsk(askId: string, decision: AgentQuestionDecision): void;
  _resolveOwnAgentQuestionAsk(askId: string, decision: AgentQuestionDecision): void;
  resolveApprovalAsk(askId: string, choiceIndex: number): void;
  _resolveOwnApprovalAsk(askId: string, choiceIndex: number): void;
  _withAskRouting<T>(askId: string, onSelf: () => T, onChild: (child: ChildSessionHandle) => T): T;
  _findChildWithPendingAsk(askId: string): ChildSessionHandle | null;
  _resumeChildPendingTurn(handle: ChildSessionHandle): void;
}
// ==================================================================
// ask 订阅、提问执行、两类决议与子会话路由
// ==================================================================

/**
 * Subscribe to pending-ask changes (own asks and child-session asks).
 * Listeners receive no payload; call `getPendingAsk()` for current state.
 */
export function subscribeAsk(host: AskHost, listener: () => void): () => void {
  host._askListeners.add(listener);
  return () => {
    host._askListeners.delete(listener);
  };
}

export function notifyAskChanged(host: AskHost): void {
  // Prototype-based test doubles (Object.create(Session.prototype)) have no
  // field initializers; tolerate a missing listener set.
  if (!host._askListeners) return;
  for (const listener of host._askListeners) {
    try {
      listener();
    } catch {
      // Subscriber errors must never break the turn loop.
    }
  }
}

/**
 * If a permission approval or agent_question ask is pending, synthesize
 * Deny/Decline resolution + denial tool_result. Returns true if anything
 * was denied. Called by TUI on ESC/Ctrl+C while a prompt is showing.
 */
export function denyPendingAsk(host: AskHost): boolean {
  const ask = host._activeAsk;
  if (!ask) {
    // Find the child that owns the visible ask and deny via routing
    const pendingAsk = host.getPendingAsk();
    if (!pendingAsk) return false;
    const child = host._findChildWithPendingAsk(pendingAsk.id);
    if (!child?.session) return false;
    child.session.denyPendingAsk();
    host._resumeChildPendingTurn(child);
    host._notifyLogListeners();
    host.onSaveRequest?.();
    return true;
  }

  if (ask.kind === "approval") {
    const denyIndex = ask.options.length - 1;
    host._resolveOwnApprovalAsk(ask.id, denyIndex);
    return true;
  }

  // agent_question: synthesize decline resolution + error tool_result.
  const toolCallId = (ask.payload as Record<string, unknown>)["toolCallId"] as string ?? "ask";
  const anchor = host._toolCallAnchor(toolCallId, ask);
  host._appendEntry(createAskResolution(
    host._nextLogId("ask_resolution"),
    anchor.turnIndex,
    { declined: true },
    ask.id,
    "agent_question",
  ), false);

  const contextId = host._findToolCallContextId(toolCallId, ask.roundIndex)
    ?? host._allocateContextId();
  host._appendEntry(createToolResultEntry(
    host._nextLogId("tool_result"),
    anchor.turnIndex,
    anchor.roundIndex,
    {
      toolCallId,
      toolName: "ask",
      content: "ERROR: User declined to answer the question.",
      toolSummary: "ask declined",
    },
    { isError: true, contextId },
  ), false);

  host._askHistory.push({
    askId: ask.id,
    kind: ask.kind,
    summary: ask.summary,
    decidedAt: new Date().toISOString(),
    decision: "declined",
    source: ask.source,
  });
  if (host._askHistory.length > 100) {
    host._askHistory = host._askHistory.slice(-100);
  }

  host._activeAsk = null;
  host._emitAskResolvedProgress(ask.id, "declined", "agent_question");
  host._pendingTurnState = { stage: "activation" };
  host.onSaveRequest?.();
  return true;
}

export function denyAndInterruptPendingAsk(host: AskHost): { accepted: boolean; reason?: string; turnFinished?: boolean } {
  const ask = host._activeAsk;
  if (!ask) {
    const pendingAsk = host.getPendingAsk();
    if (!pendingAsk) return { accepted: false, reason: "no_pending_ask" };
    const child = host._findChildWithPendingAsk(pendingAsk.id);
    if (!child?.session) return { accepted: false, reason: "ask_owner_not_found" };

    const decision = child.session.denyAndInterruptPendingAsk();
    if (!decision.accepted) return decision;

    child.terminationCause = "user_targeted_kill";
    host._finishChildTurn(child);
    host._notifyLogListeners();
    host.onSaveRequest?.();
    // Root turn is still running (child was killed, root continues with its result).
    return { accepted: true, turnFinished: false };
  }

  const interruptionStartIdx = host._findEarliestPendingToolCallLogIndex();
  if (!host.denyPendingAsk()) {
    return { accepted: false, reason: "deny_failed" };
  }
  host._currentTurnAbortController?.abort();
  host._finalizeDrainInterruptedWork(interruptionStartIdx);
  return { accepted: true, turnFinished: true };
}

/**
 * Restore ask state from log entries.
 * Scans for unclosed ask_request (no matching ask_resolution).
 */
export function getPendingAsk(host: AskHost): PendingAskUi | null {
  const ownAsk = toPendingAskUi(host._activeAsk);
  if (ownAsk) return ownAsk;
  for (const handle of host._childSessions.values()) {
    const childAsk = handle.session?.getPendingAsk();
    if (childAsk) return childAsk;
  }
  return null;
}

export function hasPendingTurnToResume(host: AskHost): boolean {
  return host._pendingTurnState !== null;
}

export function emitAskRequestedProgress(host: AskHost, ask: AskRequest): void {
  if (!host._progress) return;
  host._progress.emit({
    step: host._turnCount,
    agent: ask.source.agentName || host.primaryAgent.name,
    action: "ask_requested",
    message: `  [ask] ${ask.summary}`,
    level: "normal" as ProgressLevel,
    timestamp: Date.now() / 1000,
    usage: {},
    extra: { ask: toPendingAskUi(ask) },
  });
}

export function emitAskResolvedProgress(host: AskHost, askId: string, decision: string, askKind?: string): void {
  if (!host._progress) return;
  host._progress.emit({
    step: host._turnCount,
    agent: host.primaryAgent.name,
    action: "ask_resolved",
    message: `  [ask] resolved: ${decision}`,
    level: "normal" as ProgressLevel,
    timestamp: Date.now() / 1000,
    usage: {},
    extra: { askId, decision, askKind },
  });
}

export function execAsk(host: AskHost, args: Record<string, unknown>): ToolResult {
  // Validate args
  const questions = args["questions"];
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) {
    return new ToolResult({
      content: "Error: 'questions' must be an array of 1-4 items.",
    });
  }
  const parsedQuestions: AgentQuestionItem[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown>;
    if (!q || typeof q["question"] !== "string") {
      return new ToolResult({
        content: `Error: questions[${i}].question must be a string.`,
      });
    }
    const opts = q["options"];
    if (!Array.isArray(opts) || opts.length === 0 || opts.length > 4) {
      return new ToolResult({
        content: `Error: questions[${i}].options must be an array of 1-4 items.`,
      });
    }
    const parsedOpts = [];
    for (let j = 0; j < opts.length; j++) {
      const o = opts[j] as Record<string, unknown>;
      if (!o || typeof o["label"] !== "string") {
        return new ToolResult({
          content: `Error: questions[${i}].options[${j}].label must be a string.`,
        });
      }
      parsedOpts.push({
        label: o["label"] as string,
        description: typeof o["description"] === "string" ? (o["description"] as string) : undefined,
        kind: "normal" as const,
      });
    }
    parsedOpts.push({
      label: ASK_CUSTOM_OPTION_LABEL,
      kind: "custom_input" as const,
      systemAdded: true,
    });
    parsedOpts.push({
      label: ASK_DISCUSS_OPTION_LABEL,
      kind: "discuss_further" as const,
      systemAdded: true,
    });
    parsedQuestions.push({
      question: q["question"] as string,
      options: parsedOpts,
    });
  }

  const ask: AgentQuestion = {
    id: randomUUID(),
    kind: "agent_question",
    createdAt: new Date().toISOString(),
    source: {
      agentId: host.primaryAgent.name,
      agentName: host.primaryAgent.name,
      toolName: "ask",
    },
    roundIndex: undefined,
    summary: `Agent asking: ${parsedQuestions[0].question}${parsedQuestions.length > 1 ? ` (+${parsedQuestions.length - 1} more)` : ""}`,
    payload: { questions: parsedQuestions, toolCallId: "" },
    options: [], // per-question options are in payload
  };
  throw new AskPendingError(ask);
}

export function resolveAgentQuestionAsk(host: AskHost, 
  askId: string,
  decision: AgentQuestionDecision,
): void {
  host._withAskRouting(
    askId,
    () => host._resolveOwnAgentQuestionAsk(askId, decision),
    (child) => child.session?.resolveAgentQuestionAsk(askId, decision),
  );
}

export function resolveOwnAgentQuestionAsk(host: AskHost, askId: string, decision: AgentQuestionDecision): void {
  const ask = host._activeAsk!;
  if (ask.kind !== "agent_question") {
    throw new Error(`Ask kind mismatch (active=${ask.kind}, expected=agent_question).`);
  }

  const toolCallId = ask.payload.toolCallId || "ask";
  const anchor = host._toolCallAnchor(toolCallId, ask);

  // Create ask_resolution entry in log
  host._appendEntry(createAskResolution(
    host._nextLogId("ask_resolution"),
    anchor.turnIndex,
    { answers: decision.answers },
    askId,
    "agent_question",
  ), false);

  const toolResult = host._buildAgentQuestionToolResult(
    ask.payload.questions,
    decision,
  );
  const previewText = host._buildAgentQuestionPreview(
    ask.payload.questions,
    decision,
  );
  const toolResultContextId =
    host._findToolCallContextId(toolCallId, ask.roundIndex)
      ?? host._allocateContextId();
  host._appendEntry(createToolResultEntry(
    host._nextLogId("tool_result"),
    anchor.turnIndex,
    anchor.roundIndex,
    {
      toolCallId,
      toolName: "ask",
      content: toolResult.content,
      toolSummary: "ask resolved",
    },
    {
      isError: false,
      contextId: toolResultContextId,
      previewText,
    },
  ), false);

  host._askHistory.push({
    askId: ask.id,
    kind: ask.kind,
    summary: ask.summary,
    decidedAt: new Date().toISOString(),
    decision: "answered",
    source: ask.source,
  });
  if (host._askHistory.length > 100) {
    host._askHistory = host._askHistory.slice(-100);
  }

  host._activeAsk = null;
  host._emitAskResolvedProgress(askId, "answered", "agent_question");
  host._pendingTurnState = { stage: "activation" };

  host.onSaveRequest?.();
}

/**
 * Resolve a permission approval ask.
 * @param askId  The ask ID to resolve.
 * @param choiceIndex  Index into the ask's options array. Last option is always "Deny".
 */
export function resolveApprovalAsk(host: AskHost, askId: string, choiceIndex: number): void {
  host._withAskRouting(
    askId,
    () => host._resolveOwnApprovalAsk(askId, choiceIndex),
    (child) => child.session?.resolveApprovalAsk(askId, choiceIndex),
  );
}

export function resolveOwnApprovalAsk(host: AskHost, askId: string, choiceIndex: number): void {
  const ask = host._activeAsk!;
  if (ask.kind !== "approval") throw new Error(`Ask kind mismatch (active=${ask.kind}, expected=approval).`);

  const payload = ask.payload as ApprovalRequest["payload"];
  const choiceLabel = ask.options[choiceIndex] ?? "Deny";
  const isDeny = choiceLabel === "Deny";
  const offer = !isDeny ? payload.offers[choiceIndex] : null;

  const anchor = host._toolCallAnchor(payload.toolCallId, ask);

  // Log the resolution
  host._appendEntry(createAskResolution(
    host._nextLogId("ask_resolution"),
    anchor.turnIndex,
    { choice: choiceLabel, toolName: payload.toolName },
    askId,
    "approval",
  ), false);

  if (isDeny) {
    // Inject a deny tool_result so the model knows
    const toolCallId = payload.toolCallId;
    const contextId = host._findToolCallContextId(toolCallId, ask.roundIndex)
      ?? host._allocateContextId();
    host._appendEntry(createToolResultEntry(
      host._nextLogId("tool_result"),
      anchor.turnIndex,
      anchor.roundIndex,
      {
        toolCallId,
        toolName: payload.toolName,
        content: `ERROR: Tool execution denied by user.`,
        toolSummary: `${payload.toolName} denied`,
      },
      { isError: true, contextId },
    ), false);
  } else {
    // Apply the offer. The approved tool_call's grant is consumed in
    // _drainPendingToolCalls during resume.
    if (offer?.type === "tool_once") {
      host._permissionAdvisor.grantAllowOnce(payload.toolCallId);
    } else if (offer?.type === "mode_upgrade") {
      host.permissionMode = "reversible";
      host._permissionAdvisor.grantAllowOnce(payload.toolCallId);
    } else if ((offer?.type === "tool_pattern" || offer?.type === "external_path") && offer.rule) {
      host._permissionAdvisor.acceptOffer({
        type: offer.type as ApprovalOffer["type"],
        label: offer.label,
        scope: offer.scope as ApprovalOffer["scope"],
        rule: offer.rule as unknown as PermissionRule,
      });
      host._permissionAdvisor.grantAllowOnce(payload.toolCallId);
    }
  }

  host._askHistory.push({
    askId: ask.id,
    kind: "approval",
    summary: ask.summary,
    decidedAt: new Date().toISOString(),
    decision: choiceLabel,
    source: ask.source,
  });

  host._activeAsk = null;
  host._emitAskResolvedProgress(askId, choiceLabel, "approval");
  host._pendingTurnState = { stage: "activation" };

  host.onSaveRequest?.();
}

/**
 * Route an ask operation to the correct session (self or child).
 * If the ask belongs to this session, runs onSelf. If it belongs to a
 * child, runs onChild then resumes the child's pending turn.
 */
export function withAskRouting<T>(host: AskHost, 
  askId: string,
  onSelf: () => T,
  onChild: (child: ChildSessionHandle) => T,
): T {
  if (host._activeAsk?.id === askId) return onSelf();
  const child = host._findChildWithPendingAsk(askId);
  if (!child) throw new Error("No active ask to resolve.");
  const result = onChild(child);
  host._resumeChildPendingTurn(child);
  host._notifyLogListeners();
  host.onSaveRequest?.();
  return result;
}

export function findChildWithPendingAsk(host: AskHost, askId: string): ChildSessionHandle | null {
  return host._childSessionManagerInstance.findChildWithPendingAsk(askId);
}

export function resumeChildPendingTurn(host: AskHost, handle: ChildSessionHandle): void {
  host._childSessionManagerInstance.resumeChildPendingTurn(handle);
}
