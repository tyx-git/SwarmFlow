/**
 * Log-native summarize_context tool implementation (append-only).
 *
 * Summary entries are appended to the log, but active context is assembled by
 * replacing the covered visible context groups with the new summary group.
 */

import {
  buildActiveContextView,
  expandContextRange,
  type ActiveContextGroup,
  type ActiveContextView,
  type SummaryOrigin,
} from "./context/active-context.js";
import { createSummary, type LogEntry } from "./context/log-entry.js";

export interface SummarizeContextOperation {
  from: string;
  to: string;
  context_ids: string[];
  summary: string;
  reason?: string;
}

export interface OperationResult {
  success: boolean;
  contextIds: string[];
  newContextId?: string;
  error?: string;
}

interface LogValidationResult {
  valid: boolean;
  groups?: ActiveContextGroup[];
  error?: string;
}

export interface LogSummarizeContextExecutionResult {
  output: string;
  results: OperationResult[];
  /** Summary entries to append to the log (caller appends). */
  newEntries: LogEntry[];
}

export interface SummarizeContextExecutionOptions {
  origin?: SummaryOrigin;
  exactRange?: {
    from: string;
    to: string;
    contextIds: string[];
  };
}

function parseOperations(args: Record<string, unknown>): SummarizeContextOperation[] {
  const operations = (args["operations"] as Array<Record<string, unknown>>) ?? [];
  return operations.map((raw) => ({
    from: typeof raw["from"] === "string" ? raw["from"] : "",
    to: typeof raw["to"] === "string" ? raw["to"] : "",
    context_ids: [],
    summary: typeof raw["content"] === "string" ? raw["content"] : "",
    reason: typeof raw["reason"] === "string" && raw["reason"].trim()
      ? raw["reason"]
      : undefined,
  }));
}

/**
 * Build the set of context IDs directly covered by summary entries.
 * Kept for callers that only need a quick coverage set; active context
 * assembly should use buildActiveContextView instead.
 */
export function buildCoveredContextIds(entries: LogEntry[]): Set<string> {
  const covered = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.discarded || entry.type !== "summary") continue;
    const ids = (entry.meta as Record<string, unknown>).coveredContextIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === "string") covered.add(id);
    }
  }
  return covered;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function validateLogOperation(
  op: SummarizeContextOperation,
  view: ActiveContextView,
  options: SummarizeContextExecutionOptions,
  operationCount: number,
): LogValidationResult {
  const { context_ids, summary } = op;

  if (!context_ids.length) {
    return { valid: false, error: "Empty range 鈥?from/to produced no context IDs." };
  }
  if (!summary.trim()) {
    return { valid: false, error: "Empty summary. Provide a non-empty summary string." };
  }

  const groups: ActiveContextGroup[] = [];
  for (const id of context_ids) {
    const group = view.groupByContextId.get(id);
    if (!group) return { valid: false, error: `context_id "${id}" not found in the active context.` };
    groups.push(group);
  }

  if (options.origin === "manual") {
    if (!options.exactRange) {
      return { valid: false, error: "Internal error: missing authorized range contract." };
    }
    if (operationCount !== 1) {
      return { valid: false, error: "This authorization expects exactly one summarize_context operation." };
    }
    if (op.from !== options.exactRange.from || op.to !== options.exactRange.to) {
      return {
        valid: false,
        error: `This authorization must use exactly from="${options.exactRange.from}" and to="${options.exactRange.to}".`,
      };
    }
    if (!sameStringArray(context_ids, options.exactRange.contextIds)) {
      return {
        valid: false,
        error: "Operation range does not match the authorized range.",
      };
    }
    return { valid: true, groups };
  }

  if (groups.some((group) => group.hasUserMessage)) {
    return {
      valid: false,
      error: "Cannot summarize a range that contains user messages. Adjust the range to exclude user-message groups.",
    };
  }

  // Summaries count as the turn they are assigned to in the view (the turn
  // of the nearest preceding surviving user message), so adjacent summaries
  // whose covered anchors are gone can be merged within that turn.
  const turnStart = Math.min(
    ...groups.map((group) => (group.isSummary ? group.assignedTurn : group.turnStart)),
  );
  const turnEnd = Math.max(
    ...groups.map((group) => (group.isSummary ? group.assignedTurn : group.turnEnd)),
  );
  if (turnStart !== turnEnd) {
    return {
      valid: false,
      error: "Cannot summarize across multiple turns. Split the range into one operation per turn and submit them in a single call.",
    };
  }

  return { valid: true, groups };
}

