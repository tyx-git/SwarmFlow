/**
 * 日志 → 提供商 API 消息投影。
 *
 * 实时对话和恢复使用同一份投影逻辑，保证发给模型的消息序列一致。
 */

import type { LogEntry } from "../entry/types.js";

import { mergeConsecutiveSameRole } from "../message-merging.js";
import { buildActiveContextView, flattenActiveContextEntries } from "../active-context.js";
import { inferThinkingArtifact, normalizeThinkingArtifact } from "../../thinking/artifact.js";

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
  /** 在提交前强制执行提供商工具调用排序不变量 */
  enforceToolCallProtocol?: boolean;
  /**
   * 本轮动态上下文（hooks、提醒等）。
   *
   * 在历史消息完成角色归一化之后追加为最后一条 user 消息，并标记
   * `_ephemeral_tail`。它不写入日志；provider 在放置缓存断点时必须跳过它。
   */
  ephemeralTail?: string;
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

  let projected = messages;

  if (options?.enforceToolCallProtocol) {
    validateToolCallProtocol(projected);
  }

  if (options?.requiresAlternatingRoles) {
    projected = mergeConsecutiveSameRole(projected);
  }

  // 动态尾巴必须在归一化之后追加：若先追加，严格交替的 provider 会把
  // 它合并进最后一条历史 user 消息，下一轮就再也摘不掉了。
  const ephemeralTail = options?.ephemeralTail?.trim();
  if (ephemeralTail) {
    projected.push({
      role: "user",
      content: ephemeralTail,
      _ephemeral_tail: true,
    });
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
