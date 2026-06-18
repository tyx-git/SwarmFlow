import type { LogEntry } from "./context/log-entry.js";
import {
  LogIdAllocator,
  createAssistantText,
  createNoReply,
  createReasoning,
  createSystemPrompt,
  createToolCall,
  createToolResult,
  createUserMessage,
} from "./context/log-entry.js";
import { allocateContextId, stripContextTags } from "./context/context-rendering.js";
import { projectToApiMessages, type InternalMessage } from "./context/log-projection.js";

export interface EphemeralLogState {
  entries: LogEntry[];
  getMessages: () => InternalMessage[];
  appendEntry: (entry: LogEntry) => void;
  allocId: (type: LogEntry["type"]) => string;
  allocateContextId: () => string;
  computeNextRoundIndex: () => number;
}

export function createEphemeralLogState(
  initialMessages: InternalMessage[],
  opts?: {
    requiresAlternatingRoles?: boolean;
    turnIndex?: number;
    /** Use an external entries array (for persistent sub-agents). */
    externalEntries?: LogEntry[];
    /** Use an external ID allocator (for persistent sub-agents). */
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

  // If external entries were provided and already have content, skip import
  // (re-activation path for persistent sub-agents).
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
    // Skip the import loop below 鈥?go straight to the return
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

function resolveAssistantText(message: InternalMessage): string {
  if (typeof message["text"] === "string") return message["text"];
  return normalizeTextContent(message["content"]);
}

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

function summarizeContentForDisplay(content: unknown): string {
  if (typeof content === "string") return stripContextTags(content);
  if (Array.isArray(content)) {
    const text = normalizeTextContent(content).trim();
    return text || "[multimodal message]";
  }
  return String(content ?? "");
}

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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}
