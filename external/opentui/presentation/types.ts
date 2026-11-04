import type { FileModifyDisplayData } from "../../../src/patches/hunk.js";

export type PresentationKind =
  | "user"
  | "command_echo"
  | "thinking"
  | "tool_operation"
  | "tool_group"
  | "assistant"
  | "system"
  | "turn_summary"
  | "tips";

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
  /** 命令或文件输出的可选语言提示。 */
  language?: string;
  /** 存在语言提示时按源码或命令文本渲染普通输出。 */
  syntaxMode?: "command" | "output";
}

export interface PresentationEntry {
  id: string;
  contentVersion: number;
  kind: PresentationKind;
  state: PresentationState;

  // kind=user
  userText?: string;
  userQueued?: boolean;

  // kind=command_echo
  commandEchoText?: string;
  commandEchoTone?: "worked";

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
  toolInlineResult?: InlineResultData | null;
  toolResultFullText?: string;

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
  turnSummaryError?: boolean;
  turnSummaryHints?: string[];

  // kind=tips
  tipsText?: string;

  // Unified file-modify display data (edit tool result)
  /** 一次 `edit` 补丁按文件拆分的展示数据。 */
  fileModifyDataList?: FileModifyDisplayData[];
  /** `edit` 的 A/M/D 文件清单（与 fileModifyDataList 同序）。 */
  patchFiles?: Array<{ kind: "A" | "M" | "D"; path: string; from?: string }>;
}
