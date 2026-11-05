/**
 * ask 订阅、提问执行、两类决议与子会话路由。
 *
 * 只搬"挂起—决议—续跑"这条链；ask 的日志条目构造与轮次锁仍在既有模块，
 * 这里通过 host 虚分派调用。
 */

import { randomUUID } from "node:crypto";

import {
  AskPendingError,
  toPendingAskUi,
  type AgentQuestion,
  type AgentQuestionDecision,
  type AgentQuestionItem,
  type AgentQuestionOption,
  type ApprovalRequest,
  type AskAuditRecord,
  type AskRequest,
  type PendingAskUi,
} from "../ask.js";
import { createAskResolution, createToolResult as createToolResultEntry } from "../context/entry/factories.js";
import { payloadBlockBody } from "../blocks/payload-blocks.js";
import { expectArgsObject } from "../tools/arg-validation.js";
import { createUiText, getUiLanguage } from "../ui/text.js";
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
  // plan 模式：确认门的决议结算（落盘 plan.md / 退出状态），返回给模型的补充行
  isPlanModeActive(): boolean;
  getPlanModeGoal(): string | undefined;
  _settlePlanMode(ask: AgentQuestion, decision: AgentQuestionDecision): string[];
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
 * 订阅挂起 ask 的变化（本会话的和子会话的）。
 * 监听器不带参数；需要当前状态时调用 `getPendingAsk()`。
 */
export function subscribeAsk(host: AskHost, listener: () => void): () => void {
  host._askListeners.add(listener);
  return () => {
    host._askListeners.delete(listener);
  };
}

export function notifyAskChanged(host: AskHost): void {
  // 基于原型的测试替身（Object.create(Session.prototype)）不会执行字段初始化，
  // 这里容忍监听器集合缺失。
  if (!host._askListeners) return;
  for (const listener of host._askListeners) {
    try {
      listener();
    } catch {
      // 订阅者抛错绝不能打断轮次循环。
    }
  }
}

/**
 * 若有挂起的权限审批或 agent_question ask，合成 Deny/Decline 决议
 * 与一条拒绝的 tool_result。拒绝成功返回 true。
 * TUI 在提示框显示时按 ESC/Ctrl+C 会调用它。
 */
