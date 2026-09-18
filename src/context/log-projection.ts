/**
 * 日志投影函数——从日志派生 TUI 条目和 API 消息。
 *
 * 实时对话和恢复使用相同的投影逻辑，保证 100% 一致性。
 */

import type { LogEntry, TuiDisplayKind } from "../context/log-entry.js";
import { buildAgentResultTuiPreview } from "../context/log-entry.js";
import type { ConversationEntry, ConversationEntryKind } from "../ui/contracts.js";
import { mergeConsecutiveSameRole } from "../context/context-rendering.js";
import { truncateSummarizeContextContent } from "../context/summarize-context.js";
import { buildActiveContextView, flattenActiveContextEntries } from "../context/active-context.js";
import { inferThinkingArtifact, normalizeThinkingArtifact } from "../lib/thinking-artifact.js";

// ------------------------------------------------------------------
// TuiDisplayKind → ConversationEntryKind 映射
// ------------------------------------------------------------------

/** TUI 显示类型到对话条目类型的映射 */
const DISPLAY_KIND_TO_ENTRY_KIND: Record<TuiDisplayKind, ConversationEntryKind> = {
  user: "user",
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
      // Forward toolMetadata (e.g. planFileOperation) so the TUI can relabel a
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

// ------------------------------------------------------------------
// API 投影
// ------------------------------------------------------------------

/**
 * Internal message format consumed by provider adapters.
 * This is the output of the API projection layer.
 */
export type InternalMessage = Record<string, unknown>;

/** API 投影选项 */
export interface ApiProjectionOptions {
  /**
   * Session 提供的当前系统提示词，通常来自其提示缓存。
   * 如果未提供，则使用 system_prompt 日志条目的内容作为回退。
   */
  systemPrompt?: string;
  /** 旧版重要日志注入支持。运行时不再使用。 */
  importantLog?: string;
  /**
   * 将 image_ref 路径解析为 base64 数据供 API 使用。
   * 如果未提供，image_ref 块按原样传递。
   */
  resolveImageRef?: (refPath: string) => { data: string; media_type: string } | null;
  /** 为需要交替的提供商合并连续同角色消息 */
  requiresAlternatingRoles?: boolean;
  /** 在提供商提交前截断 summarize_context 工具调用内容 */
  truncateSummarizeContextToolArgs?: boolean;
  /** 在提交前强制执行提供商工具调用排序不变量 */
  enforceToolCallProtocol?: boolean;
}

/** 用户消息头部文本 */
const USER_MESSAGE_HEADER = "[User Message]";

/**
 * 将日志条目投影为 InternalMessage[] 供提供商使用。
 *
 * 算法：
 *  1. 重新渲染系统提示词（或使用日志的）
 *  2. 查找最后一个 compact_marker → API 窗口起始
 *  3. 如果存在则插入 compact_context
 *  4. 遍历条目，跳过：apiRole===null、被摘要覆盖、已丢弃、已归档且内容为 null
 *  5. 按 roundIndex 分组构建 assistant 消息
 */
export function projectToApiMessages(
  entries: LogEntry[],
  options?: ApiProjectionOptions,
): InternalMessage[] {
  // Step 1: Find system prompt
  let systemPromptContent: unknown = "";
  for (const e of entries) {
    if (e.type === "system_prompt" && !e.discarded) {
      systemPromptContent = options?.systemPrompt ?? e.content;
      break;
    }
  }

  // Build messages
  const messages: InternalMessage[] = [];

  // System prompt
  if (systemPromptContent) {
    messages.push({ role: "system", content: systemPromptContent });
  }

  // Step 2-5: assemble active context, then collect API-visible entries.
  const activeView = buildActiveContextView(entries, {
    includeCompactContext: true,
    includeEntriesWithoutContext: true,
  });
  const windowEntries = flattenActiveContextEntries(activeView).filter((e) => {
    if (e.discarded) return false;
    if (e.archived && e.content === null) return false;
    if (e.type === "system_prompt") return false; // already handled
    // reasoning has apiRole=null but is grouped with assistant entries
    if (e.type === "reasoning") return true;
    if (e.apiRole === null) return false;
    return true;
  });

  // Group entries by (turnIndex, roundIndex) into well-formed rounds:
  //   1. One assistant message (reasoning + assistant_text + tool_call entries)
  //   2. All corresponding tool_result messages (ordered by tool_call order)
  //
  // In the log, tool_call and tool_result entries may be interleaved within
  // the same round because tool execution starts immediately during streaming.
  // This loop collects ALL entries of the same round before emitting them.

  const emitToolResult = (entry: LogEntry): void => {
    const resultContent = entry.content as {
      toolCallId: string;
      toolName: string;
      content: string;
      toolSummary: string;
    };
    const trContent = resultContent.content;
    const trCtxId = (entry.meta as Record<string, unknown>)["contextId"];
    const toolMeta = (entry.meta as Record<string, unknown>)["toolMetadata"] as Record<string, unknown> | undefined;
    const contentBlocks = toolMeta?.["_contentBlocks"] as Array<Record<string, unknown>> | undefined;

    const trMsg: InternalMessage = {
      role: "tool_result",
      tool_call_id: entry.meta.toolCallId,
      tool_name: entry.meta.toolName,
      content: contentBlocks ?? trContent,
      tool_summary: resultContent.toolSummary,
    };
    if (trCtxId !== undefined) trMsg["_context_id"] = trCtxId;
    messages.push(trMsg);
  };

  let i = 0;
  while (i < windowEntries.length) {
    const entry = windowEntries[i];

    if (
      (entry.apiRole === "assistant" || entry.type === "reasoning") &&
      entry.roundIndex !== undefined
    ) {
      // 收集此轮次的所有条目，无论角色交错如何。
      const roundIdx = entry.roundIndex;
      const turnIdx = entry.turnIndex;
      const assistantEntries: LogEntry[] = [];
      const toolResultEntries: LogEntry[] = [];
      const deferredUserEntries: LogEntry[] = [];

      while (i < windowEntries.length) {
        const candidate = windowEntries[i];
        if (candidate.turnIndex !== turnIdx) break;
        if (candidate.roundIndex !== roundIdx) {
          if (candidate.type === "agent_result" && candidate.apiRole === "user") {
            deferredUserEntries.push(candidate);
            i++;
            continue;
          }
          break;
        }
        if (candidate.apiRole === "assistant" || candidate.type === "reasoning") {
          assistantEntries.push(candidate);
        } else if (candidate.apiRole === "tool_result") {
          toolResultEntries.push(candidate);
        }
        // 跳过此轮次内的任何其他条目类型（例如 token_update
        // 条目已被过滤，但保持防御性）
        i++;
      }

      messages.push(buildAssistantMessage(assistantEntries, entries));

      // 重新排序 tool_results 以匹配 tool_call 声明顺序。
      const toolCallOrder = new Map<string, number>();
      let orderIdx = 0;
      for (const ae of assistantEntries) {
        if (ae.type === "tool_call") {
          const tcId = ae.meta["toolCallId"];
          if (typeof tcId === "string") toolCallOrder.set(tcId, orderIdx++);
        }
      }
      if (toolCallOrder.size > 0 && toolResultEntries.length > 1) {
        toolResultEntries.sort((a, b) => {
          const aOrder = toolCallOrder.get(a.meta["toolCallId"] as string) ?? Infinity;
          const bOrder = toolCallOrder.get(b.meta["toolCallId"] as string) ?? Infinity;
          return aOrder - bOrder;
        });
      }

      for (const trEntry of toolResultEntries) {
        emitToolResult(trEntry);
      }
      for (const userEntry of deferredUserEntries) {
        const content = resolveImageRefs(userEntry.content, options?.resolveImageRef);
        const ctxId = (userEntry.meta as Record<string, unknown>)["contextId"];
        const userMsg: InternalMessage = { role: "user", content };
        if (ctxId !== undefined) userMsg["_context_id"] = ctxId;
        messages.push(userMsg);
      }
    } else if (entry.apiRole === "user") {
      const content = resolveImageRefs(entry.content, options?.resolveImageRef);
      const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
      const userMsg: InternalMessage = { role: "user", content };
      if (ctxId !== undefined) userMsg["_context_id"] = ctxId;
      if (entry.type === "summary") {
        userMsg["_is_summary"] = true;
        userMsg["_summary_depth"] = (entry.meta as Record<string, unknown>)["summaryDepth"] ?? 1;
        userMsg["_covered_context_ids"] = (entry.meta as Record<string, unknown>)["coveredContextIds"] ?? [];
      }
      messages.push(userMsg);
      i++;
    } else if (entry.apiRole === "tool_result") {
      // 独立的 tool_result，不属于轮次组（例如中断后孤立）。
      // 按原样发出。
      emitToolResult(entry);
      i++;
    } else {
      messages.push({ role: entry.apiRole, content: entry.content });
      i++;
    }
  }

  const importantLog = options?.importantLog?.trim();
  if (importantLog) {
    injectLabeledUserContext(
      messages,
      "[IMPORTANT LOG]\nThe following is your persistent engineering notebook:\n\n",
      importantLog,
    );
  }

  let projected = options?.truncateSummarizeContextToolArgs === false
    ? messages
    : truncateSummarizeContextToolArgs(messages);

  if (options?.enforceToolCallProtocol) {
    validateToolCallProtocol(projected);
  }

  if (options?.requiresAlternatingRoles) {
    projected = mergeConsecutiveSameRole(projected);
  }

  return projected;
}

/** 验证工具调用协议——确保每个 tool_call 都有匹配的 tool_result */
function validateToolCallProtocol(messages: InternalMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const toolCalls = Array.isArray(msg["tool_calls"])
      ? msg["tool_calls"] as Array<Record<string, unknown>>
      : [];
    if (msg.role !== "assistant" || toolCalls.length === 0) continue;

    const expected = new Set(toolCalls.map((tc) => String(tc["id"] ?? "")));
    const missing = new Set(expected);
    let cursor = i + 1;
    while (cursor < messages.length && messages[cursor].role === "tool_result") {
      const toolCallId = String(messages[cursor]["tool_call_id"] ?? "");
      if (missing.has(toolCallId)) {
        missing.delete(toolCallId);
      }
      cursor++;
    }
    if (missing.size > 0) {
      throw new Error(
        "Invalid API projection: assistant tool_calls must be followed by matching tool_result messages. " +
        `Missing tool_call_id(s): ${[...missing].join(", ")}.`,
      );
    }
  }
}

