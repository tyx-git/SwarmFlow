/**
 * 日志 → TUI 对话条目投影。
 *
 * 实时对话和恢复使用同一份投影逻辑，保证两者展示一致。
 */

import type { LogEntry, TuiDisplayKind } from "../entry/types.js";
import { buildAgentResultTuiPreview } from "../entry/agent-result-preview.js";
import type { ConversationEntry, ConversationEntryKind } from "../../ui/contracts.js";

// ------------------------------------------------------------------
// TuiDisplayKind → ConversationEntryKind 映射
// ------------------------------------------------------------------

/** TUI 显示类型到对话条目类型的映射 */
const DISPLAY_KIND_TO_ENTRY_KIND: Record<TuiDisplayKind, ConversationEntryKind> = {
  user: "user",
  command_echo: "command_echo",
  agent_result: "agent_result",
  assistant: "assistant",
  reasoning: "reasoning",
  progress: "progress",
  tool_call: "tool_call",
  status: "status",
  error: "error",
  compact_mark: "compact_mark",
  tool_result: "tool_result",
};

// ------------------------------------------------------------------
// TUI 投影
// ------------------------------------------------------------------

/** TUI 投影选项 */
export interface TuiProjectionOptions {
  /** 覆盖压缩折叠阈值（默认：3） */
  compactFoldThreshold?: number;
}

/** 中断标记文本 */
const INTERRUPTED_MARKER_TEXT = "[Interrupted here.]";
/** 中断标记后缀 */
const INTERRUPTED_MARKER_SUFFIX = ` ${INTERRUPTED_MARKER_TEXT}`;

/** 主轮次条目类型集合（用于轮次分组） */
const PRIMARY_ROUND_ENTRY_TYPES = new Set<LogEntry["type"]>([
  "assistant_text",
  "reasoning",
  "tool_call",
  "tool_result",
]);

/** 检查条目是否可投影到 TUI */
function isProjectableTuiEntry(entry: LogEntry): boolean {
  if (entry.discarded) return false;
  if (entry.type === "input_received") return false;
  if (!entry.tuiVisible) return false;
  // 网络重试过程显示在输入框状态栏；隐藏历史日志中的旧提示，避免恢复会话后再次刷屏。
  if (
    entry.type === "status" &&
    (entry.meta["statusType"] === "retry_attempt" || entry.meta["statusType"] === "retry_success")
  ) {
    return false;
  }
  if (
    entry.type === "sub_agent_start" ||
    entry.type === "sub_agent_tool_call" ||
    entry.type === "sub_agent_end"
  ) {
    return false;
  }
  return true;
}

/** 队列输入投影——尚未投递的用户输入 */
export interface QueuedInputProjection {
  /** 输入 ID */
  id: string;
  /** 输入文本 */
  text: string;
  /** turn 索引 */
  turnIndex: number;
  /** 时间戳 */
  timestamp: number;
}

/** 投影未投递的队列输入 */
export function projectQueuedInputs(entries: LogEntry[]): QueuedInputProjection[] {
  const deliveredInputIds = new Set<string>();
  for (const entry of entries) {
    if (entry.discarded || entry.type !== "user_message") continue;
    const inputId = entry.meta["inputId"];
    if (typeof inputId === "string" && inputId.trim()) {
      deliveredInputIds.add(inputId);
    }
  }

  const queued: QueuedInputProjection[] = [];
  for (const entry of entries) {
    if (entry.discarded || entry.type !== "input_received") continue;
    const inputKind = entry.meta["inputKind"];
    if (inputKind !== "user") continue;
    const inputIdRaw = entry.meta["inputId"];
    const inputId = typeof inputIdRaw === "string" && inputIdRaw.trim()
      ? inputIdRaw
      : entry.id;
    if (deliveredInputIds.has(inputId)) continue;
    queued.push({
      id: inputId,
      text: entry.display,
      turnIndex: entry.turnIndex,
      timestamp: entry.timestamp,
    });
  }
  return queued;
}

