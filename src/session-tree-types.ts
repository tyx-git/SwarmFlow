export type ChildSessionMode = "oneshot" | "persistent";

export type ChildSessionLifecycle = "running" | "blocked" | "idle" | "archived";

export type ChildSessionPhase =
  | "idle"
  | "thinking"
  | "tool_calling"
  | "generating"
  | "waiting";

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
  pendingAskId?: string | null;
  pendingAskKind?: "agent_question" | "approval" | null;
  activeLogEntryId: string | null;
  turnElapsed: number;
  cacheReadTokens: number;
}

export interface ChildSessionMetaRecord {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  outcome?: ChildSessionOutcome;
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
  else if (from === "main") type = "user_input";
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
  order: number;
  sessionDir: string;
  artifactsDir: string;
}