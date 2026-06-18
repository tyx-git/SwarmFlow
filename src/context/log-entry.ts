/**
 * Structured log entry types and factory functions.
 *
 * Core data structure for the Session Log Architecture v2.
 * Every event in a session is recorded as a LogEntry.
 * TUI and API views are projected from the log.
 */

// ------------------------------------------------------------------
// Enums
// ------------------------------------------------------------------

import type { ThinkingArtifact } from "./lib/thinking-artifact.js";

export type LogEntryType =
  | "system_prompt"
  | "work_start"
  | "work_end"
  | "input_received"
  | "turn_start"
  | "turn_end"
  | "user_message"
  | "agent_result"
  | "assistant_text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "ask_request"
  | "ask_resolution"
  | "no_reply"
  | "compact_marker"
  | "compact_context"
  | "summary"
  | "interruption_marker"
  | "sub_agent_start"
  | "sub_agent_tool_call"
  | "sub_agent_end"
  | "status"
  | "error"
  | "token_update";

export type TurnKind = "user" | "summarize" | "compact";
export type InputKind = "user" | "system" | "peer" | "summarize" | "compact";

export type TuiDisplayKind =
  | "user"
  | "agent_result"
  | "assistant"
  | "reasoning"
  | "progress"
  | "tool_call"
  | "status"
  | "error"
  | "compact_mark"
  | "tool_result";

// ------------------------------------------------------------------
// LogEntry interface
// ------------------------------------------------------------------

export interface LogEntry {
  /** Unique entry ID (type prefix + sequence number, e.g. "user-001", "tc-005"). */
  id: string;

  /** Entry type 鈥?determines content structure and projection rules. */
  type: LogEntryType;

  /** Unix millisecond timestamp. */
  timestamp: number;

  /**
   * User-visible input index (starts at 1, increments on each real user
   * input). This field is intentionally still named turnIndex during the
   * runtime migration; semantically it is no longer a work lifecycle id.
   */
  turnIndex: number;

  /**
   * Provider call round within the same turn (0-based).
   * Groups assistant_text + tool_call entries into one API message.
   * Only present on provider-related entries (assistant_text, reasoning,
   * tool_call, tool_result, no_reply).
   */
  roundIndex?: number;

  // ---- TUI projection layer ----

  /** Whether this entry is visible in TUI. */
  tuiVisible: boolean;

  /** TUI rendering style. null when tuiVisible is false. */
  displayKind: TuiDisplayKind | null;

  /** TUI display text. Always retained in the active log. */
  display: string;

  // ---- API projection layer ----

  /** The API role this entry maps to. null = not part of API projection. */
  apiRole: "system" | "user" | "assistant" | "tool_result" | null;

  /** Full content for API projection. null after archiving. */
  content: unknown;

  /** Whether content has been archived to a separate file. */
  archived: boolean;

  // ---- State markers ----

  /** Discarded entry (skip in projections). Used for compact rollback etc. */
  discarded?: boolean;

  // ---- Type-specific metadata ----

  /** Structured metadata varying by entry type. */
  meta: Record<string, unknown>;
}

export interface ToolCallLogContent {
  id: string;
  name: string;
  rawArguments?: string;
  arguments: Record<string, unknown>;
  parseError?: string | null;
}

export const AGENT_RESULT_TUI_PREVIEW_LINES = 8;