/** 将日志条目转换为对话条目（用于 TUI 显示） */
function toConversationEntry(
  entry: LogEntry,
  toolElapsedMap?: Map<string, number>,
): ConversationEntry {
  if (entry.type === "turn_end" || entry.type === "work_end") {
    const meta = entry.meta as Record<string, unknown>;
    const status = meta.status as string;
    const elapsedMs = typeof meta.elapsedMs === "number" ? meta.elapsedMs : 0;
    const interruptHints = Array.isArray(meta.interruptHints) ? meta.interruptHints as string[] : [];
    return {
      kind: "status",
      text: "",
      id: entry.id,
      elapsedMs,
      meta: { turnEndStatus: status, interruptHints },
    };
  }

  if (entry.type === "sub_agent_end") {
    const subAgentId = entry.meta["subAgentId"];
    const subAgentName = entry.meta["subAgentName"];
    const elapsed = entry.meta["elapsed"];
    const label = [
      typeof subAgentId === "number" ? `#${subAgentId}` : "#?",
      typeof subAgentName === "string" ? subAgentName : "sub-agent",
    ].join(" ");
    const elapsedStr = typeof elapsed === "number" ? elapsed.toFixed(1) : "?";
    return {
      kind: "sub_agent_done",
      text: `[${label}] [done] (${elapsedStr}s)`,
      id: entry.id,
    };
  }

  if (entry.type === "agent_result") {
    const fullText = typeof entry.content === "string" ? entry.content : undefined;
    const meta = { ...(entry.meta as Record<string, unknown>) };
    delete meta.preview; // legacy display-only preview; display/fullText are authoritative.

    let text = entry.display;
    if (!text && fullText) {
      const preview = buildAgentResultTuiPreview(fullText);
      text = preview.text;
      if (preview.truncated) meta.tuiPreviewTruncated = true;
    }

    return {
      kind: "agent_result",
      text,
      id: entry.id,
      fullText,
      meta,
    };
  }

  const kind = entry.displayKind
    ? DISPLAY_KIND_TO_ENTRY_KIND[entry.displayKind]
    : "status";

  const ce: ConversationEntry = {
    kind,
    text: entry.display,
    id: entry.id,
  };
  if (entry.meta["tuiDim"]) ce.dim = true;
  if (entry.displayKind === "command_echo") {
    ce.meta = { commandEchoTone: entry.meta["commandEchoTone"] ?? "default" };
  }
  if (entry.type === "summary") {
    ce.meta ??= {};
    ce.meta.isSummary = true;
    ce.meta.summaryDepth = entry.meta["summaryDepth"] ?? 1;
    ce.meta.coveredContextIds = entry.meta["coveredContextIds"];
  }
  if (entry.type === "status" && entry.meta["statusType"]) {
    ce.meta ??= {};
    ce.meta.statusType = entry.meta["statusType"];
  }

  // Attach timing info and meta for tool_call entries
  if (entry.type === "tool_call") {
    ce.startedAt = entry.timestamp;
    const toolCallId = entry.meta["toolCallId"];
    if (typeof toolCallId === "string" && toolElapsedMap?.has(toolCallId)) {
      ce.elapsedMs = toolElapsedMap.get(toolCallId);
    }
    const toolName = entry.meta["toolName"];
    const content = entry.content as {
      arguments?: Record<string, unknown>;
      parseError?: string | null;
      rawArguments?: string;
    } | undefined;
    const toolArgs = content?.arguments;
    if (toolName || toolArgs || typeof toolCallId === "string") {
      ce.meta = {};
      if (typeof toolCallId === "string") ce.meta.toolCallId = toolCallId;
      if (typeof toolName === "string") ce.meta.toolName = toolName;
      if (toolArgs && typeof toolArgs === "object") ce.meta.toolArgs = toolArgs;
      const streamSections = entry.meta["toolStreamSections"];
      if (Array.isArray(streamSections)) ce.meta.toolStreamSections = streamSections;
      const streamState = entry.meta["toolStreamState"];
      if (typeof streamState === "string") ce.meta.toolStreamState = streamState;
      const execState = entry.meta["toolExecState"];
      if (typeof execState === "string") ce.meta.toolExecState = execState;
      const parseError = content?.parseError;
      if (typeof parseError === "string") ce.meta.toolParseError = parseError;
      const rawArguments = content?.rawArguments;
      if (typeof rawArguments === "string") ce.meta.rawArguments = rawArguments;
      const streamLanguage = entry.meta["toolStreamLanguage"];
      if (typeof streamLanguage === "string") ce.meta.toolStreamLanguage = streamLanguage;
      const streamMode = entry.meta["toolStreamMode"];
      if (typeof streamMode === "string") ce.meta.toolStreamMode = streamMode;
      const fmd = entry.meta["fileModifyData"];
      if (fmd && typeof fmd === "object") ce.meta.fileModifyData = fmd;
      // Forward toolMetadata so the TUI can relabel a
      // plan-file write/edit as "Update Todos" while it streams —before the
      // tool_result lands and carries the same flag. Without this the call-side
      // flag set in tool-loop is dropped here and "Write" + diff flashes first.
      const toolMetadata = entry.meta["toolMetadata"];
      if (toolMetadata && typeof toolMetadata === "object") ce.meta.toolMetadata = toolMetadata;
    }
  }

  // Forward reasoningComplete for reasoning entries (needed by TUI active entry tracker)
  if (entry.type === "reasoning") {
    const rc = entry.meta["reasoningComplete"];
    if (rc !== undefined) {
      ce.meta ??= {};
      ce.meta.reasoningComplete = rc;
    }
  }

  if (entry.type === "tool_result") {
    const resultContent = entry.content as { content?: string } | undefined;
    if (resultContent?.content) {
      ce.fullText = resultContent.content;
    }
    const toolName = entry.meta["toolName"];
    const toolMetadata = entry.meta["toolMetadata"];
    const toolCallId = entry.meta["toolCallId"];
    if (toolName || (toolMetadata && typeof toolMetadata === "object") || typeof toolCallId === "string") {
      ce.meta ??= {};
      if (typeof toolCallId === "string") ce.meta.toolCallId = toolCallId;
      if (typeof toolName === "string") ce.meta.toolName = toolName;
      if (toolMetadata && typeof toolMetadata === "object") ce.meta.toolMetadata = toolMetadata;
    }
    const isError = entry.meta["isError"];
    if (typeof isError === "boolean") {
      ce.meta ??= {};
      ce.meta.isError = isError;
    }
    // Forward fileModifyData from tool result metadata
    if (toolMetadata && typeof toolMetadata === "object") {
      const fmd = (toolMetadata as Record<string, unknown>)["fileModifyData"];
      if (fmd && typeof fmd === "object") {
        ce.meta ??= {};
        ce.meta.fileModifyData = fmd;
      }
    }
  }

  return ce;
}

