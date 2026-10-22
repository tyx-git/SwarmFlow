/** 子会话的展示辅助：token 计数、最新助手文本、prompt cache key。 */

import type { LogEntry } from "../../context/entry/types.js";

/** 子代理输出截断限制（12000 字符）。 */
export const SUB_AGENT_OUTPUT_LIMIT = 12_000;

/** 人类可读的 Token 数量格式化。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** 从子会话日志提取最新的非丢弃助手文本（或 no_reply）。 */
export function extractLatestAssistantText(entries: readonly LogEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.discarded) continue;
    if (entry.type === "assistant_text" || entry.type === "no_reply") {
      return String(entry.content ?? entry.display ?? "");
    }
  }
  return "";
}

// ------------------------------------------------------------------
// ChildSessionHandle —— 追踪嵌套子会话状态的接口
// ------------------------------------------------------------------

/** 子会话 prompt cache key：根会话亲和键 + child id。 */
export function childPromptCacheKey(rootKey: string, childId: string): string {
  return `${rootKey}__${childId}`;
}