// ------------------------------------------------------------------
// 图像引用解析
// ------------------------------------------------------------------

/**
 * 将内容中的 image_ref 块解析为内联 base64 供 API 使用。
 * 如果内容是字符串或未提供解析器，则按原样返回。
 */
function resolveImageRefs(
  content: unknown,
  resolver?: (refPath: string) => { data: string; media_type: string } | null,
): unknown {
  if (!resolver || !Array.isArray(content)) return content;
  let hasRef = false;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>)["type"] === "image_ref"
    ) {
      hasRef = true;
      break;
    }
  }
  if (!hasRef) return content;

  return (content as Array<Record<string, unknown>>).map((block) => {
    if (block["type"] !== "image_ref") return block;
    const resolved = resolver(block["path"] as string);
    if (!resolved) return block; // fallback: pass through
    return {
      type: "image",
      data: resolved.data,
      media_type: resolved.media_type,
    };
  });
}

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

/**
 * 从分组的轮次条目构建单条 assistant API 消息。
 */
function buildAssistantMessage(
  roundEntries: LogEntry[],
  _allEntries: LogEntry[],
): InternalMessage {
  const msg: InternalMessage = { role: "assistant" };

  // 提取推理/思维链
  const reasoning = roundEntries.find((e) => e.type === "reasoning");
  if (reasoning) {
    const artifact = normalizeThinkingArtifact(
      (reasoning.meta as Record<string, unknown>)["thinkingArtifact"],
    ) ?? inferThinkingArtifact(
      reasoning.content,
      (reasoning.meta as Record<string, unknown>)["reasoningState"],
    );
    if (artifact) {
      msg.reasoning_content = artifact.plainReplayText;
      msg._thinking_artifact = artifact;
      if (artifact.encryption !== "none") {
        msg._reasoning_state = artifact.sealedPayload;
      } else {
        const reasoningState = (reasoning.meta as Record<string, unknown>)["reasoningState"];
        if (reasoningState !== undefined) {
          msg._reasoning_state = reasoningState;
        }
      }
    } else {
      msg.reasoning_content = reasoning.content;
      const reasoningState = (reasoning.meta as Record<string, unknown>)["reasoningState"];
      if (reasoningState !== undefined) {
        msg._reasoning_state = reasoningState;
      }
    }
  }

  // 提取 assistant 文本
  const text = roundEntries.find((e) => e.type === "assistant_text");

  // 提取工具调用
  const toolCalls = roundEntries
    .filter((e) => e.type === "tool_call")
    .map((e) => {
      const tc = e.content as {
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      } | null;
      return {
        id: String(tc?.id ?? ""),
        name: String(tc?.name ?? ""),
        arguments: tc?.arguments ?? {},
      };
    });

  // 提取无回复标记
  const noReply = roundEntries.find((e) => e.type === "no_reply");

  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
    if (text) {
      msg.text = text.content;
    }
  } else if (noReply) {
    msg.content = noReply.content;
  } else if (text) {
    msg.content = text.content;
  }

  // 保留第一个具有 _context_id 的条目的值
  for (const e of roundEntries) {
    const ctxId = (e.meta as Record<string, unknown>)["contextId"];
    if (ctxId !== undefined) {
      msg["_context_id"] = ctxId;
      break;
    }
  }

  return msg;
}

