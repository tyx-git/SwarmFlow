/**
 * `edit` 补丁载荷：把 assistant 正文里的补丁块绑定到同轮的 edit 调用，
 * 以及 drain/恢复时从日志回取补丁。
 */

import type { LogEntry } from "../context/entry/types.js";
import { extractCompletePatchBlocks } from "../patches/apply-patch/extract.js";

export interface RoundToolCall {
  id: string;
  name: string;
}

/**
 * 按出现顺序把完整的补丁块分配给 `edit` 调用。
 * 块不足时，后面的调用得不到载荷，由执行器返回明确错误。
 */
export function resolveRoundPayloads(
  calls: readonly RoundToolCall[],
  roundText: string,
): Map<string, string> {
  const blocks = extractCompletePatchBlocks(roundText);
  const editCalls = calls.filter((call) => call.name === "edit");
  const payloads = new Map<string, string>();
  const count = Math.min(editCalls.length, blocks.length);
  for (let index = 0; index < count; index++) {
    payloads.set(editCalls[index]!.id, blocks[index]!);
  }
  return payloads;
}

/**
 * ask 恢复/drain 的兜底：tool_call 没有 executionPayload 时，
 * 使用同 turn/round 的 assistant 文本重新抽块。
 */
export function resolvePayloadFromToolCallLog(
  entries: readonly LogEntry[],
  toolCallEntry: LogEntry,
): string | null {
  const sameRound = entries.filter((entry) => (
    entry.turnIndex === toolCallEntry.turnIndex
    && entry.roundIndex === toolCallEntry.roundIndex
    && entry.discarded !== true
  ));

  const text = sameRound
    .filter((entry) => entry.type === "assistant_text" && typeof entry.content === "string")
    .map((entry) => entry.content as string)
    .join("");
  const blocks = extractCompletePatchBlocks(text);
  if (blocks.length === 0) return null;

  const editCalls = sameRound.filter((entry) => {
    if (entry.type !== "tool_call") return false;
    const content = entry.content as { name?: unknown } | null;
    return content?.name === "edit";
  });
  const ordinal = editCalls.findIndex((entry) => entry.id === toolCallEntry.id);
  if (ordinal >= 0 && blocks[ordinal]) return blocks[ordinal]!;
  return blocks.length === 1 ? blocks[0]! : null;
}