/** 将日志条目转换为对话条目列表（处理中断标记分割） */
function toConversationEntries(
  entry: LogEntry,
  toolElapsedMap?: Map<string, number>,
): ConversationEntry[] {
  const ce = toConversationEntry(entry, toolElapsedMap);

  if (ce.kind !== "assistant") {
    return [ce];
  }

  if (ce.text === INTERRUPTED_MARKER_TEXT) {
    return [
      {
        kind: "interrupted_marker",
        text: INTERRUPTED_MARKER_TEXT,
        id: ce.id,
      },
    ];
  }

  if (!ce.text.endsWith(INTERRUPTED_MARKER_SUFFIX)) {
    return [ce];
  }

  const assistantText = ce.text.slice(0, -INTERRUPTED_MARKER_SUFFIX.length);
  const entries: ConversationEntry[] = [];

  if (assistantText.trim().length > 0) {
    entries.push({
      ...ce,
      text: assistantText,
    });
  }

  entries.push({
    kind: "interrupted_marker",
    text: INTERRUPTED_MARKER_TEXT,
    id: ce.id ? `${ce.id}:interrupt` : undefined,
  });

  return entries;
}

/** 检查条目是否为轮次中的主要条目（assistant_text、reasoning、tool_call、tool_result） */
function isPrimaryRoundEntry(entry: LogEntry): boolean {
  return (
    isProjectableTuiEntry(entry) &&
    entry.roundIndex !== undefined &&
    PRIMARY_ROUND_ENTRY_TYPES.has(entry.type)
  );
}

