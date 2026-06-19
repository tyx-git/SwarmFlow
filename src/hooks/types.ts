/**
 * Hook 系统类型。
 *
 * Hooks 是本地基于命令的事件处理器。Hook 清单（hook.json）
 * 声明要监听的事件以及要运行的命令。
 *
 * 支持的事件：
 *   SessionStart, SessionEnd, UserPromptSubmit,
 *   PreToolUse, PostToolUse, PostToolUseFailure,
 *   SubagentStart, SubagentStop, Stop
 *
 * Hook 命令接收事件负载作为 stdin 上的 JSON，并返回
 * stdout 上的 JSON 对象，包含可选的 decision/updatedInput/additionalContext。
 */

// ------------------------------------------------------------------
// 钩子事件
// ------------------------------------------------------------------

export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop";

/** 支持钩子输出中 `decision` 字段的事件。 */
export const DECISION_EVENTS = new Set<HookEvent>(["UserPromptSubmit", "PreToolUse"]);

/** 支持 `failClosed`（钩子失败 = 拒绝）的事件。 */
export const FAIL_CLOSED_EVENTS = new Set<HookEvent>(["SessionStart", "UserPromptSubmit", "PreToolUse"]);

/** 支持钩子输出中 `additionalContext` 的事件。 */
export const CONTEXT_EVENTS = new Set<HookEvent>([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
]);

/** 支持钩子输出中 `updatedInput` 的事件。 */
export const INPUT_UPDATE_EVENTS = new Set<HookEvent>(["PreToolUse"]);

// ------------------------------------------------------------------
// 钩子清单（hook.json）
// ------------------------------------------------------------------

export interface HookManifest {
  name: string;
  event: HookEvent;
  type: "command";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 匹配器 — 如果设置，则仅在满足匹配器条件时触发钩子。 */
  matcher?: HookMatcher;
  /** 钩子执行超时时间，单位为毫秒。默认值：10000。 */
  timeoutMs?: number;
  /** 如果为 true，钩子失败 = 拒绝（仅用于 SessionStart、UserPromptSubmit、PreToolUse）。 */
  failClosed?: boolean;
  /** 如果为 true，钩子被禁用且不会触发。 */
  disabled?: boolean;
  /** hook.json 文件的源路径（由加载器设置）。 */
  _sourcePath?: string;
  /** 发现作用域（由加载器设置）。 */
  _scope?: "project" | "global";
}

export interface HookMatcher {
  toolNames?: string[];
  agentIds?: string[];
}

// ------------------------------------------------------------------
// 钩子事件负载（发送到 stdin）
// ------------------------------------------------------------------

export interface HookPayload {
  event: HookEvent;
  timestamp: number;
  sessionId?: string;
  /** 工具特定字段（PreToolUse / PostToolUse / PostToolUseFailure）。 */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  toolResult?: string;
  /** 用户提示（UserPromptSubmit）。 */
  userPrompt?: string;
  /** Agent 字段（SubagentStart / SubagentStop）。 */
  agentId?: string;
  agentTemplate?: string;
}

// ------------------------------------------------------------------
// 钩子输出（从 stdout 解析）
// ------------------------------------------------------------------

export interface HookOutput {
  /** "allow" 或 "deny" — 仅用于 UserPromptSubmit 和 PreToolUse。 */
  decision?: "allow" | "deny";
  /** 替换工具参数 — 仅用于 PreToolUse。 */
  updatedInput?: Record<string, unknown>;
  /** 要注入下一轮系统提示符的额外上下文。 */
  additionalContext?: string;
  /** 决策的人类可读原因。 */
  reason?: string;
}
