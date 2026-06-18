/**
 * Hook system types.
 *
 * Hooks are local command-based event handlers. A hook manifest (hook.json)
 * declares which events to listen to and what command to run.
 *
 * Supported events:
 *   SessionStart, SessionEnd, UserPromptSubmit,
 *   PreToolUse, PostToolUse, PostToolUseFailure,
 *   SubagentStart, SubagentStop, Stop
 *
 * Hook commands receive event payload as JSON on stdin and return
 * a JSON object on stdout with optional decision/updatedInput/additionalContext.
 */

// ------------------------------------------------------------------
// Hook events
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

/** Events that support the `decision` field in hook output. */
export const DECISION_EVENTS = new Set<HookEvent>(["UserPromptSubmit", "PreToolUse"]);

/** Events that support `failClosed` (hook failure = deny). */
export const FAIL_CLOSED_EVENTS = new Set<HookEvent>(["SessionStart", "UserPromptSubmit", "PreToolUse"]);

/** Events that support `additionalContext` in hook output. */
export const CONTEXT_EVENTS = new Set<HookEvent>([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
]);

/** Events that support `updatedInput` in hook output. */
export const INPUT_UPDATE_EVENTS = new Set<HookEvent>(["PreToolUse"]);

// ------------------------------------------------------------------
// Hook manifest (hook.json)
// ------------------------------------------------------------------

export interface HookManifest {
  name: string;
  event: HookEvent;
  type: "command";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Matcher 鈥?if set, hook only fires when matcher conditions are met. */
  matcher?: HookMatcher;
  /** Timeout for hook execution in milliseconds. Default: 10000. */
  timeoutMs?: number;
  /** If true, hook failure = deny (only for SessionStart, UserPromptSubmit, PreToolUse). */
  failClosed?: boolean;
  /** If true, hook is disabled and will not fire. */
  disabled?: boolean;
  /** Source path of the hook.json file (set by loader). */
  _sourcePath?: string;
  /** Discovery scope (set by loader). */
  _scope?: "project" | "global";
}

export interface HookMatcher {
  toolNames?: string[];
  agentIds?: string[];
}

// ------------------------------------------------------------------
// Hook event payload (sent to stdin)
// ------------------------------------------------------------------

export interface HookPayload {
  event: HookEvent;
  timestamp: number;
  sessionId?: string;
  /** Tool-specific fields (PreToolUse / PostToolUse / PostToolUseFailure). */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  toolResult?: string;
  /** User prompt (UserPromptSubmit). */
  userPrompt?: string;
  /** Agent fields (SubagentStart / SubagentStop). */
  agentId?: string;
  agentTemplate?: string;
}

// ------------------------------------------------------------------
// Hook output (parsed from stdout)
// ------------------------------------------------------------------

export interface HookOutput {
  /** "allow" or "deny" 鈥?only for UserPromptSubmit and PreToolUse. */
  decision?: "allow" | "deny";
  /** Replacement tool arguments 鈥?only for PreToolUse. */
  updatedInput?: Record<string, unknown>;
  /** Extra context to inject into the system prompt for the next round. */
  additionalContext?: string;
  /** Human-readable reason for the decision. */
  reason?: string;
}