/** 构建子代理工具调用的汇总条目 */
function buildSubAgentRollup(entries: LogEntry[]): ConversationEntry | null {
  if (entries.length === 0) return null;
  const lastFive = entries.slice(-5);
  const omitted = entries.length - lastFive.length;
  const noun = lastFive.length === 1 ? "tool call" : "tool calls";
  const header = omitted > 0
    ? `${omitted} earlier ${noun} omitted, last ${lastFive.length}:`
    : `Last ${lastFive.length} sub-agent ${noun}:`;
  return {
    kind: "sub_agent_rollup",
    id: `subrollup-${entries[0].id}`,
    text: [header, ...lastFive.map((entry) => entry.display)].join("\n"),
  };
}

/**
 * 通过配对 tool_call 和 tool_result 条目构建 toolCallId → 经过时间（毫秒）映射。
 *
 * 优先使用 tool_result 元数据中的 execStartMs（实际工具执行开始时间），
 * 而非 tool_call 条目时间戳（并行调用的时间戳大致相同，
 * 是记录时间而非运行时间）。
 */
function buildToolElapsedMap(entries: readonly LogEntry[]): Map<string, number> {
  const callTimestamps = new Map<string, number>();
  const elapsed = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type === "tool_call") {
      const id = entry.meta["toolCallId"];
      if (typeof id === "string") {
        callTimestamps.set(id, entry.timestamp);
      }
    } else if (entry.type === "tool_result") {
      const id = entry.meta["toolCallId"];
      if (typeof id === "string") {
        const execStart = entry.meta["execStartMs"];
        const startMs = typeof execStart === "number"
          ? execStart
          : callTimestamps.get(id);
        if (startMs !== undefined) {
          elapsed.set(id, entry.timestamp - startMs);
        }
      }
    }
  }

  return elapsed;
}

/** 投影 TUI 窗口——将日志条目转换为对话条目列表 */
function projectTuiWindow(entries: LogEntry[], toolElapsedMap: Map<string, number>): ConversationEntry[] {
  const result: ConversationEntry[] = [];
  const pendingSubAgentCalls: LogEntry[] = [];

  const flushPendingSubAgentCalls = (): void => {
    const rollup = buildSubAgentRollup(pendingSubAgentCalls);
    pendingSubAgentCalls.length = 0;
    if (rollup) result.push(rollup);
  };

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];

    if (!isProjectableTuiEntry(entry)) {
      i++;
      continue;
    }

    if (entry.type === "sub_agent_tool_call") {
      pendingSubAgentCalls.push(entry);
      i++;
      continue;
    }

    if (isPrimaryRoundEntry(entry)) {
      if (pendingSubAgentCalls.length > 0) {
        flushPendingSubAgentCalls();
      }

      const turnIndex = entry.turnIndex;
      const roundIndex = entry.roundIndex;

      // 先收集此轮次的所有条目，然后重新排序使每个
      // tool_result 出现在其对应的 tool_call 之后。
      const roundEntries: LogEntry[] = [];

      while (i < entries.length) {
        const candidate = entries[i];

        if (!isProjectableTuiEntry(candidate)) {
          i++;
          continue;
        }

        if (candidate.type === "sub_agent_tool_call") {
          pendingSubAgentCalls.push(candidate);
          i++;
          continue;
        }

        if (
          candidate.turnIndex === turnIndex &&
          candidate.roundIndex === roundIndex &&
          PRIMARY_ROUND_ENTRY_TYPES.has(candidate.type)
        ) {
          roundEntries.push(candidate);
          i++;
          continue;
        }

        break;
      }

      // 将 tool_call 条目与其匹配的 tool_result 条目配对。
      // 非工具条目（assistant_text、reasoning）按原始顺序排在前面，
      // 然后每个 tool_call 紧接着其 tool_result（如果可见）。
      const nonToolEntries: LogEntry[] = [];
      const toolCalls: LogEntry[] = [];
      const toolResultByCallId = new Map<string, LogEntry>();

      for (const re of roundEntries) {
        if (re.type === "tool_call") {
          toolCalls.push(re);
        } else if (re.type === "tool_result") {
          const callId = re.meta["toolCallId"];
          if (typeof callId === "string") {
            toolResultByCallId.set(callId, re);
          } else {
            // Orphan result —append after all paired entries
            nonToolEntries.push(re);
          }
        } else {
          nonToolEntries.push(re);
        }
      }

      for (const ne of nonToolEntries) {
        result.push(...toConversationEntries(ne, toolElapsedMap));
      }
      for (const tc of toolCalls) {
        result.push(...toConversationEntries(tc, toolElapsedMap));
        const callId = tc.meta["toolCallId"];
        if (typeof callId === "string") {
          const tr = toolResultByCallId.get(callId);
          if (tr) {
            result.push(...toConversationEntries(tr, toolElapsedMap));
            toolResultByCallId.delete(callId);
          }
        }
      }
      // Flush any unmatched tool_results (shouldn't happen, but be safe)
      for (const tr of toolResultByCallId.values()) {
        result.push(...toConversationEntries(tr, toolElapsedMap));
      }

      if (pendingSubAgentCalls.length > 0) {
        flushPendingSubAgentCalls();
      }
      continue;
    }

    if (pendingSubAgentCalls.length > 0) {
      flushPendingSubAgentCalls();
    }

    result.push(...toConversationEntries(entry, toolElapsedMap));
    i++;
  }

  if (pendingSubAgentCalls.length > 0) {
    flushPendingSubAgentCalls();
  }

  return result;
}