function buildSummaryEntry(
  op: SummarizeContextOperation,
  allocateContextId: () => string,
  allocateLogId: () => string,
  turnIndex: number,
  validation: LogValidationResult,
  origin: SummaryOrigin,
): { result: OperationResult; entry: LogEntry } {
  const newContextId = allocateContextId();
  const summaryEntryId = allocateLogId();
  const groups = validation.groups ?? [];

  let summaryDepth = 1;
  for (const group of groups) {
    if (group.isSummary) {
      summaryDepth = Math.max(summaryDepth, Number(group.summaryDepth ?? 1) + 1);
    }
  }

  const coveredTurnStart = groups.length > 0
    ? Math.min(...groups.map((group) => group.turnStart))
    : turnIndex;
  const coveredTurnEnd = groups.length > 0
    ? Math.max(...groups.map((group) => group.turnEnd))
    : turnIndex;

  const header =
    "[Summarized context 鈥?summarized from earlier conversation. Text inside <user-message> tags " +
    "is the user's original words: carry these blocks verbatim into any future re-summarization. " +
    "This block itself may be re-summarized like any other context.]";
  let display = `${header}\n`;
  if (op.reason) {
    display += `Reason: ${op.reason}\n`;
  }
  const content = `${display}\n${op.summary}`;
  display += `\n${op.summary}`;

  const summaryEntry = createSummary(
    summaryEntryId,
    turnIndex,
    display,
    content,
    newContextId,
    op.context_ids.slice(),
    summaryDepth,
    {
      summaryOrigin: origin,
      coveredTurnStart,
      coveredTurnEnd,
    },
  );

  return {
    result: {
      success: true,
      contextIds: op.context_ids,
      newContextId,
    },
    entry: summaryEntry,
  };
}

function formatExecutionOutput(ops: SummarizeContextOperation[], results: OperationResult[]): string {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const lines: string[] = [];
  lines.push(`Operations: ${ops.length} submitted, ${succeeded} succeeded, ${failed} failed.`);
  lines.push("");
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const op = ops[i];
    const rangeLabel = op.from === op.to ? op.from : `${op.from}..${op.to}`;
    if (result.success) {
      lines.push(`鉁?[${rangeLabel}] 鈫?Replaced with context_id ${String(result.newContextId)}.`);
    } else {
      lines.push(`鉁?[${rangeLabel}] 鈫?Error: ${result.error}`);
    }
  }
  return lines.join("\n");
}

/**
 * Truncate long summarize_context content in projected tool arguments.
 * The full content is preserved in the summary entry; this only shrinks the
 * duplicated copy inside the tool_call before provider submission.
 */
export function truncateSummarizeContextContent(content: string, newContextId?: string | number): string {
  if (content.length <= 100) return content;

  let cutPoint: number;
  const spaceIdx = content.indexOf(" ", 100);
  if (spaceIdx >= 0 && spaceIdx <= 120) {
    cutPoint = spaceIdx;
  } else {
    cutPoint = Math.min(content.length, 120);
  }

  const kept = content.slice(0, cutPoint);
  const ctxRef = newContextId !== undefined ? ` in context_id ${String(newContextId)}` : "";
  return `${kept}... [truncated 鈥?full content preserved${ctxRef}]`;
}

/**
 * Execute summarize_context operations on the active context. Append-only:
 * original entries are never mutated. Returns new summary entries for the
 * caller to append after the summarize_context tool_result.
 */
export function execSummarizeContextOnLog(
  args: Record<string, unknown>,
  entries: LogEntry[],
  contextIdAllocator: () => string,
  logIdAllocator: () => string,
  turnIndex: number,
  options: SummarizeContextExecutionOptions = {},
): LogSummarizeContextExecutionResult {
  const ops = parseOperations(args);
  if (!ops.length) {
    const results: OperationResult[] = [{
      success: false,
      contextIds: [],
      error: "Error: no operations provided.",
    }];
    return {
      output: "Error: no operations provided.",
      results,
      newEntries: [],
    };
  }

  const origin = options.origin ?? "agent";
  const view = buildActiveContextView(entries, { includeCompactContext: false });
  const orderedResults: Array<OperationResult | undefined> = new Array(ops.length);
  const newEntries: LogEntry[] = [];
  const claimedIds = new Set<string>();

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op = ops[opIndex];

    if (!op.from || !op.to) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: [],
        error: "Missing required fields: from and to.",
      };
      continue;
    }

    const expanded = expandContextRange(op.from, op.to, view);
    if (expanded.error) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: [],
        error: expanded.error,
      };
      continue;
    }
    op.context_ids = expanded.contextIds;

    const duplicates = op.context_ids.filter((id) => claimedIds.has(id));
    if (duplicates.length > 0) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: op.context_ids,
        error: `context_id(s) ${duplicates.map((d) => `"${d}"`).join(", ")} already referenced by another operation in this call.`,
      };
      continue;
    }

    const validation = validateLogOperation(op, view, { ...options, origin }, ops.length);
    if (!validation.valid) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: op.context_ids,
        error: validation.error,
      };
      continue;
    }

    const { result, entry } = buildSummaryEntry(
      op,
      contextIdAllocator,
      logIdAllocator,
      turnIndex,
      validation,
      origin,
    );
    orderedResults[opIndex] = result;
    newEntries.push(entry);
    for (const id of op.context_ids) claimedIds.add(id);
  }

  const finalizedResults = orderedResults.map((result, idx) => result ?? ({
    success: false,
    contextIds: ops[idx].context_ids,
    error: "Internal error: missing operation result.",
  }));

  return {
    output: formatExecutionOutput(ops, finalizedResults),
    results: finalizedResults,
    newEntries,
  };
}