export function buildAgentResultTuiPreview(
  content: string,
  maxLines = AGENT_RESULT_TUI_PREVIEW_LINES,
): { text: string; truncated: boolean } {
  if (!content) {
    return { text: "", truncated: false };
  }
  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return { text: content, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

// ------------------------------------------------------------------
// ID Allocator
// ------------------------------------------------------------------

/** Map from LogEntryType to its ID prefix. */
const TYPE_PREFIX_MAP: Record<LogEntryType, string> = {
  system_prompt: "sys",
  work_start: "ws",
  work_end: "we",
  input_received: "in",
  turn_start: "ts",
  turn_end: "te",
  user_message: "user",
  agent_result: "ar",
  assistant_text: "asst",
  reasoning: "rsn",
  tool_call: "tc",
  tool_result: "tr",
  ask_request: "askq",
  ask_resolution: "askr",
  no_reply: "nr",
  compact_marker: "cm",
  compact_context: "cc",
  summary: "sum",
  interruption_marker: "int",
  sub_agent_start: "sas",
  sub_agent_tool_call: "satc",
  sub_agent_end: "sae",
  status: "st",
  error: "err",
  token_update: "tok",
};

/**
 * Generates sequential IDs like "user-001", "tc-005".
 * Maintains per-prefix counters.
 */
export class LogIdAllocator {
  private _counters = new Map<string, number>();

  /** Allocate the next ID for a given entry type. */
  next(type: LogEntryType): string {
    const prefix = TYPE_PREFIX_MAP[type];
    const count = (this._counters.get(prefix) ?? 0) + 1;
    this._counters.set(prefix, count);
    return `${prefix}-${String(count).padStart(3, "0")}`;
  }

  /**
   * Restore counters from an existing log (e.g. after loadLog).
   * Scans all entries and sets each prefix counter to the max seen.
   */
  restoreFrom(entries: LogEntry[]): void {
    this._counters.clear();
    for (const entry of entries) {
      const dashIdx = entry.id.lastIndexOf("-");
      if (dashIdx === -1) continue;
      const prefix = entry.id.slice(0, dashIdx);
      const num = parseInt(entry.id.slice(dashIdx + 1), 10);
      if (!isNaN(num)) {
        const current = this._counters.get(prefix) ?? 0;
        if (num > current) {
          this._counters.set(prefix, num);
        }
      }
    }
  }

  /** Get the current counter value for a prefix (for testing). */
  getCounter(type: LogEntryType): number {
    const prefix = TYPE_PREFIX_MAP[type];
    return this._counters.get(prefix) ?? 0;
  }
}

// ------------------------------------------------------------------
// Factory helpers
// ------------------------------------------------------------------

function baseEntry(
  id: string,
  type: LogEntryType,
  turnIndex: number,
  partial: Partial<LogEntry>,
): LogEntry {
  return {
    id,
    type,
    timestamp: Date.now(),
    turnIndex,
    tuiVisible: false,
    displayKind: null,
    display: "",
    apiRole: null,
    content: null,
    archived: false,
    meta: {},
    ...partial,
  };
}

// ------------------------------------------------------------------
// Factory functions 鈥?one per entry type
// ------------------------------------------------------------------

export function createSystemPrompt(
  id: string,
  content: string,
): LogEntry {
  return baseEntry(id, "system_prompt", 0, {
    apiRole: "system",
    content,
  });
}

export function createWorkStart(
  id: string,
  turnIndex: number,
  workId: string,
): LogEntry {
  return baseEntry(id, "work_start", turnIndex, {
    meta: { workId, timestamp: Date.now() },
  });
}

export function createWorkEnd(
  id: string,
  turnIndex: number,
  workId: string,
  status: "completed" | "interrupted" | "error",
  elapsedMs?: number,
  interruptHints?: string[],
): LogEntry {
  return baseEntry(id, "work_end", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display: "",
    meta: { workId, status, timestamp: Date.now(), elapsedMs, interruptHints },
  });
}

export function createInputReceived(
  id: string,
  turnIndex: number,
  inputId: string,
  inputKind: InputKind,
  display: string,
  content: unknown,
  contextId: string,
  opts?: { tuiVisible?: boolean; sender?: string },
): LogEntry {
  const tuiVisible = opts?.tuiVisible ?? (
    inputKind === "user" || inputKind === "summarize" || inputKind === "compact"
  );
  const meta: Record<string, unknown> = { inputId, inputKind, contextId };
  if (opts?.sender) meta.sender = opts.sender;
  return baseEntry(id, "input_received", turnIndex, {
    tuiVisible,
    displayKind: tuiVisible ? "user" : null,
    display,
    apiRole: null,
    content,
    meta,
  });
}

export function createTurnStart(
  id: string,
  turnIndex: number,
  turnKind: TurnKind = "user",
): LogEntry {
  return baseEntry(id, "turn_start", turnIndex, {
    meta: { turnIndex, turnKind, timestamp: Date.now() },
  });
}

export function createTurnEnd(
  id: string,
  turnIndex: number,
  status: "completed" | "interrupted" | "error",
  elapsedMs?: number,
  interruptHints?: string[],
): LogEntry {
  return baseEntry(id, "turn_end", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display: "",
    meta: { turnIndex, status, timestamp: Date.now(), elapsedMs, interruptHints },
  });
}

export function createUserMessage(
  id: string,
  turnIndex: number,
  display: string,
  content: unknown,
  contextId: string,
  opts?: { tuiVisible?: boolean; inputId?: string; inputKind?: InputKind },
): LogEntry {
  const tuiVisible = opts?.tuiVisible ?? true;
  const meta: Record<string, unknown> = { contextId };
  if (opts?.inputId) meta.inputId = opts.inputId;
  if (opts?.inputKind) meta.inputKind = opts.inputKind;
  return baseEntry(id, "user_message", turnIndex, {
    tuiVisible,
    displayKind: tuiVisible ? "user" : null,
    display,
    apiRole: "user",
    content,
    meta,
  });
}