/**
 * 将日志条目投影为 ConversationEntry[] 用于 TUI 渲染。
 *
 * 规则：
 *  1. 根据压缩标记确定折叠边界
 *  2. 跳过：折叠条目、tuiVisible===false、已丢弃、摘要条目
 *  3. 映射 (displayKind, display) → ConversationEntry
 */
export function projectToTuiEntries(
  entries: readonly LogEntry[],
  options?: TuiProjectionOptions,
): ConversationEntry[] {
  const threshold = options?.compactFoldThreshold ?? 3;
  // TUI 显示完整的仅追加历史，包括被后续摘要覆盖的条目。
  // 只有 API 投影隐藏它们。这使用户能够回滚并验证摘要捕获的内容
  // （并允许选择器列出磁盘上仍然存在的分组）。

  // 查找所有 compact_marker 索引
  const compactMarkerIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      compactMarkerIndices.push(i);
    }
  }

  // 整个日志上的一个配对映射，两个窗口共享。窗口本地映射对于任一窗口
  // 渲染的任何内容都会相同配对：结果总是跟随其调用，因此窗口永远不会
  // 渲染其结果位于更早窗口中的调用，未渲染条目的额外配对 simply 未使用。
  const toolElapsedMap = buildToolElapsedMap(entries);

  // 确定折叠边界：如果 N >= 阈值，折叠第 (N - 阈值 + 1) 个标记之前的条目
  let foldEndIdx = -1; // entries at index <= foldEndIdx are folded
  let foldedCount = 0;
  let foldedCompactCount = 0;
  if (compactMarkerIndices.length >= threshold) {
    const foldUpToMarker = compactMarkerIndices[compactMarkerIndices.length - threshold];
    foldEndIdx = foldUpToMarker;
    foldedCount = projectTuiWindow(entries.slice(0, foldEndIdx + 1), toolElapsedMap).length;
    foldedCompactCount = compactMarkerIndices.length - threshold + 1;
  }

  const result: ConversationEntry[] = [];

  // 如果需要，添加折叠占位符
  if (foldEndIdx >= 0 && foldedCount > 0) {
    result.push({
      kind: "status",
      text: `\u25b8 ${foldedCount} earlier entries (${foldedCompactCount} compacts)`,
    });
  }

  result.push(...projectTuiWindow(entries.slice(foldEndIdx + 1), toolElapsedMap));

  return result;
}

