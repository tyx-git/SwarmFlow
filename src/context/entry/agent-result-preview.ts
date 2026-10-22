/**
 * agent_result 条目的 TUI 预览行数上限与预览构造。
 */

/** agent_result TUI 预览的最大行数 */
export const AGENT_RESULT_TUI_PREVIEW_LINES = 8;

/** 构建 agent_result 的 TUI 预览文本 */
export function buildAgentResultTuiPreview(
  content: string,
  maxLines = AGENT_RESULT_TUI_PREVIEW_LINES,
): { text: string; truncated: boolean } {
  if (!content) {
    return { text: "", truncated: false };
  }
  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return { text: content, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

// ------------------------------------------------------------------
// ID 分配器
// ------------------------------------------------------------------

