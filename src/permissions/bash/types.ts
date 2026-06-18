/**
 * Types for tree-sitter-based bash command parsing.
 */

export type BashConnector = "&&" | "||" | ";" | "|";

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

export type BashTokenKind = "literal" | "home_reference" | "unresolved_expression";

export interface BashToken {
  readonly text: string;
  readonly value: string;
  readonly kind: BashTokenKind;
  readonly quoted: boolean;
}

export interface ParsedBashCommand {
  readonly text: string;
  readonly name: string;
  readonly nameToken: BashToken;
  readonly argv: readonly BashToken[];
}

export interface ParsedBashSegment {
  readonly index: number;
  readonly text: string;
  readonly operator: "command" | "pipeline";
  readonly connectorBefore: BashConnector | null;
  readonly commands: readonly ParsedBashCommand[];
  /** Whether this segment redirects output to a real file (not /dev/null). */
  readonly hasFileWriteRedirect?: boolean;
}

export interface ParsedBashScript {
  readonly kind: "ok";
  readonly segments: readonly ParsedBashSegment[];
}

export interface UnsupportedBashScript {
  readonly kind: "unsupported";
  readonly reason: BashUnsupportedReason;
  readonly message: string;
  readonly nodeType?: string;
  readonly text?: string;
}

export type BashParseResult = ParsedBashScript | UnsupportedBashScript;
