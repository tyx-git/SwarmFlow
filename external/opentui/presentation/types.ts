import type { FileModifyDisplayData } from "../../../src/lib/diff-hunk.js";

export type PresentationKind =
  | "user"
  | "thinking"
  | "tool_operation"
  | "tool_group"
  | "assistant"
  | "system"
  | "turn_summary";

export type PresentationState = "active" | "done" | "error";

export type ToolCategory =
  | "observe"
  | "modify"
  | "orchestrate";

export interface InlineResultData {
  text: string;
  dim: boolean;
  maxLines: number;
  /** Text is a preview of a longer full result; render a detail affordance even when preview line count fits. */
  truncated?: boolean;
  toolMetadata?: Record<string, unknown>;
  /** When true, diff lines are rendered without red/green background (for Create/Overwrite). */
  noDiffBackground?: boolean;
}

export interface ToolStreamSectionData {
  key: string;
  label: string;
  text: string;
  complete: boolean;
  contextBefore?: string;
  contextAfter?: string;
  contextResolved?: boolean;
  /** 1-indexed starting line number for this section (from file content probing). */
  startLineNumber?: number;
}

export interface PresentationEntry {
  id: string;
  contentVersion: number;
  kind: PresentationKind;
  state: PresentationState;

  // kind=user
  userText?: string;
  userQueued?: boolean;
  userAttachments?: string[];

  // kind=thinking
  thinkingFullText?: string;

  // kind=tool_operation
  toolDisplayName?: string;
  toolCategory?: ToolCategory;
  toolText?: string;
  toolSuffix?: string;
  toolInterrupted?: boolean;
  /** When set, the toolText represents a sub-agent id — clickable to open that agent's tab. */
  toolAgentName?: string;
  toolStartedAt?: number;
  toolElapsedMs?: number;
  toolInlineResult?: InlineResultData | null;
  toolResultFullText?: string;
  toolStreamSections?: ToolStreamSectionData[];
  toolRepairedFromPartial?: boolean;
  toolExecState?: string;
  toolStreamState?: string;
  toolStreamLanguage?: string;
  toolStreamMode?: "replace" | "append" | "write";

  // kind=tool_group
  /** Individual tool entries within this group. */
  groupEntries?: PresentationEntry[];
  /** Summary label like "Explored (Read ×3, Search ×2)" */
  groupSummary?: string;
  /** Whether the group is still active (last tool still executing). */
  groupActive?: boolean;
  /** The latest tool being executed (for active display). */
  groupLatestToolName?: string;
  /** The latest tool's argument text. */
  groupLatestToolText?: string;

  // kind=assistant
  assistantText?: string;
  assistantStreaming?: boolean;

  // kind=system
  systemText?: string;
  systemSeverity?: "info" | "error" | "compact" | "interrupted" | "sub_agent" | "no_reply";

  // kind=turn_summary
  turnSummaryText?: string;
  turnSummaryInterrupted?: boolean;
  turnSummaryHints?: string[];

  // Unified file-modify display data (replaces toolStreamSections for file-modify tools)
  fileModifyData?: FileModifyDisplayData;
}