export function denyPendingAsk(host: AskHost): boolean {
  const ask = host._activeAsk;
  if (!ask) {
    // 找到这个可见 ask 所属的子会话，经路由去拒绝
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

  // agent_question：合成 decline 决议和一条报错的 tool_result。
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
    // 根回合仍在运行（被杀的是子会话，根回合继续用它的结果）
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
 * 从日志条目还原 ask 状态。
 * 扫描未闭合的 ask_request（没有对应 ask_resolution）。
 */
export function getPendingAsk(host: AskHost): PendingAskUi | null {
  const ownAsk = toPendingAskUi(host._activeAsk);
  if (ownAsk) return ownAsk;
  for (const handle of host._childSessions.values()) {
    const childAsk = handle.session?.getPendingAsk();
    if (childAsk) {
      // 冒泡到根的是子会话的 ask：归属必须改成 child，根才能区分
      // “代子审批”与“中止自己正在跑的轮次”。agentId 用句柄 id——它与子 tab 的
      // selectedChildId 与子会话快照 id 同源。
      return { ...childAsk, owner: { kind: "child", agentId: handle.id, agentName: handle.template } };
    }
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

export interface AskOptionLabels {
  custom: string;
  discuss: string;
  planQuestion: string;
  planConfirm: string;
  planCancel: string;
}

/**
 * ask 面板的选项文案：面向人，跟随 `ui_language`。
 * 这些字符串只用于显示与本地化，模型侧一律按 `kind` / `decisionId` 识别，
 * 所以切语言不会改变任何协议判定。
 */
export function askOptionLabels(): AskOptionLabels {
  const t = createUiText(getUiLanguage());
  return {
    custom: t.get(["Views", "ask", "customAnswer"]),
    discuss: t.get(["Views", "ask", "discussFurther"]),
    planQuestion: t.get(["Views", "ask", "planQuestion"]),
    planConfirm: t.get(["Views", "ask", "planConfirm"]),
    planCancel: t.get(["Views", "ask", "planCancel"]),
  };
}

export function execAsk(host: AskHost, args: Record<string, unknown>): ToolResult {
  // 校验参数
  const questions = args["questions"];
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) {
    return ToolResult.error("Error: 'questions' must be an array of 1-4 items.");
  }
  const labels = askOptionLabels();
  const parsedQuestions: AgentQuestionItem[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown>;
    if (!q || typeof q["question"] !== "string") {
      return ToolResult.error(`Error: questions[${i}].question must be a string.`);
    }
    const opts = q["options"];
    if (!Array.isArray(opts) || opts.length === 0 || opts.length > 4) {
      return ToolResult.error(`Error: questions[${i}].options must be an array of 1-4 items.`);
    }
    const parsedOpts = [];
    for (let j = 0; j < opts.length; j++) {
      const o = opts[j] as Record<string, unknown>;
      if (!o || typeof o["label"] !== "string") {
        return ToolResult.error(`Error: questions[${i}].options[${j}].label must be a string.`);
      }
      parsedOpts.push({
        label: o["label"] as string,
        description: typeof o["description"] === "string" ? (o["description"] as string) : undefined,
        kind: "normal" as const,
      });
    }
    parsedOpts.push({
      label: labels.custom,
      kind: "custom_input" as const,
      systemAdded: true,
    });
    parsedOpts.push({
      label: labels.discuss,
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
    payload: { questions: parsedQuestions, toolCallId: "", toolName: "ask" },
    options: [], // 每个问题的选项放在 payload 里
  };
  throw new AskPendingError(ask);
}

/**
 * 确认门：`present_plan` 的正文（裸块载荷）渲染成计划视图，选项全部由代码给出。
 * 模型不写选项、也不写 plan.md；决议在 resolve 阶段结算。
 */
export function execPresentPlan(
  host: AskHost,
  args: Record<string, unknown>,
  toolPayload: string | undefined,
): ToolResult {
  const a = expectArgsObject("present_plan", args);
  if (Object.keys(a).length > 0) {
    return ToolResult.error(
      "ERROR: present_plan takes no arguments; put the plan in the assistant message body between '*** Begin Plan' and '*** End Plan'.",
    );
  }
  if (!host.isPlanModeActive()) {
    return ToolResult.error(
      "ERROR: present_plan is only available while plan mode is active. Enter it with /plan.",
    );
  }
  if (typeof toolPayload !== "string" || toolPayload.trim().length === 0) {
    return ToolResult.error(
      "ERROR: present_plan requires the plan body in the assistant message body ('*** Begin Plan' ... '*** End Plan') and no tool arguments.",
    );
  }

  const planContent = payloadBlockBody(toolPayload);
  if (planContent.length === 0) {
    return ToolResult.error(
      "ERROR: present_plan received an empty plan body. Write the plan between '*** Begin Plan' and '*** End Plan'.",
    );
  }

  const labels = askOptionLabels();
  const ask: AgentQuestion = {
    id: randomUUID(),
    kind: "agent_question",
    createdAt: new Date().toISOString(),
    source: {
      agentId: host.primaryAgent.name,
      agentName: host.primaryAgent.name,
      toolName: "present_plan",
    },
    roundIndex: undefined,
    summary: `Plan confirmation: ${labels.planQuestion}`,
    payload: {
      questions: [{
        question: labels.planQuestion,
        planContent,
        options: [
          { label: labels.planConfirm, kind: "normal" as const, systemAdded: true, decisionId: "plan_confirm" as const },
          { label: labels.planCancel, kind: "normal" as const, systemAdded: true, decisionId: "plan_cancel" as const },
          { label: labels.custom, kind: "custom_input" as const, systemAdded: true },
        ],
      }],
      toolCallId: "",
      toolName: "present_plan",
    },
    options: [],
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

  // 在日志里创建 ask_resolution 条目
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
  // 确认门结算：批准则此刻落盘 plan.md 并退出 plan 模式；给模型的行保持英文稳定。
  const planLines = ask.payload.toolName === "present_plan"
    ? host._settlePlanMode(ask, decision)
    : [];
  const settledResult = planLines.length > 0
    ? new ToolResult({ content: `${toolResult.content}\n\n${planLines.join("\n")}` })
    : toolResult;
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
      toolName: ask.payload.toolName ?? "ask",
      content: settledResult.content,
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
 * 决议一个权限审批 ask。
 * @param askId  要决议的 ask ID。
 * @param choiceIndex  ask 的 options 数组下标。最后一个选项固定是 "Deny"。
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

  // 记录决议结果
  host._appendEntry(createAskResolution(
    host._nextLogId("ask_resolution"),
    anchor.turnIndex,
    { choice: choiceLabel, toolName: payload.toolName },
    askId,
    "approval",
  ), false);

  if (isDeny) {
    // 注入一条拒绝的 tool_result，让模型知道
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
    // 应用所选 offer。批准后的 tool_call 授权会在 resume 时
    // 由 _drainPendingToolCalls 消费。
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
 * 把 ask 操作路由到正确的会话（本会话或子会话）。
 * ask 属于本会话就跑 onSelf；属于子会话就先跑 onChild，
 * 再续跑该子会话挂起的回合。
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
