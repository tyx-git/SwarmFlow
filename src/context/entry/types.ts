/**
 * 结构化日志条目的数据形状——会话日志架构 v2 的核心类型。
 */

import type { ThinkingArtifact } from "../../thinking/artifact.js";

// ------------------------------------------------------------------
// 枚举类型
// ------------------------------------------------------------------

/** 日志条目类型——决定内容结构和投影规则 */
export type LogEntryType =
  | "system_prompt"
  | "work_start"
  | "work_end"
  | "input_received"
  | "turn_start"
  | "turn_end"
  | "user_message"
  | "agent_result"
  | "assistant_text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "ask_request"
  | "ask_resolution"
  | "no_reply"
  | "compact_marker"
  | "compact_context"
  | "summary"
  | "interruption_marker"
  | "sub_agent_start"
  | "sub_agent_tool_call"
  | "sub_agent_end"
  | "status"
  | "error"
  | "token_update";

/** Turn 类型；summarize 仅用于识别旧会话日志。 */
export type TurnKind = "user" | "summarize" | "compact";
/** 新写入的输入来源类型。旧日志中的 summarize 值只在读取时识别。 */
export type InputKind = "user" | "system" | "peer" | "compact";

/** TUI 显示类型——决定条目在终端中的渲染方式 */
export type TuiDisplayKind =
  | "user"
  | "command_echo"
  | "agent_result"
  | "assistant"
  | "reasoning"
  | "progress"
  | "tool_call"
  | "status"
  | "error"
  | "compact_mark"
  | "tool_result";

// ------------------------------------------------------------------
// LogEntry 接口
// ------------------------------------------------------------------

/** 日志条目——会话中每个事件的结构化记录 */
export interface LogEntry {
  /** 唯一条目 ID（类型前缀 + 序列号，例如 "user-001"、"tc-005"） */
  id: string;

  /** 条目类型——决定内容结构和投影规则 */
  type: LogEntryType;

  /** Unix 毫秒时间戳 */
  timestamp: number;

  /**
   * 用户可见的输入索引（从 1 开始，每次真实用户输入时递增）。
   * 此字段在运行时迁移期间仍命名为 turnIndex；
   * 语义上不再是工作生命周期 ID。
   */
  turnIndex: number;

  /**
   * 同一 turn 内的提供商调用轮次（从 0 开始）。
   * 将 assistant_text + tool_call 条目分组为一条 API 消息。
   * 仅出现在提供商相关条目（assistant_text、reasoning、
   * tool_call、tool_result、no_reply）上。
   */
  roundIndex?: number;

  // ---- TUI 投影层 ----

  /** 此条目在 TUI 中是否可见 */
  tuiVisible: boolean;

  /** TUI 渲染样式。tuiVisible 为 false 时为 null */
  displayKind: TuiDisplayKind | null;

  /** TUI 显示文本。始终保留在活动日志中 */
  display: string;

  // ---- API 投影层 ----

  /** 此条目映射的 API 角色。null = 不参与 API 投影 */
  apiRole: "system" | "user" | "assistant" | "tool_result" | null;

  /** 用于 API 投影的完整内容。归档后为 null */
  content: unknown;

  /** 内容是否已归档到单独文件 */
  archived: boolean;

  // ---- 状态标记 ----

  /** 已丢弃的条目（在投影中跳过）。用于压缩回滚等 */
  discarded?: boolean;

  // ---- 类型特定元数据 ----

  /** 随条目类型变化的结构化元数据 */
  meta: Record<string, unknown>;
}

/** 工具调用日志内容 */
export interface ToolCallLogContent {
  /** 工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 原始参数字符串 */
  rawArguments?: string;
  /** 解析后的参数对象 */
  arguments: Record<string, unknown>;
  /** 参数解析错误信息 */
  parseError?: string | null;
}

