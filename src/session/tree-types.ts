export type ChildSessionMode = "oneshot" | "persistent";

export type ChildSessionLifecycle = "running" | "blocked" | "idle" | "archived";

export type ChildSessionPhase =
  | "idle"
  | "thinking"
  | "tool_calling"
  | "generating"
  | "waiting";

/** 子会话展示态（比 lifecycle 细：error 表示重启后判定为失败）。 */
export type ChildSessionStatus =
  | "working"
  | "idle"
  | "error"
  | "interrupted"
  | "terminated"
  | "completed";

export type ChildSessionOutcome =
  | "none"
  | "completed"
  | "interrupted"
  | "error";

export interface ChildSessionSnapshot {
  id: string;
  numericId: number;
  logRevision: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  phase: ChildSessionPhase;
  /** 展示态。重启对账后统一为 `error`（fail），`outcome` 仍是 `interrupted`。 */
  status: ChildSessionStatus;
  outcome: ChildSessionOutcome;
  running: boolean;
  lifetimeToolCallCount: number;
  lastTotalTokens: number;
  lastToolCallSummary: string;
  recentEvents: string[];
  pendingInboxCount: number;
  lastActivityAt: number;
  // Phase 1 Step 3: child page chrome fields
  inputTokens: number;
  contextBudget: number;
  modelConfigName: string;
  modelProvider: string;
  modelDisplayLabel?: string;
  thinkingLevel?: string;
  pendingAskId?: string | null;
  pendingAskKind?: "agent_question" | "approval" | null;
  activeLogEntryId: string | null;
  turnElapsed: number;
  cacheReadTokens: number;
  cacheSupported: boolean;
  /**
   * 子会话自己的任务清单摘要（内存态，随子会话消亡；释放时随 frozenSnapshot 冻结）。
   * 由父会话的 Agents 面板/子视图只读展示。
   */
  taskSummary?: { total: number; open: number; done: number };
}

/** 子代理结束时回传给 Queen 的未完成本地任务。 */
export interface ChildTaskHandoff {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress";
  activeForm?: string;
  blocks: string[];
  blockedBy: string[];
}

export interface ChildSessionMetaRecord {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  /** 最近的稳定状态；running/working 在恢复时会归一为失败态。 */
  status?: ChildSessionStatus;
  outcome?: ChildSessionOutcome;
  terminationCause?: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt";
  order: number;
  inbox?: MessageEnvelope[];
}

/** 消息类型决定渲染类别——而不是 sender 字符串。*/
export type MessageType = "user_input" | "peer_message" | "system_notice";

export type DeliverMessageRejectionReason =
  | "queued_user_input_pending"
  | "compact_in_progress";

export type DeliverMessageResult =
  | { accepted: true }
  | { accepted: false; reason: DeliverMessageRejectionReason };

/** 用于会话间通信的类型化消息信封。 */
export interface MessageEnvelope {
  type: MessageType;
  sender: string;        // 仅用于显示 — 不用于路由
  content: string;
  timestamp: number;
  /**
   * 传递类别。`true`（默认）：唤醒 — 空闲接收者会安排一个
   * 自动恢复轮次来处理它。`false`：随行 — 排队在收件箱中，
   * 仅当其他事件（用户输入、唤醒消息）启动轮次时才传递。
   * 用户发起的终止发送随行通知：用户在场且正在引导；
   * agent 不得自行开始行动。
   */
  wake?: boolean;
  /** 如果为 true，则由此消息创建的 TUI 条目对用户可见。默认：system_notice/peer_message 为 false。 */
  tuiVisible?: boolean;
  /** 用户提交消息时创建的稳定输入条目。 */
  inputId?: string;
  /** 用户可见的输入索引。对于真实的用户输入存在。 */
  inputIndex?: number;
  /** 在传递给模型之前分配给输入的上下文 ID。 */
  contextId?: string;
}

/**
 * @deprecated 使用 MessageEnvelope。迁移期间保留作为别名。
 */
export type AgentMessage = MessageEnvelope;

/** 将持久化的消息（旧的 AgentMessage 或新的信封）迁移到 MessageEnvelope。 */
export function migrateMessageEnvelope(raw: Record<string, unknown>): MessageEnvelope {
  // 已经是新格式 — 直接通过
  if (raw.type && typeof raw.type === "string" &&
    ["user_input", "peer_message", "system_notice"].includes(raw.type as string)) {
    return raw as unknown as MessageEnvelope;
  }
  // 旧格式：{ from, to, content, timestamp }
  const from = (raw.from as string) ?? "system";
  let type: MessageType = "system_notice";
  if (from === "user") type = "user_input";
  else if (from === "queen") type = "user_input";
  else if (from === "system") type = "system_notice";
  else type = "peer_message"; // agent 名称
  return {
    type,
    sender: from,
    content: (raw.content as string) ?? "",
    timestamp: (raw.timestamp as number) ?? 0,
  };
}

/** 为已归档的子会话保留的记录（Session 实例已释放）。 */
export interface ArchivedChildRecord {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  outcome: ChildSessionOutcome;
  status?: ChildSessionStatus;
  terminationCause?: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt";
  order: number;
  sessionDir: string;
  artifactsDir: string;
}
