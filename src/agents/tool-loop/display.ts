/**
 * Agent 共享的 tool loop 逻辑。
 *
 * 提供异步 LLM <-> tool 往返循环。调用 provider，执行 tool call，
 * 通过回调追加结果，重复直到模型不再调用工具或达到最大轮数。
 *
 * v2 设计：通过回调（getMessages / appendEntry）而非直接修改 provider 消息。
 * 后端存储可以是结构化会话日志（主 Agent）或临时结构化日志（子 Agent / 无状态运行）。
 *
 * 核心概念：
 * - PendingToolCallState：跟踪每个进行中的 tool call（参数流式传输、
 *   执行状态、TUI 可见性、edit-file 上下文探测）
 * - 顺序排出：已提交的 tool call 按发射顺序执行；挂起的 ask 暂停排出，
 *   以保证审批语义正确
 * - Compact：可在任意 provider 调用后触发中途压缩，返回 compactNeeded=true
 */

/**
 * 为工具调用生成人类可读的简短摘要。
 * 优先使用 ToolDef.summaryTemplate，不可用时回退为默认格式。
 * 模板支持 {agent}、{path}、{file}、{pattern}、{url}、{command} 占位符。
 */
export function generateToolSummary(
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summaryTemplate: string,
): string {
  if (summaryTemplate) {
    try {
      // 替换 {agent} 和所有 {argKey} 占位符
      let result = summaryTemplate.replace(/\{agent\}/g, agentName);
      for (const [key, value] of Object.entries(toolArgs)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
      }
      // 若仍有未替换的占位符，回退到默认格式
      if (!/\{[^}]+\}/.test(result)) {
        return result;
      }
    } catch {
      // fall through
    }
  }
  return `${agentName} 正在调用 ${toolName}`;
}

/** 将工具参数值压缩为简短显示字符串。 */
function compactDisplayValue(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return '""';
    return normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (value && typeof value === "object") {
    return "{...}";
  }
  return "";
}

/**
 * 为工具调用生成 TUI 显示行。
 * 根据工具名和参数生成简短可读字符串，如 "edit_file src/cli.ts"。
 */
export function generateToolCallDisplay(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  const path = compactDisplayValue(toolArgs["path"]);
  const pattern = compactDisplayValue(toolArgs["pattern"]);
  const url = compactDisplayValue(toolArgs["url"]);
  const command = compactDisplayValue(toolArgs["command"]);
  const name = compactDisplayValue(toolArgs["name"]);
  const id = compactDisplayValue(toolArgs["id"]);
  const ids = Array.isArray(toolArgs["ids"])
    ? `[${(toolArgs["ids"] as unknown[]).length} ids]`
    : "";

  switch (toolName) {
    case "read_file":
    case "list_dir":
    case "edit_file":
    case "write_file":
      return path ? `${toolName} ${path}` : toolName;
    case "glob":
      return pattern ? `${toolName} ${pattern}` : toolName;
    case "grep":
      return pattern && path ? `${toolName} ${pattern} in ${path}` : pattern ? `${toolName} ${pattern}` : toolName;
    case "find_symbol":
      return compactDisplayValue(toolArgs["query"])
        ? `${toolName} ${compactDisplayValue(toolArgs["query"])}${path ? ` in ${path}` : ""}`
        : toolName;
    case "jq":
      return compactDisplayValue(toolArgs["query"])
        ? `${toolName} ${compactDisplayValue(toolArgs["query"])}${path ? ` ${path}` : ""}`
        : toolName;
    case "bash":
    case "bash_background":
      return command ? `${toolName} ${command}` : toolName;
    case "kill_shell":
      return ids ? `${toolName} ${ids}` : toolName;
    case "web_fetch":
      return url ? `${toolName} ${url}` : toolName;
    case "web_search":
    case "$web_search":
      return compactDisplayValue(toolArgs["query"]) ? `${toolName} ${compactDisplayValue(toolArgs["query"])}` : toolName;
    case "spawn":
      return id ? `${toolName} ${id}` : toolName;
    case "kill_agent":
      return ids ? `${toolName} ${ids}` : toolName;
    case "await_event":
      // 工具本身无参数可展示；实际等待时长由 tool_result 汇报。
      return toolName;
    case "skill":
      return name ? `${toolName} ${name}` : toolName;
    default:
      return toolName;
  }
}

/** 从工具结果的 metadata 中提取 tui_preview。 */
export function extractToolPreview(metadata: Record<string, unknown>): { text: string; dim?: boolean } | null {
  const preview = metadata["tui_preview"];
  if (!preview || typeof preview !== "object") return null;
  const text = (preview as Record<string, unknown>)["text"];
  if (typeof text !== "string" || !text.trim()) return null;
  const dim = (preview as Record<string, unknown>)["dim"] === true ? true : undefined;
  return { text, dim };
}

// ------------------------------------------------------------------
// 流式 / 部分工具调用跟踪
//
// Provider 将工具调用参数作为部分 JSON 片段流式传输。
// 我们逐步解析（parsePartialFlatObject）以：
//   1. 提取完整参数用于早期可见性决策
//   2. 为 TUI 差异渲染构建 StreamableToolCall（edit_file、write_file）
//   3. 探测编辑上下文：在 old_str 仍处于流式状态时读取目标文件以解析行号
// ------------------------------------------------------------------
