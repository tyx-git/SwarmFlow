/**
 * 基于 tree-sitter 的 bash 命令解析类型定义。
 */

export type BashConnector = "&&" | "||" | ";" | "|";

/** Bash 不支持的原因 */
export type BashUnsupportedReason =
  | "parse_error"
  | "timeout"
  | "subshell"
  | "backticks"
  | "command_substitution"
  | "process_substitution"
  | "heredoc"
  | "unsupported_node"
  | "unresolved_cd_target";

/** Bash 标记类型 */
export type BashTokenKind = "literal" | "home_reference" | "unresolved_expression";

export interface BashToken {
  /** 原始文本 */
  readonly text: string;
  /** 解析后的值 */
  readonly value: string;
  /** 标记类型 */
  readonly kind: BashTokenKind;
  /** 是否被引号包围 */
  readonly quoted: boolean;
}

export interface ParsedBashCommand {
  /** 原始命令文本 */
  readonly text: string;
  /** 命令名称 */
  readonly name: string;
  /** 命令名称标记 */
  readonly nameToken: BashToken;
  /** 命令参数列表 */
  readonly argv: readonly BashToken[];
}

export interface ParsedBashSegment {
  /** 段索引 */
  readonly index: number;
  /** 段文本 */
  readonly text: string;
  /** 操作符类型 */
  readonly operator: "command" | "pipeline";
  /** 前置连接符 */
  readonly connectorBefore: BashConnector | null;
  /** 段中的命令列表 */
  readonly commands: readonly ParsedBashCommand[];
  /** 此段是否将输出重定向到真实文件（不是 /dev/null） */
  readonly hasFileWriteRedirect?: boolean;
}

export interface ParsedBashScript {
  /** 解析成功 */
  readonly kind: "ok";
  /** 解析后的段列表 */
  readonly segments: readonly ParsedBashSegment[];
}

export interface UnsupportedBashScript {
  /** 解析不支持 */
  readonly kind: "unsupported";
  /** 不支持的原因 */
  readonly reason: BashUnsupportedReason;
  /** 错误消息 */
  readonly message: string;
  /** 节点类型（如果有） */
  readonly nodeType?: string;
  /** 原始文本（如果有） */
  readonly text?: string;
}

export type BashParseResult = ParsedBashScript | UnsupportedBashScript;