/** 将带标签的用户上下文注入到消息列表中 */
function injectLabeledUserContext(
  messages: InternalMessage[],
  header: string,
  content: string,
): void {
  const fullContent = header + content;

  // 查找系统提示词之后的位置
  let insertIdx = 0;
  while (insertIdx < messages.length && messages[insertIdx].role === "system") {
    insertIdx++;
  }

  if (insertIdx < messages.length && messages[insertIdx].role === "user") {
    // 合并到第一条用户消息
    const first = messages[insertIdx];
    messages[insertIdx] = {
      ...first,
      content: mergeMessageContent(fullContent, first.content, { ensureUserBoundary: true }),
    };
  } else {
    // 插入独立的用户消息
    messages.splice(insertIdx, 0, { role: "user", content: fullContent });
  }
}

/** 截断 summarize_context 工具调用参数 */
function truncateSummarizeContextToolArgs(
  messages: InternalMessage[],
): InternalMessage[] {
  return messages.map((msg) => {
    const toolCalls = msg["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (!toolCalls?.length) return msg;

    let modified = false;
    const nextToolCalls = toolCalls.map((tc) => {
      if ((tc["name"] as string) !== "summarize_context") return tc;

      const args = tc["arguments"] as Record<string, unknown> | undefined;
      const operations = args?.["operations"] as Array<Record<string, unknown>> | undefined;
      if (!args || !operations?.length) return tc;

      let opsModified = false;
      const nextOperations = operations.map((op) => {
        const content = op["content"] as string | undefined;
        const resultCtxId = op["_result_context_id"] as string | number | undefined;
        if (!content || content.length <= 100) {
          if (resultCtxId === undefined) return op;
          opsModified = true;
          const { _result_context_id: _removed, ...rest } = op;
          return rest;
        }

        opsModified = true;
        const { _result_context_id: _removed, ...rest } = op;
        return {
          ...rest,
          content: truncateSummarizeContextContent(content, resultCtxId),
        };
      });

      if (!opsModified) return tc;
      modified = true;
      return {
        ...tc,
        arguments: {
          ...args,
          operations: nextOperations,
        },
      };
    });

    if (!modified) return msg;
    return { ...msg, tool_calls: nextToolCalls };
  });
}

/** 合并消息内容（处理字符串和数组格式） */
function mergeMessageContent(
  prefix: string,
  existing: unknown,
  opts?: { ensureUserBoundary?: boolean },
): string | Array<Record<string, unknown>> {
  const appendBoundary = (text: string): string => {
    if (opts?.ensureUserBoundary !== true) return text;
    const startsWithBoundary = text.startsWith(`${USER_MESSAGE_HEADER}\n`);
    return startsWithBoundary ? text : `${USER_MESSAGE_HEADER}\n${text}`;
  };

  if (typeof existing === "string") {
    return `${prefix}\n\n${appendBoundary(existing)}`;
  }
  if (Array.isArray(existing)) {
    const blocks: Array<Record<string, unknown>> = [{ type: "text", text: prefix }];
    if (opts?.ensureUserBoundary === true) {
      blocks.push({ type: "text", text: `${USER_MESSAGE_HEADER}\n` });
    }
    return [
      ...blocks,
      ...existing as Array<Record<string, unknown>>,
    ];
  }
  return `${prefix}\n\n${appendBoundary(String(existing ?? ""))}`;
}