export function createAgentResult(
  id: string,
  turnIndex: number,
  agentId: string,
  agentNumericId: number,
  agentTemplate: string,
  outcome: "completed" | "failed" | "interrupted",
  cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt",
  elapsedMs: number,
  content: string,
  contextId: string,
  fullOutputPath?: string,
): LogEntry {
  const preview = buildAgentResultTuiPreview(content);
  const meta: Record<string, unknown> = {
    contextId,
    agentId,
    agentNumericId,
    agentTemplate,
    outcome,
    cause,
    elapsedMs,
  };
  if (preview.truncated) meta.tuiPreviewTruncated = true;
  if (fullOutputPath) meta.fullOutputPath = fullOutputPath;
  return baseEntry(id, "agent_result", turnIndex, {
    tuiVisible: true,
    displayKind: "agent_result",
    display: preview.text,
    apiRole: null,
    content,
    meta,
  });
}

export function createAssistantText(
  id: string,
  turnIndex: number,
  roundIndex: number,
  display: string,
  content: string,
  contextId?: string,
): LogEntry {
  return baseEntry(id, "assistant_text", turnIndex, {
    roundIndex,
    tuiVisible: true,
    displayKind: "assistant",
    display,
    apiRole: "assistant",
    content,
    meta: contextId ? { contextId } : {},
  });
}

export function createReasoning(
  id: string,
  turnIndex: number,
  roundIndex: number,
  display: string,
  content: unknown,
  reasoningState?: unknown,
  contextId?: string,
  thinkingArtifact?: ThinkingArtifact | null,
): LogEntry {
  const meta: Record<string, unknown> = {};
  if (reasoningState !== undefined) meta.reasoningState = reasoningState;
  if (contextId !== undefined) meta.contextId = contextId;
  if (thinkingArtifact) meta.thinkingArtifact = thinkingArtifact;
  return baseEntry(id, "reasoning", turnIndex, {
    roundIndex,
    tuiVisible: true,
    displayKind: "reasoning",
    display,
    apiRole: null,
    content,
    meta,
  });
}

export function createToolCall(
  id: string,
  turnIndex: number,
  roundIndex: number,
  display: string,
  toolCallContent: ToolCallLogContent,
  opts: { toolCallId: string; toolName: string; agentName: string; contextId?: string },
  apiRole: LogEntry["apiRole"] = "assistant",
): LogEntry {
  const meta: Record<string, unknown> = {
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    agentName: opts.agentName,
  };
  if (opts.contextId !== undefined) meta.contextId = opts.contextId;
  return baseEntry(id, "tool_call", turnIndex, {
    roundIndex,
    tuiVisible: true,
    displayKind: "tool_call",
    display,
    apiRole,
    content: {
      ...toolCallContent,
      rawArguments: toolCallContent.rawArguments ?? JSON.stringify(toolCallContent.arguments ?? {}),
      parseError: toolCallContent.parseError ?? null,
    },
    meta,
  });
}

export function createToolResult(
  id: string,
  turnIndex: number,
  roundIndex: number,
  resultContent: { toolCallId: string; toolName: string; content: string; toolSummary: string },
  opts: {
    isError: boolean;
    contextId?: string;
    toolMetadata?: Record<string, unknown>;
    execStartMs?: number;
    interrupt?: {
      kind: "not_started" | "execution_interrupted";
      partialEffectsPossible?: boolean;
      incompleteArguments?: boolean;
    };
    previewText?: string;
    /** When true, TUI renders the preview in dim/gray style. */
    previewDim?: boolean;
  },
): LogEntry {
  const meta: Record<string, unknown> = {
    toolCallId: resultContent.toolCallId,
    toolName: resultContent.toolName,
    isError: opts.isError,
  };
  if (opts.contextId !== undefined) meta.contextId = opts.contextId;
  if (opts.toolMetadata && Object.keys(opts.toolMetadata).length > 0) {
    meta.toolMetadata = opts.toolMetadata;
  }
  if (opts.execStartMs !== undefined) meta.execStartMs = opts.execStartMs;
  if (opts.interrupt) meta.interrupt = opts.interrupt;
  if (opts.previewDim) meta.tuiDim = true;
  const hasDisplay = Boolean(opts.previewText) || opts.isError;
  return baseEntry(id, "tool_result", turnIndex, {
    roundIndex,
    tuiVisible: hasDisplay,
    displayKind: hasDisplay ? "tool_result" : null,
    display: opts.previewText ?? (opts.isError ? resultContent.content : ""),
    apiRole: "tool_result",
    content: resultContent,
    meta,
  });
}

export function createNoReply(
  id: string,
  turnIndex: number,
  roundIndex: number,
  content: string,
  contextId?: string,
): LogEntry {
  return baseEntry(id, "no_reply", turnIndex, {
    roundIndex,
    apiRole: "assistant",
    content,
    meta: contextId ? { contextId } : {},
  });
}

