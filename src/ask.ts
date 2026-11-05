/**
 * Ask 协议——Agent 在执行过程中向用户提问的标准化机制。
 *
 * 支持两种提问类型：
 *   - agent_question：多选题、自定义输入、继续讨论
 *   - approval：工具执行前的权限审批（批准/拒绝/永久规则）
 *
 * 协议流程：
 *   1. Agent 调用 ask 工具，tool-loop 捕获到 AskPendingError 暂停执行
 *   2. Session 将 ask 路由到 TUI 显示给用户
 *   3. 用户选择后，Session 将答案注入日志并恢复 tool-loop
 *   4. ask 结果记录在审计日志（AskAuditRecord）中
 *
 * 安全设计：ask 工具必须经用户明确交互才能继续，Agent 无法绕过。
 */

/** 提问类型：Agent 问题（多选/自定义） 或 工具审批。 */
export type AskKind = "agent_question" | "approval";

/**
 * 挂起 ask 的归属：`self` 是本会话自己的 ask；`child` 是子会话的 ask，
 * 由本会话的 `getPendingAsk()` 冒泡上来代管（主 tab 要能替子审批）。
 *
 * `agentId` 用子会话句柄 id——它与子 tab 的 selectedChildId、子会话快照 id
 * 同源；不要用 `source.agentId`（那是子会话内部的 agent 角色 id）。
 * 归属决定代管动作的边界：deny 子 ask 只杀子，deny 自己的 ask 才会中止本会话
 * 正在跑的轮次；缺归属就只能靠猜测，猜测会把本会话误判成挂起状态。
 */
export type AskOwner =
  | { kind: "self" }
  | { kind: "child"; agentId: string; agentName?: string };

/** 提问的来源 Agent 信息。 */
export interface AskSource {
  agentId: string;
  agentName?: string;
  toolName?: string;
  turnId?: string;
}

/** Ask 请求的基类字段。 */
export interface AskBase {
  id: string;
  kind: AskKind;
  createdAt: string;
  source: AskSource;
  summary: string;
  roundIndex?: number;
  /**
   * 被暂停的工具调用所属的 turn。
   * 所有答案记录（ask_resolution、tool_result）必须锚定到此 turn——
   * 暂停期间 live turn 计数器可能继续前进。
   */
  turnIndex?: number;
}

/** Agent 问题选项的种类。 */
export type AgentQuestionOptionKind = "normal" | "custom_input" | "discuss_further";

/** Agent 问题的单个选项。 */
export interface AgentQuestionOption {
  label: string;
  description?: string;
  kind: AgentQuestionOptionKind;
  /** 系统自动添加的选项（如"自定义输入"）。 */
  systemAdded?: boolean;
  /**
   * 计划确认门的稳定标识。决议一律按它判定——标签会被本地化，
   * 按字符串比较标签在切语言后必然失效。
   */
  decisionId?: "plan_confirm" | "plan_cancel";
}

/**
 * "继续讨论" 选项的指导文本——告诉 Agent 如何处理此类回答。
 * 面向模型，保持英文稳定；选项本身按 `kind` 识别，不按标签文本。
 */
export const ASK_DISCUSS_FURTHER_GUIDANCE =
  'One or more answers are "Discuss further". Treat those answers as requests to continue the discussion rather than final commitments. Use any other answers normally. Briefly address the discussion points, then return control to the user.';

/** Agent 问题中的单个问题项。 */
export interface AgentQuestionItem {
  question: string;
  options: AgentQuestionOption[];
  /**
   * 计划确认门的计划正文（present_plan 的裸块载荷）。
   * 只供界面渲染计划视图，不进选项文本，也不回给模型。
   */
  planContent?: string;
}

/** 用户对某个问题的回答。 */
export interface AgentQuestionAnswer {
  questionIndex: number;
  selectedOptionIndex: number;
  answerText: string;
  /** 用户通过 Tab 添加的附注。 */
  note?: string;
}

/** 用户对所有问题的完整回答。 */
export interface AgentQuestionDecision {
  answers: AgentQuestionAnswer[];
}

/** Agent 向用户提问的完整请求（agent_question 类型）。 */
export interface AgentQuestion extends AskBase {
  kind: "agent_question";
  payload: {
    questions: AgentQuestionItem[];
    toolCallId: string;
    /** 产生本次提问的工具名；结果条目按它归属，默认 `ask`。 */
    toolName?: string;
  };
  options: string[];
}

/** 工具执行前的权限审批请求（approval 类型）。 */
export interface ApprovalRequest extends AskBase {
  kind: "approval";
  payload: {
    toolCallId: string;
    toolName: string;
    toolSummary: string;
    permissionClass: string;
    offers: Array<{
      type: string;
      label: string;
      scope?: string;
      rule?: Record<string, unknown>;
    }>;
    /** 永久规则选项前显示的警告（灰色文字，不可选择）。 */
    persistentWarning?: string;
    /** `edit` 涉及的绝对路径（最多 8 条），供审批界面展示。 */
    files?: string[];
  };
  options: string[];
}

/** 所有 Ask 请求的联合类型。 */
export type AskRequest = AgentQuestion | ApprovalRequest;

/** TUI 层使用的 Ask 展示结构（payload 扁平化）。 */
export interface PendingAskUi {
  id: string;
  kind: AskKind;
  createdAt: string;
  summary: string;
  /** 归属：本会话自己，还是代管子会话的。 */
  owner: AskOwner;
  source: AskSource;
  payload: Record<string, unknown>;
  options: string[];
}

/** Ask 审计记录——持久化到日志，用于合规审查。 */
export interface AskAuditRecord {
  askId: string;
  kind: AskKind;
  summary: string;
  decidedAt: string;
  decision: string;
  source: AskSource;
}

/** 暂停中的 turn 状态——用于 Session 在恢复时重建执行上下文。 */
export interface PendingTurnState {
  stage: "pre_user_input" | "activation";
  userInput?: string;
  nextActivationIdx?: number;
  convLenBefore?: number;
  pendingToolResultText?: string;
  pendingToolCallId?: string;
}

/**
 * Ask 暂停错误——从 tool-loop 抛出，Session 捕获并路由到 TUI。
 *
 * 实现了 AskPendingError 名称的 duck-typing 检查，
 * 以便在跨边界（如 postMessage）传输后仍能识别。
 */
export class AskPendingError extends Error {
  askId: string;
  ask?: AskRequest;

  constructor(askOrId: string | AskRequest) {
    const askId = typeof askOrId === "string" ? askOrId : askOrId.id;
    super(`Ask request pending resolution (${askId})`);
    this.name = "AskPendingError";
    this.askId = askId;
    if (typeof askOrId !== "string") {
      this.ask = askOrId;
    }
  }
}

/** 判断是否为 AskPendingError（支持跨边界传输后的 duck-typing）。 */
export function isAskPendingError(err: unknown): err is AskPendingError {
  return err instanceof AskPendingError ||
    ((err as any)?.name === "AskPendingError" && typeof (err as any)?.askId === "string");
}

/** 将 AskRequest 转换为 TUI 展示用的 PendingAskUi。 */
export function toPendingAskUi(ask: AskRequest | null): PendingAskUi | null {
  if (!ask) return null;
  return {
    id: ask.id,
    kind: ask.kind,
    createdAt: ask.createdAt,
    summary: ask.summary,
    // 每个 Session 报告自己的 ask 都是 self；冒泡子 ask 由 getPendingAsk 重贴 child。
    owner: { kind: "self" },
    source: ask.source,
    payload: ask.payload as Record<string, unknown>,
    options: [...ask.options],
  };
}
