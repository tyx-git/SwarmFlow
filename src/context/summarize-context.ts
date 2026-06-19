/**
 * 基于日志的 summarize_context 工具实现（仅追加）。
 *
 * 摘要条目被追加到日志中，但活动上下文通过将覆盖的可见上下文分组
 * 替换为新的摘要分组来组装。
 */

import {
  buildActiveContextView,
  expandContextRange,
  type ActiveContextGroup,
  type ActiveContextView,
  type SummaryOrigin,
} from "../context/active-context.js";
import { createSummary, type LogEntry } from "../context/log-entry.js";

/** 摘要上下文操作——指定要摘要的范围和内容 */
export interface SummarizeContextOperation {
  /** 起始上下文 ID */
  from: string;
  /** 结束上下文 ID */
  to: string;
  /** 要摘要的上下文 ID 列表 */
  context_ids: string[];
  /** 摘要内容 */
  summary: string;
  /** 摘要原因（可选） */
  reason?: string;
}

/** 操作结果 */
export interface OperationResult {
  /** 是否成功 */
  success: boolean;
  /** 影响的上下文 ID 列表 */
  contextIds: string[];
  /** 新创建的摘要上下文 ID */
  newContextId?: string;
  /** 错误信息 */
  error?: string;
}

/** 日志验证结果 */
interface LogValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 有效的上下文分组 */
  groups?: ActiveContextGroup[];
  /** 错误信息 */
  error?: string;
}

/** 日志摘要上下文执行结果 */
export interface LogSummarizeContextExecutionResult {
  /** 输出文本 */
  output: string;
  /** 操作结果列表 */
  results: OperationResult[];
  /** 要追加到日志的摘要条目（由调用者追加） */
  newEntries: LogEntry[];
}

/** 摘要上下文执行选项 */
export interface SummarizeContextExecutionOptions {
  /** 摘要来源 */
  origin?: SummaryOrigin;
  /** 精确范围（可选） */
  exactRange?: {
    /** 起始上下文 ID */
    from: string;
    /** 结束上下文 ID */
    to: string;
    /** 上下文 ID 列表 */
    contextIds: string[];
  };
}

/** 解析操作参数 */
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
 * 构建摘要条目直接覆盖的上下文 ID 集合。
 * 保留给只需要快速覆盖集的调用者；活动上下文组装应使用 buildActiveContextView。
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

/** 比较两个字符串数组是否相等 */
function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 验证日志操作——检查范围、权限和一致性 */
function validateLogOperation(
  op: SummarizeContextOperation,
  view: ActiveContextView,
  options: SummarizeContextExecutionOptions,
  operationCount: number,
): LogValidationResult {
  const { context_ids, summary } = op;

  if (!context_ids.length) {
    return { valid: false, error: "Empty range —from/to produced no context IDs." };
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

/** 构建摘要条目和操作结果 */
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
    "[Summarized context —summarized from earlier conversation. Text inside <user-message> tags " +
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

/** 格式化执行输出文本 */
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
      lines.push(`✓[${rangeLabel}] →Replaced with context_id ${String(result.newContextId)}.`);
    } else {
      lines.push(`✓[${rangeLabel}] →Error: ${result.error}`);
    }
  }
  return lines.join("\n");
}

/**
 * 截断投影工具参数中过长的 summarize_context 内容。
 * 完整内容保留在摘要条目中；这只是在提供商提交前缩小
 * tool_call 内的重复副本。
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
  return `${kept}... [truncated —full content preserved${ctxRef}]`;
}

/**
 * 在活动上下文上执行 summarize_context 操作。仅追加：
 * 原始条目永远不会被修改。返回新的摘要条目供调用者
 * 在 summarize_context tool_result 之后追加。
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