export function createCompactMarker(
  id: string,
  turnIndex: number,
  compactIndex: number,
  originalTokens: number,
  compactedTokens: number,
): LogEntry {
  return baseEntry(id, "compact_marker", turnIndex, {
    tuiVisible: true,
    displayKind: "compact_mark",
    display: "\u2014 Compacted \u2014",
    meta: { compactIndex, originalTokens, compactedTokens },
  });
}

export function createCompactContext(
  id: string,
  turnIndex: number,
  content: string,
  contextId: string,
  compactIndex: number,
): LogEntry {
  return baseEntry(id, "compact_context", turnIndex, {
    apiRole: "user",
    content,
    meta: { contextId, compactIndex },
  });
}

export function createSummary(
  id: string,
  turnIndex: number,
  display: string,
  content: string,
  contextId: string,
  coveredContextIds: string[],
  summaryDepth: number,
  opts?: {
    summaryOrigin?: "agent" | "manual";
    coveredTurnStart?: number;
    coveredTurnEnd?: number;
  },
): LogEntry {
  const meta: Record<string, unknown> = {
    contextId,
    coveredContextIds,
    summaryDepth,
    summaryOrigin: opts?.summaryOrigin ?? "agent",
  };
  if (opts?.coveredTurnStart !== undefined) meta.coveredTurnStart = opts.coveredTurnStart;
  if (opts?.coveredTurnEnd !== undefined) meta.coveredTurnEnd = opts.coveredTurnEnd;
  return baseEntry(id, "summary", turnIndex, {
    tuiVisible: true,
    displayKind: "user",
    display,
    apiRole: "user",
    content,
    meta,
  });
}

export function createInterruptionMarker(
  id: string,
  turnIndex: number,
  content: string,
  terminatedSubAgents?: string[],
): LogEntry {
  return baseEntry(id, "interruption_marker", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display: "[System]: Last turn was interrupted by the user.",
    apiRole: "user",
    content,
    meta: terminatedSubAgents?.length ? { terminatedSubAgents } : {},
  });
}

export function createSubAgentStart(
  id: string,
  turnIndex: number,
  display: string,
  subAgentId: number,
  subAgentName: string,
  task: string,
): LogEntry {
  return baseEntry(id, "sub_agent_start", turnIndex, {
    tuiVisible: true,
    displayKind: "progress",
    display,
    meta: { subAgentId, subAgentName, task },
  });
}

export function createSubAgentToolCall(
  id: string,
  turnIndex: number,
  display: string,
  subAgentId: number,
  subAgentName: string,
  toolName: string,
  toolCallCount: number,
): LogEntry {
  return baseEntry(id, "sub_agent_tool_call", turnIndex, {
    tuiVisible: true,
    displayKind: "progress",
    display,
    meta: { subAgentId, subAgentName, toolName, toolCallCount },
  });
}

export function createSubAgentEnd(
  id: string,
  turnIndex: number,
  display: string,
  subAgentId: number,
  subAgentName: string,
  elapsed: number,
  toolCallCount: number,
): LogEntry {
  return baseEntry(id, "sub_agent_end", turnIndex, {
    tuiVisible: true,
    displayKind: "progress",
    display,
    meta: { subAgentId, subAgentName, elapsed, toolCallCount },
  });
}

export function createStatus(
  id: string,
  turnIndex: number,
  display: string,
  statusType: string,
): LogEntry {
  return baseEntry(id, "status", turnIndex, {
    tuiVisible: true,
    displayKind: "status",
    display,
    meta: { statusType },
  });
}

export function createError(
  id: string,
  turnIndex: number,
  display: string,
  errorType?: string,
): LogEntry {
  return baseEntry(id, "error", turnIndex, {
    tuiVisible: true,
    displayKind: "error",
    display,
    meta: errorType ? { errorType } : {},
  });
}

export function createTokenUpdate(
  id: string,
  turnIndex: number,
  inputTokens: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
  totalTokens?: number,
): LogEntry {
  const meta: Record<string, unknown> = { inputTokens };
  if (cacheReadTokens !== undefined) meta.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) meta.cacheCreationTokens = cacheCreationTokens;
  if (totalTokens !== undefined) meta.totalTokens = totalTokens;
  return baseEntry(id, "token_update", turnIndex, { meta });
}

export function createAskRequest(
  id: string,
  turnIndex: number,
  content: unknown,
  askId: string,
  askKind: string,
  toolCallId: string,
  roundIndex: number,
  contextId?: string,
): LogEntry {
  const meta: Record<string, unknown> = { askId, askKind, toolCallId, roundIndex };
  if (contextId !== undefined) meta.contextId = contextId;
  return baseEntry(id, "ask_request", turnIndex, {
    content,
    meta,
  });
}

export function createAskResolution(
  id: string,
  turnIndex: number,
  content: unknown,
  askId: string,
  askKind: string,
): LogEntry {
  return baseEntry(id, "ask_resolution", turnIndex, {
    content,
    meta: { askId, askKind },
  });
}
