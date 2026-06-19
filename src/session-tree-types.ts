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

/** Typed message envelope for inter-session communication. */
export interface MessageEnvelope {
  type: MessageType;
  sender: string;        // display only —not used for routing
  content: string;
  timestamp: number;
  /**
   * Delivery class. `true` (default): waking —an idle recipient schedules an
   * auto-resume turn to process it. `false`: ride-along —queued in the inbox
   * and delivered only when something else (user input, a waking message)
   * starts a turn. User-initiated kills send ride-along notices: the user is
   * present and steering; the agent must not start acting on its own.
   */
  wake?: boolean;
  /** When true, the TUI entry created from this message is visible to the user. Default: false for system_notice/peer_message. */
  tuiVisible?: boolean;
  /** Stable input entry created when the user submitted the message. */
  inputId?: string;
  /** User-visible input index. Present for real user input. */
  inputIndex?: number;
  /** Context id assigned to the input before delivery to the model. */
  contextId?: string;
}

/**
 * @deprecated Use MessageEnvelope. Kept as alias during migration.
 */
export type AgentMessage = MessageEnvelope;

/** Migrate a persisted message (old AgentMessage or new envelope) to MessageEnvelope. */
export function migrateMessageEnvelope(raw: Record<string, unknown>): MessageEnvelope {
  // New format already —pass through
  if (raw.type && typeof raw.type === "string" &&
      ["user_input", "peer_message", "system_notice"].includes(raw.type as string)) {
    return raw as unknown as MessageEnvelope;
  }
  // Old format: { from, to, content, timestamp }
  const from = (raw.from as string) ?? "system";
  let type: MessageType = "system_notice";
  if (from === "user") type = "user_input";
  else if (from === "main") type = "user_input";
  else if (from === "system") type = "system_notice";
  else type = "peer_message"; // agent name
  return {
    type,
    sender: from,
    content: (raw.content as string) ?? "",
    timestamp: (raw.timestamp as number) ?? 0,
  };
}

/** Record kept for archived children (Session instance released). */
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
