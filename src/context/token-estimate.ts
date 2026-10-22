/** Token estimation helpers used by usage accounting. */

import { encode as gptEncode } from "gpt-tokenizer/model/gpt-5";
import type { LogEntry } from "./entry/types.js";

/** Estimate the token count of one persisted log entry. */
export function estimateEntryTokens(entry: LogEntry): number {
  let text: string;
  switch (entry.type) {
    case "user_message":
    case "assistant_text":
    case "no_reply":
    case "compact_context":
    case "summary":
    case "reasoning":
      text = serializeContent(entry.content);
      break;
    case "tool_call":
      text = JSON.stringify(entry.content ?? {});
      break;
    case "tool_result": {
      const result = entry.content as { content?: string } | null;
      text = result?.content ?? JSON.stringify(entry.content ?? {});
      break;
    }
    default:
      text = serializeContent(entry.content);
      break;
  }
  return gptEncode(text).length;
}

function serializeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => {
        if (block?.type === "text") return String(block.text ?? "");
        if (block?.type === "image" || block?.type === "image_ref") return "[image]";
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}
