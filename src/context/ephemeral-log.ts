import type { LogEntry } from "../context/log-entry.js";
import {
  LogIdAllocator,
  createAssistantText,
  createNoReply,
  createReasoning,
  createSystemPrompt,
  createToolCall,
  createToolResult,
  createUserMessage,
} from "../context/log-entry.js";
import { allocateContextId, stripContextTags } from "../context/context-rendering.js";
import { projectToApiMessages, type InternalMessage } from "../context/log-projection.js";

/** 临时日志状态——管理内存中的日志条目和消息投影 */
export interface EphemeralLogState {
  /** 日志条目列表 */
  entries: LogEntry[];
  /** 获取投影后的 API 消息列表 */
  getMessages: () => InternalMessage[];
  /** 追加日志条目 */
  appendEntry: (entry: LogEntry) => void;
  /** 分配新的条目 ID */
  allocId: (type: LogEntry["type"]) => string;
  /** 分配新的上下文 ID */
  allocateContextId: () => string;
  /** 计算下一个轮次索引 */
  computeNextRoundIndex: () => number;
}

/** 创建临时日志状态——从初始消息导入并管理内存中的日志 */
export function createEphemeralLogState(
  initialMessages: InternalMessage[],
  opts?: {
    /** 是否需要严格交替角色。默认 false */
    requiresAlternatingRoles?: boolean;
    /** 当前 turnIndex */
    turnIndex?: number;
    /** 使用外部条目数组（用于持久子代理） */
    externalEntries?: LogEntry[];
    /** 使用外部 ID 分配器（用于持久子代理） */
    externalIdAllocator?: LogIdAllocator;
  },
): EphemeralLogState {
  const entries: LogEntry[] = opts?.externalEntries ?? [];
  const idAllocator = opts?.externalIdAllocator ?? new LogIdAllocator();
  const usedContextIds = new Set<string>();
  const turnIndex = opts?.turnIndex ?? 0;

  let nextRoundIndex = 0;
  let lastAssistantRoundIndex = 0;
  let sawSystemPrompt = false;

  const allocContextId = (): string => allocateContextId(usedContextIds);
  const trackContextId = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const normalized = String(value);
    if (normalized) usedContextIds.add(normalized);
    return normalized || undefined;
  };

  const appendImportedEntry = (entry: LogEntry): void => {
    const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
    if (ctxId !== undefined && ctxId !== null) {
      usedContextIds.add(String(ctxId));
    }
    entries.push(entry);
  };

  // 如果提供了外部条目且已有内容，跳过导入
  // （持久子代理的重新激活路径）。
  if (opts?.externalEntries && opts.externalEntries.length > 0) {
    // Rebuild usedContextIds from existing entries
    for (const entry of entries) {
      const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
      if (ctxId !== undefined && ctxId !== null) usedContextIds.add(String(ctxId));
      if (entry.roundIndex !== undefined) {
        nextRoundIndex = Math.max(nextRoundIndex, entry.roundIndex + 1);
        lastAssistantRoundIndex = Math.max(lastAssistantRoundIndex, entry.roundIndex);
      }
    }
    // 跳过下面的导入循环——直接返回
  } else {

  for (const msg of initialMessages) {
    const role = String(msg["role"] ?? "");
    if (role === "system") {
      const content = normalizeTextContent(msg["content"]);
      if (!sawSystemPrompt) {
        appendImportedEntry(createSystemPrompt(idAllocator.next("system_prompt"), content));
        sawSystemPrompt = true;
      } else {
        appendImportedEntry(createUserMessage(
          idAllocator.next("user_message"),
          turnIndex,
          summarizeContentForDisplay(content),
          content,
          trackContextId(msg["_context_id"]) ?? allocContextId(),
        ));
      }
      continue;
    }

    if (role === "user") {
      const content = cloneContent(msg["content"]);
      appendImportedEntry(createUserMessage(
        idAllocator.next("user_message"),
        turnIndex,
        summarizeContentForDisplay(content),
        content,
        trackContextId(msg["_context_id"]) ?? allocContextId(),
      ));
      continue;
    }

    if (role === "assistant") {
      const roundIndex = nextRoundIndex++;
      lastAssistantRoundIndex = roundIndex;
      const contextId = trackContextId(msg["_context_id"]);
      const reasoningContent = msg["reasoning_content"];
      if (reasoningContent !== undefined && reasoningContent !== null) {
        const normalizedReasoning = normalizeTextContent(reasoningContent);
        appendImportedEntry(createReasoning(
          idAllocator.next("reasoning"),
          turnIndex,
          roundIndex,
          normalizedReasoning,
          normalizedReasoning,
          msg["_reasoning_state"],
          contextId,
        ));
      }

      const toolCalls = Array.isArray(msg["tool_calls"])
        ? msg["tool_calls"] as Array<Record<string, unknown>>
        : [];
      const assistantText = resolveAssistantText(msg);

      if (toolCalls.length > 0) {
        if (assistantText) {
          appendImportedEntry(createAssistantText(
            idAllocator.next("assistant_text"),
            turnIndex,
            roundIndex,
            stripContextTags(assistantText),
            assistantText,
            contextId,
          ));
        }
        for (const tc of toolCalls) {
          const toolCallId = String(tc["id"] ?? "");
          const toolName = String(tc["name"] ?? "");
          appendImportedEntry(createToolCall(
            idAllocator.next("tool_call"),
            turnIndex,
            roundIndex,
            toolName,
            {
              id: toolCallId,
              name: toolName,
              arguments: asRecord(tc["arguments"]),
              rawArguments: JSON.stringify(asRecord(tc["arguments"])),
              parseError: null,
            },
            {
              toolCallId,
              toolName,
              agentName: "",
              contextId,
            },
          ));
        }
        continue;
      }

      if (assistantText) {
        if (assistantText.trim() === "<NO_REPLY>") {
          appendImportedEntry(createNoReply(
            idAllocator.next("no_reply"),
            turnIndex,
            roundIndex,
            assistantText,
            contextId,
          ));
        } else {
          appendImportedEntry(createAssistantText(
            idAllocator.next("assistant_text"),
            turnIndex,
            roundIndex,
            stripContextTags(assistantText),
            assistantText,
            contextId,
          ));
        }
      }
      continue;
    }

    if (role === "tool_result") {
      const content = normalizeTextContent(msg["content"]);
      appendImportedEntry(createToolResult(
        idAllocator.next("tool_result"),
        turnIndex,
        lastAssistantRoundIndex,
        {
          toolCallId: String(msg["tool_call_id"] ?? ""),
          toolName: String(msg["tool_name"] ?? ""),
          content,
          toolSummary: String(msg["tool_summary"] ?? msg["tool_name"] ?? ""),
        },
        {
          isError: content.startsWith("ERROR:"),
          contextId: trackContextId(msg["_context_id"]),
        },
      ));
    }
  }
  } // end of else (import phase)

  return {
    entries,
    getMessages: () => projectToApiMessages(entries, {
      requiresAlternatingRoles: opts?.requiresAlternatingRoles,
    }),
    appendEntry: (entry: LogEntry) => {
      const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
      if (ctxId !== undefined && ctxId !== null) {
        usedContextIds.add(String(ctxId));
      }
      entries.push(entry);
    },
    allocId: (type: LogEntry["type"]) => idAllocator.next(type),
    allocateContextId: allocContextId,
    computeNextRoundIndex: () => {
      let maxRound = -1;
      for (const entry of entries) {
        if (entry.roundIndex !== undefined) {
          maxRound = Math.max(maxRound, entry.roundIndex);
        }
      }
      return maxRound + 1;
    },
  };
}

/** 从消息中解析 assistant 文本内容 */
function resolveAssistantText(message: InternalMessage): string {
  if (typeof message["text"] === "string") return message["text"];
  return normalizeTextContent(message["content"]);
}

/** 将内容标准化为纯文本字符串 */
function normalizeTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block && typeof block === "object")
      .map((block) => {
        const record = block as Record<string, unknown>;
        return record["type"] === "text" ? String(record["text"] ?? "") : "";
      })
      .filter(Boolean)
      .join("\n");
    return text || JSON.stringify(content);
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

/** 生成用于显示的内容摘要（剥离上下文标签） */
function summarizeContentForDisplay(content: unknown): string {
  if (typeof content === "string") return stripContextTags(content);
  if (Array.isArray(content)) {
    const text = normalizeTextContent(content).trim();
    return text || "[multimodal message]";
  }
  return String(content ?? "");
}

/** 深拷贝内容（浅拷贝对象块） */
function cloneContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.map((block) =>
      block && typeof block === "object"
        ? { ...(block as Record<string, unknown>) }
        : block,
    );
  }
  return content;
}

/** 将值安全转换为 Record 类型 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}
