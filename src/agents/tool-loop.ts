/**
 * Shared tool loop logic for Agent.
 *
 * Provides the async LLM <-> tool round-trip cycle. Calls the provider,
 * executes tool calls, appends results via callbacks, and repeats until
 * the model responds without tool calls or max rounds are reached.
 *
 * v2: operates through callbacks (getMessages / appendEntry) instead of
 * directly mutating provider messages. The backing store can be the
 * structured session log (main agent) or an ephemeral structured log
 * (sub-agents / stateless runs).
 */

import { readFileSync, existsSync } from "node:fs";

import type {
  BaseProvider,
  ProviderResponse,
  ToolCall,
  ToolDef,
  ToolResult,
} from "../providers/base.js";
import { ToolResult as ToolResultClass } from "../providers/base.js";
import {
  isRetryableNetworkError,
  computeRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
} from "../lib/network-retry.js";
import type { LogEntry } from "../context/log-entry.js";
import {
  createReasoning,
  createAssistantText,
  createToolCall,
  createToolResult as createToolResultEntry,
} from "../context/log-entry.js";
import type { ThinkingArtifact } from "../lib/thinking-artifact.js";
import type { AskRequest } from "../ask.js";
import {
  type DiffHunk,
  type FileModifyDisplayData,
  type EditProbeState,
  inferLanguageByExt,
  computeContextBefore,
  computeContextAfter,
  countFileLines,
  buildHunkFromMatch,
  buildAppendDisplayData,
  buildWriteDisplayData,
} from "../lib/diff-hunk.js";

// ------------------------------------------------------------------
// Tool executor type
// ------------------------------------------------------------------

import type { ToolExecutor, ToolExecutorContext } from "../tools/executor-types.js";
export type { ToolExecutor, ToolExecutorContext };

// ------------------------------------------------------------------
// generateToolSummary
// ------------------------------------------------------------------

/** Generate a one-line summary from a ToolDef.summaryTemplate. */
export function generateToolSummary(
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summaryTemplate: string,
): string {
  if (summaryTemplate) {
    try {
      // Replace {agent} and any {argKey} placeholders
      let result = summaryTemplate.replace(/\{agent\}/g, agentName);
      for (const [key, value] of Object.entries(toolArgs)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
      }
      // If any unreplaced placeholders remain, fall through to default
      if (!/\{[^}]+\}/.test(result)) {
        return result;
      }
    } catch {
      // fall through
    }
  }
  return `${agentName} is calling ${toolName}`;
}

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

export function generateToolCallDisplay(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  const path = compactDisplayValue(toolArgs["path"]);
  const file = compactDisplayValue(toolArgs["file"]);
  const pattern = compactDisplayValue(toolArgs["pattern"]);
  const url = compactDisplayValue(toolArgs["url"]);
  const command = compactDisplayValue(toolArgs["command"]);
  const name = compactDisplayValue(toolArgs["name"]);
  const id = compactDisplayValue(toolArgs["id"]);
  const shell = compactDisplayValue(toolArgs["shell"]);
  const opsCount = Array.isArray(toolArgs["operations"])
    ? `[${(toolArgs["operations"] as unknown[]).length} ops]`
    : "";
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
    case "bash":
      return command ? `${toolName} ${command}` : toolName;
    case "bash_background":
      return command ? `${toolName} ${command}` : toolName;
    case "bash_output":
      return id ? `${toolName} ${id}` : toolName;
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
      if (shell) {
        return toolArgs["seconds"] !== undefined
          ? `${toolName} ${shell} ${String(toolArgs["seconds"])}s`
          : `${toolName} ${shell}`;
      }
      return toolArgs["seconds"] !== undefined ? `${toolName} ${String(toolArgs["seconds"])}s` : toolName;
    case "summarize_context":
      return opsCount ? `${toolName} ${opsCount}` : toolName;
    case "skill":
      return name ? `${toolName} ${name}` : toolName;
    default:
      return toolName;
  }
}

function extractToolPreview(metadata: Record<string, unknown>): { text: string; dim?: boolean } | null {
  const preview = metadata["tui_preview"];
  if (!preview || typeof preview !== "object") return null;
  const text = (preview as Record<string, unknown>)["text"];
  if (typeof text !== "string" || !text.trim()) return null;
  const dim = (preview as Record<string, unknown>)["dim"] === true ? true : undefined;
  return { text, dim };
}

interface ToolStreamSection {
  key: string;
  label: string;
  text: string;
  complete: boolean;
  contextBefore?: string;
  contextAfter?: string;
  contextResolved?: boolean;
  startLineNumber?: number;
}

type StreamMode = "replace" | "append" | "write";

interface StreamableToolCall {
  canonicalArgs: Record<string, unknown>;
  sections: ToolStreamSection[];
  language?: string;
  streamMode?: StreamMode;
}

type PendingToolStreamPhase = "hidden_partial" | "visible_partial" | "closed";
type PendingToolExecPhase = "not_started" | "running" | "completed" | "failed";

interface PendingToolCallState {
  name: string;
  rawArguments: string;
  entryId: string | null;
  completeTopLevelArgs: Record<string, unknown>;
  canonicalArgs: Record<string, unknown> | null;
  closedCall: ToolCall | null;
  sections: ToolStreamSection[];
  executionPromise: Promise<{ suspendedAsk?: { ask: AskRequest; toolCallId: string; roundIndex: number } } | null> | null;
  streamPhase: PendingToolStreamPhase;
  execPhase: PendingToolExecPhase;
  tuiVisibility: ToolCallTuiVisibility;
  // Context probing (edit_file replace/append mode)
  cachedFileContent?: string;
  cachedTotalLineCount?: number;
  /** Per-edit probing state (single-edit = 1 element, multi-edit = N elements). */
  editProbes?: EditProbeState[];
  appendStartLine?: number;
  // Streaming display hints
  streamLanguage?: string;
  streamMode?: StreamMode;
  contextId?: string;
}

interface ParsedPartialField {
  value: string | number | boolean | null;
  complete: boolean;
  kind: "string" | "number" | "boolean" | "null";
}

function trimIncompleteEscapeSuffix(raw: string): string {
  const slashIndex = raw.lastIndexOf("\\");
  if (slashIndex === -1) return raw;
  const suffix = raw.slice(slashIndex);
  if (suffix.length === 1) return raw.slice(0, slashIndex);
  if (suffix[1] === "u") {
    const hex = suffix.slice(2);
    if (hex.length < 4 || /[^0-9a-fA-F]/.test(hex)) {
      return raw.slice(0, slashIndex);
    }
  }
  return raw;
}

function decodeJsonStringFragment(raw: string): string {
  const sanitized = trimIncompleteEscapeSuffix(raw);
  try {
    return JSON.parse(`"${sanitized}"`) as string;
  } catch {
    return sanitized;
  }
}

function skipWhitespace(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
  return cursor;
}

function readQuotedToken(
  input: string,
  index: number,
): { raw: string; complete: boolean; next: number } | null {
  if (input[index] !== "\"") return null;
  let cursor = index + 1;
  let raw = "";
  while (cursor < input.length) {
    const ch = input[cursor];
    if (ch === "\\") {
      if (cursor + 1 >= input.length) {
        return { raw, complete: false, next: input.length };
      }
      if (input[cursor + 1] === "u") {
        const unicodeChunk = input.slice(cursor, cursor + 6);
        if (unicodeChunk.length < 6 || /[^\\u0-9a-fA-F]/.test(unicodeChunk)) {
          return { raw, complete: false, next: input.length };
        }
        raw += unicodeChunk;
        cursor += 6;
        continue;
      }
      raw += input.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }
    if (ch === "\"") {
      return { raw, complete: true, next: cursor + 1 };
    }
    raw += ch;
    cursor += 1;
  }
  return { raw, complete: false, next: input.length };
}

function readLiteralToken(
  input: string,
  index: number,
): { raw: string; complete: boolean; next: number } {
  let cursor = index;
  while (cursor < input.length && !/[,\s}]/.test(input[cursor])) cursor += 1;
  const raw = input.slice(index, cursor);
  const next = skipWhitespace(input, cursor);
  const complete = next >= input.length || input[next] === "," || input[next] === "}";
  return { raw, complete, next: cursor };
}

function parsePartialFlatObject(input: string): Record<string, ParsedPartialField> {
  const fields: Record<string, ParsedPartialField> = {};
  let cursor = skipWhitespace(input, 0);
  if (input[cursor] !== "{") return fields;
  cursor += 1;

  while (cursor < input.length) {
    cursor = skipWhitespace(input, cursor);
    if (cursor >= input.length || input[cursor] === "}") break;

    const keyToken = readQuotedToken(input, cursor);
    if (!keyToken || !keyToken.complete) break;
    const key = decodeJsonStringFragment(keyToken.raw);
    cursor = skipWhitespace(input, keyToken.next);
    if (cursor >= input.length || input[cursor] !== ":") break;
    cursor = skipWhitespace(input, cursor + 1);
    if (cursor >= input.length) break;

    if (input[cursor] === "\"") {
      const valueToken = readQuotedToken(input, cursor);
      if (!valueToken) break;
      fields[key] = {
        value: decodeJsonStringFragment(valueToken.raw),
        complete: valueToken.complete,
        kind: "string",
      };
      cursor = valueToken.next;
      if (!valueToken.complete) break;
    } else {
      const literalToken = readLiteralToken(input, cursor);
      const raw = literalToken.raw;
      let kind: ParsedPartialField["kind"] | null = null;
      let value: ParsedPartialField["value"] = null;

      if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
        kind = "number";
        value = Number(raw);
      } else if (raw === "true" || raw === "false") {
        kind = "boolean";
        value = raw === "true";
      } else if (raw === "null") {
        kind = "null";
        value = null;
      }

      if (kind) {
        fields[key] = {
          value,
          complete: literalToken.complete,
          kind,
        };
      }
      cursor = literalToken.next;
      if (!literalToken.complete) break;
    }

    cursor = skipWhitespace(input, cursor);
    if (cursor < input.length && input[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (cursor < input.length && input[cursor] === "}") break;
  }

  return fields;
}

function extractCompleteFlatArgs(
  fields: Record<string, ParsedPartialField>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!field.complete) continue;
    args[key] = field.value;
  }
  return args;
}

function extractCompleteOptionalArgs(
  fields: Record<string, ParsedPartialField>,
): Record<string, unknown> {
  const optional: Record<string, unknown> = {};
  const maybeAssign = (key: string): void => {
    const field = fields[key];
    if (!field || !field.complete) return;
    optional[key] = field.value;
  };
  maybeAssign("expected_mtime_ms");
  maybeAssign("intent");
  return optional;
}

// ------------------------------------------------------------------
// Partial edits-array parser for multi-edit streaming
// ------------------------------------------------------------------

interface ParsedEditItem {
  old_str: ParsedPartialField | null;
  new_str: ParsedPartialField | null;
  complete: boolean;
}

function parseEditsArray(
  input: string,
  startCursor: number,
): { edits: ParsedEditItem[]; arrayComplete: boolean } {
  const edits: ParsedEditItem[] = [];
  let cursor = startCursor;
  if (input[cursor] !== "[") return { edits, arrayComplete: false };
  cursor += 1;

  while (cursor < input.length) {
    cursor = skipWhitespace(input, cursor);
    if (cursor >= input.length) break;
    if (input[cursor] === "]") return { edits, arrayComplete: true };
    if (input[cursor] === ",") { cursor += 1; continue; }
    if (input[cursor] !== "{") break;

    // Parse a single { old_str: "...", new_str: "..." } object
    const innerFields = parsePartialFlatObject(input.slice(cursor));
    // Find the closing } to know if this edit item is complete
    let depth = 0;
    let objEnd = cursor;
    let objComplete = false;
    for (let k = cursor; k < input.length; k++) {
      if (input[k] === "{") depth++;
      else if (input[k] === "}") {
        depth--;
        if (depth === 0) { objEnd = k + 1; objComplete = true; break; }
      }
    }
    if (!objComplete) objEnd = input.length;

    edits.push({
      old_str: innerFields["old_str"] ?? null,
      new_str: innerFields["new_str"] ?? null,
      complete: objComplete,
    });

    cursor = objEnd;
  }

  return { edits, arrayComplete: false };
}

function buildStreamableToolCall(
  toolName: string,
  rawArgsBuffer: string,
): StreamableToolCall | null {
  const fields = parsePartialFlatObject(rawArgsBuffer);
  const pathField = fields["path"];
  if (!pathField || pathField.kind !== "string" || !pathField.complete) {
    return null;
  }
  const path = pathField.value as string;
  const optional = extractCompleteOptionalArgs(fields);

  const language = inferLanguageByExt(path);

  if (toolName === "write_file") {
    const contentField = fields["content"];
    if (!contentField || contentField.kind !== "string") return null;
    return {
      canonicalArgs: {
        path,
        content: contentField.value,
        ...optional,
      },
      sections: [{
        key: "content",
        label: "Content",
        text: String(contentField.value ?? ""),
        complete: contentField.complete,
      }],
      language,
      streamMode: "write" as StreamMode,
    };
  }

  if (toolName === "edit_file") {
    const appendField = fields["append_str"];
    const hasAppend = appendField && appendField.kind === "string";

    // Edits array (possibly combined with append)
    const editsStart = rawArgsBuffer.indexOf('"edits"');
    if (editsStart !== -1) {
      const arrayStart = rawArgsBuffer.indexOf("[", editsStart);
      if (arrayStart !== -1) {
        const parsed = parseEditsArray(rawArgsBuffer, arrayStart);
        const sections: ToolStreamSection[] = [];
        const canonicalEdits: Array<{ old_str: unknown; new_str: unknown }> = [];
        const isSingle = parsed.edits.length === 1;
        for (const [idx, edit] of parsed.edits.entries()) {
          if (edit.old_str) {
            sections.push({
              key: `old_str_${idx}`,
              label: isSingle ? "Before" : `Before #${idx + 1}`,
              text: String(edit.old_str.value ?? ""),
              complete: edit.old_str.complete,
            });
          }
          if (edit.new_str) {
            sections.push({
              key: `new_str_${idx}`,
              label: isSingle ? "After" : `After #${idx + 1}`,
              text: String(edit.new_str.value ?? ""),
              complete: edit.new_str.complete,
            });
          }
          canonicalEdits.push({
            old_str: edit.old_str?.value ?? "",
            new_str: edit.new_str?.value ?? "",
          });
        }
        if (hasAppend) {
          sections.push({
            key: "append_str",
            label: "Append",
            text: String(appendField!.value ?? ""),
            complete: appendField!.complete,
          });
        }
        if (sections.length === 0) return null;
        return {
          canonicalArgs: {
            path,
            edits: canonicalEdits,
            ...(hasAppend ? { append_str: appendField!.value } : {}),
            ...optional,
          },
          sections,
          language,
          streamMode: "replace" as StreamMode,
        };
      }
    }

    // Append-only (no edits array)
    if (hasAppend) {
      return {
        canonicalArgs: { path, append_str: appendField!.value, ...optional },
        sections: [{
          key: "append_str",
          label: "Append",
          text: String(appendField!.value ?? ""),
          complete: appendField!.complete,
        }],
        language,
        streamMode: "append" as StreamMode,
      };
    }

    return null;
  }

  return null;
}

function buildToolCallMeta(
  base: { toolCallId: string; toolName: string; agentName: string; contextId?: string },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    toolCallId: base.toolCallId,
    toolName: base.toolName,
    agentName: base.agentName,
  };
  if (base.contextId !== undefined) meta.contextId = base.contextId;
  if (extra) Object.assign(meta, extra);
  return meta;
}

function resolveDefaultToolCallTuiVisibility(
  toolDef: ToolDef | undefined,
  toolArgs: Record<string, unknown>,
  isClosed: boolean,
): ToolCallTuiVisibility {
  const policy = toolDef?.tuiPolicy?.partialReveal ?? "immediate";
  if (policy === "immediate") return "show";
  if (policy === "closed") return isClosed ? "show" : "defer";
  const ready = policy.completeArgs.every((key) => Object.prototype.hasOwnProperty.call(toolArgs, key));
  return ready || isClosed ? "show" : "defer";
}

// ------------------------------------------------------------------
// ToolLoopResult
// ------------------------------------------------------------------

export interface ToolLoopResult {
  text: string;
  toolHistory: Array<Record<string, unknown>>;
  totalUsage: { inputTokens: number; outputTokens: number };
  intermediateText: string[];
  lastInputTokens: number;
  reasoningContent: string;
  reasoningState: unknown;
  thinkingArtifact?: ThinkingArtifact | null;
  /** Flat context_id of the last tool-call round (undefined if no tool calls). */
  lastRoundId?: string;
  /** Whether the tool loop detected that compact is needed. */
  compactNeeded?: boolean;
  /** Which scenario triggered compact. */
  compactScenario?: "mid_turn";
  /** Total tokens (input + output) from the last provider call. */
  lastTotalTokens?: number;
  /** Whether the final assistant text was already materialized by stream callbacks. */
  textHandledInLog?: boolean;
  /** Whether the final reasoning content was already materialized by stream callbacks. */
  reasoningHandledInLog?: boolean;
  /** True when the final provider call returned no tool_calls (pure text output). */
  endedWithoutToolCalls?: boolean;
  /** Suspended on an ask tool call that requires user input. */
  suspendedAsk?: {
    ask: AskRequest;
    toolCallId: string;
    roundIndex: number;
  };
}

// ------------------------------------------------------------------
// OnToolCall callback type
// ------------------------------------------------------------------

export type OnToolCallCallback = (
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summary: string,
) => void;

export type OnToolResultCallback = (
  agentName: string,
  toolName: string,
  toolCallId: string,
  isError: boolean,
  summary: string,
) => void;

export interface ToolPreflightContext {
  agentName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  summary: string;
}

export type ToolPreflightDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; ask: AskRequest };

export type BeforeToolExecuteCallback = (
  ctx: ToolPreflightContext,
) => ToolPreflightDecision | void | Promise<ToolPreflightDecision | void>;

export type ToolCallTuiVisibility = "defer" | "show" | "hide";

export interface ToolCallVisibilityContext {
  agentName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  rawArguments: string;
  isClosed: boolean;
  toolDef?: ToolDef;
  defaultDecision: ToolCallTuiVisibility;
}

export type ResolveToolCallVisibilityCallback = (
  ctx: ToolCallVisibilityContext,
) => ToolCallTuiVisibility | void;

// ------------------------------------------------------------------
// asyncRunToolLoop
// ------------------------------------------------------------------

export interface ToolLoopOptions {
  provider: BaseProvider;
  /**
   * Returns the current API message sequence for the provider.
   * Called before each provider call.
   * Main agent: projects from _log; sub-agents: returns local array.
   */
  getMessages: () => Array<Record<string, unknown>>;
  /**
   * Append a LogEntry to the backing store.
   * Main agent: appends to _log; sub-agents: converts to raw msg and pushes.
   */
  appendEntry: (entry: LogEntry) => void;
  /** Allocate the next entry ID. */
  allocId: (type: LogEntry["type"]) => string;
  /** Current turn index (for entry creation). */
  turnIndex: number;
  /** Base round index for this activation within the current turn. */
  baseRoundIndex?: number;
  tools?: ToolDef[];
  toolExecutors: Record<string, ToolExecutor>;
  maxRounds: number;
  agentName?: string;
  onToolCall?: OnToolCallCallback;
  onToolResult?: OnToolResultCallback;
  toolsMap?: Record<string, ToolDef>;
  onTextChunk?: (roundIndex: number, chunk: string) => boolean | void;
  onReasoningChunk?: (roundIndex: number, chunk: string) => boolean | void;
  /** Called after all reasoning content for a round has been received. */
  onReasoningDone?: (
    roundIndex: number,
    thinkingArtifact?: ThinkingArtifact | null,
    reasoningState?: unknown,
  ) => void;
  /** Fallback executor for tools not found in toolExecutors. */
  builtinExecutor?: (
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolExecutorContext,
  ) => Promise<ToolResult | string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Allocator that returns the round's context_id (used for text/reasoning). */
  contextIdAllocator?: (roundIndex: number) => string;
  /** Allocator that returns a fresh context_id for each tool_call. */
  toolContextIdAllocator?: () => string;
  /** Called after each provider response with the latest input token count and full Usage. */
  onTokenUpdate?: (inputTokens: number, usage?: import("../providers/base.js").Usage) => void;
  /**
   * Callback to check whether compact is needed after each provider call.
   * Returns { compactNeeded, scenario } or null to skip.
   * When undefined, no compact checking is performed (e.g. sub-agents).
   */
  compactCheck?: (
    inputTokens: number,
    outputTokens: number,
    hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null;
  /** Unified thinking level override (passed to provider). */
  thinkingLevel?: string;
  /** Routing key for OpenAI prompt cache affinity (e.g. child session id). */
  promptCacheKey?: string;
  /** Called after each tool_result is appended, for incremental persistence. */
  onSaveCheckpoint?: () => void;
  /** Optional preflight gate before executing a tool call (may ask/pause/deny). */
  beforeToolExecute?: BeforeToolExecuteCallback;
  /** Returns a notification string to append to tool_result content, or null if none. */
  getNotification?: () => string | null;
  /** Called after all tool_results in a round are written, before the next model call.
   *  Used by Session to drain queued inbox messages at the round boundary. */
  onToolRoundComplete?: () => void;
  /** When true, streamed text/reasoning callbacks own the corresponding log entries. */
  streamCallbacksOwnEntries?: boolean;
  /** Called when a network error is detected and a retry is being attempted. */
  onRetryAttempt?: (attempt: number, maxRetries: number, delaySec: number, errMsg: string) => void;
  /** Called when a retried network call succeeds. */
  onRetrySuccess?: (attempt: number) => void;
  /** Called when all network retries have been exhausted. */
  onRetryExhausted?: (maxRetries: number, errMsg: string) => void;
  /** Called as tool-call arguments evolve; providers pass the latest raw argument buffer. */
  onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
  /** Resolve whether a tool call should stay deferred, render, or stay hidden in the TUI. */
  resolveToolCallVisibility?: ResolveToolCallVisibilityCallback;
  /**
   * Returns true if a file path is the exact session plan file. When a
   * write/edit targets it, the tool_call entry is tagged with
   * `toolMetadata.planFileOperation` so the TUI relabels it as "Update Todos"
   * (rather than matching by filename). Checked once the `path` arg is known.
   */
  isPlanFilePath?: (filePath: string) => boolean;
  /** Update an existing log entry in-place (for finalizing pending tool call entries). */
  updateEntry?: (entryId: string, patch: {
    apiRole?: LogEntry["apiRole"];
    content?: unknown;
    display?: string;
    tuiVisible?: boolean;
    displayKind?: LogEntry["displayKind"];
    meta?: Record<string, unknown>;
  }) => void;
  /** Mark a log entry as discarded (for cleanup on retry). */
  discardEntry?: (entryId: string) => void;
}

/**
 * Async tool loop: call LLM, execute tools, repeat until done.
 *
 * Tool executors are called with their arguments dict and may be
 * sync or async. Exceptions are caught and returned as error
 * ToolResult content.
 */
export async function asyncRunToolLoop(
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    provider,
    getMessages,
    appendEntry,
    allocId,
    turnIndex,
    baseRoundIndex = 0,
    tools,
    toolExecutors,
    maxRounds,
    agentName = "",
    onToolCall,
    onToolResult,
    onTextChunk,
    onReasoningChunk,
    onReasoningDone,
    builtinExecutor,
    signal,
    contextIdAllocator,
    toolContextIdAllocator,
    onTokenUpdate,
    compactCheck,
    thinkingLevel,
    promptCacheKey,
    onSaveCheckpoint,
    beforeToolExecute,
    getNotification,
    onToolRoundComplete,
    streamCallbacksOwnEntries = false,
    onRetryAttempt,
    onRetrySuccess,
    onRetryExhausted,
    onToolCallPartial: onToolCallPartialOpt,
    resolveToolCallVisibility,
    isPlanFilePath,
    updateEntry,
    discardEntry,
  } = opts;

  let toolsMap = opts.toolsMap;
  if (!toolsMap && tools) {
    toolsMap = Object.fromEntries(tools.map((t) => [t.name, t]));
  }

  const toolHistory: Array<Record<string, unknown>> = [];
  const intermediateText: string[] = [];
  let hadStreamedText = false;
  let totalInput = 0;
  let totalOutput = 0;
  let lastInput = 0;
  let lastReasoningContent = "";
  let lastReasoningState: unknown = null;
  let lastThinkingArtifact: ThinkingArtifact | null = null;

  // Flat context ID per tool-call round
  let lastRoundId: string | undefined;

  // Network retry counter (consecutive failures across rounds)
  let networkRetryCount = 0;

  for (let roundIdx = 0; roundIdx < maxRounds; roundIdx++) {
    const roundIndex = baseRoundIndex + roundIdx;
    // Check abort before each provider call
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Track whether the provider called onTextChunk (streaming).
    let providerStreamedText = false;
    let providerStreamedReasoning = false;
    let textHandledViaCallback = false;
    let reasoningHandledViaCallback = false;
    let wrappedChunk: ((chunk: string) => void) | undefined;
    if (onTextChunk) {
      wrappedChunk = (chunk: string) => {
        providerStreamedText = true;
        textHandledViaCallback = onTextChunk(roundIndex, chunk) === true || textHandledViaCallback;
      };
    }
    let wrappedReasoningChunk: ((chunk: string) => void) | undefined;
    if (onReasoningChunk) {
      wrappedReasoningChunk = (chunk: string) => {
        providerStreamedReasoning = true;
        reasoningHandledViaCallback = onReasoningChunk(roundIndex, chunk) === true || reasoningHandledViaCallback;
      };
    }

    const ensureRoundContextId = (): string | undefined => {
      if (lastRoundId === undefined && contextIdAllocator) {
        lastRoundId = contextIdAllocator(roundIndex);
      }
      return lastRoundId;
    };

    const pendingToolCalls = new Map<string, PendingToolCallState>();

    const ensurePendingToolCall = (callId: string, name: string): PendingToolCallState => {
      let pending = pendingToolCalls.get(callId);
      if (!pending) {
        pending = {
          name,
          rawArguments: "",
          entryId: null,
          completeTopLevelArgs: {},
          canonicalArgs: null,
          closedCall: null,
          sections: [],
          executionPromise: null,
          streamPhase: "hidden_partial",
          execPhase: "not_started",
          tuiVisibility: "defer",
        };
        pendingToolCalls.set(callId, pending);
      } else if (name && pending.name !== name) {
        pending.name = name;
      }
      return pending;
    };

    const getToolArgsForEntry = (pending: PendingToolCallState): Record<string, unknown> | null => {
      return pending.closedCall?.arguments ?? pending.canonicalArgs ?? pending.completeTopLevelArgs ?? {};
    };

    const resolvePendingToolVisibility = (
      pending: PendingToolCallState,
      isClosed: boolean,
    ): ToolCallTuiVisibility => {
      if (pending.tuiVisibility === "show" || pending.tuiVisibility === "hide") {
        return pending.tuiVisibility;
      }
      const toolArgs = getToolArgsForEntry(pending) ?? {};
      const toolDef = toolsMap?.[pending.name];
      const defaultDecision = resolveDefaultToolCallTuiVisibility(toolDef, toolArgs, isClosed);
      const override = resolveToolCallVisibility?.({
        agentName,
        toolName: pending.name,
        toolArgs,
        rawArguments: pending.rawArguments,
        isClosed,
        toolDef,
        defaultDecision,
      });
      return override ?? defaultDecision;
    };

    const deriveSectionsForState = (
      toolName: string,
      pending: PendingToolCallState,
    ): ToolStreamSection[] => {
      if (pending.sections.length > 0) return pending.sections;
      const args = getToolArgsForEntry(pending);
      if (!args && !pending.rawArguments) return [];
      const streamable = buildStreamableToolCall(
        toolName,
        pending.rawArguments || JSON.stringify(args ?? {}),
      );
      if (!streamable) return [];
      // Backfill language/mode when recordPartialToolCall was never called
      // (provider sent full args at once without streaming deltas)
      if (!pending.streamLanguage && streamable.language) pending.streamLanguage = streamable.language;
      if (!pending.streamMode && streamable.streamMode) pending.streamMode = streamable.streamMode;
      pending.sections = streamable.sections;
      probeEditContext(pending, streamable);
      return pending.sections;
    };

    const deriveToolStreamState = (pending: PendingToolCallState): string | undefined => {
      if (pending.streamPhase === "hidden_partial") return undefined;
      if (pending.streamPhase === "visible_partial") return "partial";
      return "closed";
    };

    const buildToolCallContent = (
      callId: string,
      pending: PendingToolCallState,
    ): { id: string; name: string; rawArguments: string; arguments: Record<string, unknown>; parseError: string | null } => ({
      id: callId,
      name: pending.name,
      rawArguments: pending.closedCall?.rawArguments ?? pending.rawArguments,
      arguments: getToolArgsForEntry(pending) ?? {},
      parseError: pending.closedCall?.parseError ?? null,
    });

    const syncToolCallEntry = (callId: string): void => {
      const pending = pendingToolCalls.get(callId);
      if (!pending) return;
      if (pending.tuiVisibility === "defer") return;
      const args = getToolArgsForEntry(pending) ?? {};

      const sections = deriveSectionsForState(pending.name, pending);
      if (!pending.contextId && toolContextIdAllocator) {
        pending.contextId = toolContextIdAllocator();
      }
      const contextId = pending.contextId ?? ensureRoundContextId();
      const display = generateToolCallDisplay(pending.name, args);
      const fmd = buildFileModifyData(pending);
      // Tag the call entry as a plan-file op once its path is known to be the
      // exact session plan file, so the TUI relabels it as "Update Todos" while
      // it streams (the result carries the same flag once the write completes).
      const callPath = typeof args.path === "string" ? args.path : "";
      const isPlanCall = callPath !== "" && isPlanFilePath?.(callPath) === true;
      const meta = buildToolCallMeta(
        { toolCallId: callId, toolName: pending.name, agentName, contextId },
        {
          toolStreamState: deriveToolStreamState(pending),
          toolExecState: pending.execPhase,
          toolStreamSections: sections.length > 0 ? sections : undefined,
          toolStreamLanguage: pending.streamLanguage,
          toolStreamMode: pending.streamMode,
          fileModifyData: fmd,
          ...(isPlanCall ? { toolMetadata: { planFileOperation: true } } : {}),
        },
      );
      const entryTuiVisible = pending.tuiVisibility === "show";

      if (!pending.entryId) {
        const entryId = allocId("tool_call");
        const entry = createToolCall(
          entryId,
          turnIndex,
          roundIndex,
          display,
          buildToolCallContent(callId, pending),
          { toolCallId: callId, toolName: pending.name, agentName, contextId },
          pending.closedCall ? "assistant" : null,
        );
        entry.meta = meta;
        entry.tuiVisible = entryTuiVisible;
        entry.displayKind = entryTuiVisible ? "tool_call" : null;
        appendEntry(entry);
        pending.entryId = entryId;
        return;
      }

      updateEntry?.(pending.entryId, {
        apiRole: pending.closedCall ? "assistant" : null,
        content: buildToolCallContent(callId, pending),
        display,
        tuiVisible: entryTuiVisible,
        displayKind: entryTuiVisible ? "tool_call" : null,
        meta,
      });
    };

    const probeEditContext = (
      pending: PendingToolCallState,
      streamable: StreamableToolCall,
    ): void => {
      if (streamable.streamMode !== "replace" && streamable.streamMode !== "append") return;

      const filePath = streamable.canonicalArgs.path as string | undefined;
      if (!filePath) return;

      // Read and cache file content (shared by replace + append)
      if (pending.cachedFileContent === undefined) {
        try {
          if (existsSync(filePath)) {
            pending.cachedFileContent = readFileSync(filePath, "utf-8");
            pending.cachedTotalLineCount = countFileLines(pending.cachedFileContent);
          }
        } catch { /* skip */ }
        if (pending.cachedFileContent === undefined) {
          pending.cachedFileContent = ""; // mark as attempted
          return;
        }
      }
      if (!pending.cachedFileContent) return;

      // --- append mode ---
      if (streamable.streamMode === "append") {
        if (pending.appendStartLine === undefined) {
          pending.appendStartLine = (pending.cachedTotalLineCount ?? 0) + 1;
        }
        return;
      }

      // --- replace mode (single or multi-edit) ---
      // Collect edit pairs from sections
      const editPairs: Array<{ oldText: string; oldComplete: boolean; idx: number }> = [];
      for (const s of streamable.sections) {
        const m = s.key.match(/^old_str(?:_(\d+))?$/);
        if (m) {
          const editIdx = m[1] !== undefined ? parseInt(m[1], 10) : 0;
          editPairs.push({ oldText: s.text, oldComplete: s.complete, idx: editIdx });
        }
      }

      if (!pending.editProbes) pending.editProbes = [];
      const fc = pending.cachedFileContent;

      for (const pair of editPairs) {
        const probe: EditProbeState = pending.editProbes[pair.idx] ??= { resolved: false };
        if (!pair.oldText) continue;

        // Only probe when old_str has at least one newline (or is complete)
        if (!pair.oldText.includes("\n") && !pair.oldComplete) continue;

        // First resolution: find unique match
        if (!probe.resolved) {
          const idx = fc.indexOf(pair.oldText);
          if (idx === -1) continue;
          if (fc.indexOf(pair.oldText, idx + 1) !== -1) continue;

          probe.resolved = true;
          probe.matchOffset = idx;
          probe.startLine = fc.substring(0, idx).split("\n").length;
          probe.contextBefore = computeContextBefore(fc, idx, 3);
        }

        // Compute contextAfter once when old_str is complete
        if (pair.oldComplete && probe.resolved && !probe.contextAfter) {
          const matchEnd = probe.matchOffset! + pair.oldText.length;
          probe.contextAfter = computeContextAfter(fc, matchEnd, 3);
        }
      }
    };

    /** Build FileModifyDisplayData from pending state for meta injection. */
    const buildFileModifyData = (
      pending: PendingToolCallState,
    ): FileModifyDisplayData | undefined => {
      const filePath = pending.canonicalArgs?.path as string | undefined;
      if (!filePath || !pending.streamMode) return undefined;

      const totalLineCount = pending.cachedTotalLineCount ?? 0;

      if (pending.streamMode === "write") {
        const contentSection = pending.sections.find((s) => s.key === "content");
        return buildWriteDisplayData(filePath, contentSection?.text ?? "", totalLineCount);
      }

      if (pending.streamMode === "append") {
        const appendSection = pending.sections.find((s) => s.key === "append_str");
        return buildAppendDisplayData(filePath, appendSection?.text ?? "", totalLineCount);
      }

      // Replace mode: build hunks from editProbes
      if (!pending.editProbes || pending.editProbes.length === 0) return undefined;

      const hunks: DiffHunk[] = [];
      // Pair up old_str/new_str sections
      for (let i = 0; i < pending.editProbes.length; i++) {
        const probe = pending.editProbes[i];
        if (!probe.resolved || probe.startLine === undefined) continue;

        const oldKey = `old_str_${i}`;
        const newKey = `new_str_${i}`;
        const oldSection = pending.sections.find((s) => s.key === oldKey);
        const newSection = pending.sections.find((s) => s.key === newKey);

        hunks.push({
          startLine: probe.startLine,
          contextBefore: probe.contextBefore ?? [],
          deletions: oldSection?.text ? oldSection.text.split("\n") : [],
          additions: newSection?.text ? newSection.text.split("\n") : [],
          contextAfter: probe.contextAfter ?? [],
        });
      }

      if (hunks.length === 0) return undefined;

      return {
        filePath,
        language: pending.streamLanguage,
        mode: "replace",
        totalLineCount,
        hunks,
      };
    };

    const recordPartialToolCall = (
      callId: string,
      toolName: string,
      rawArguments: string,
    ): void => {
      const pending = ensurePendingToolCall(callId, toolName);
      pending.rawArguments = rawArguments;
      pending.completeTopLevelArgs = extractCompleteFlatArgs(parsePartialFlatObject(rawArguments));
      const streamable = buildStreamableToolCall(toolName, rawArguments);
      if (streamable) {
        pending.canonicalArgs = streamable.canonicalArgs;
        pending.sections = streamable.sections;
        if (streamable.language) pending.streamLanguage = streamable.language;
        if (streamable.streamMode) pending.streamMode = streamable.streamMode;
        // Probe context for edit_file replace mode
        probeEditContext(pending, streamable);
      }
      if (pending.streamPhase !== "closed") {
        pending.tuiVisibility = resolvePendingToolVisibility(pending, false);
        pending.streamPhase = pending.tuiVisibility === "show" ? "visible_partial" : "hidden_partial";
      }
      if (pending.entryId || pending.tuiVisibility === "show") {
        syncToolCallEntry(callId);
      }
    };

    const executeResolvedToolCall = (
      callId: string,
      toolName: string,
      args: Record<string, unknown>,
      fatalParseError?: string,
    ): Promise<{ suspendedAsk?: { ask: AskRequest; toolCallId: string; roundIndex: number } } | null> => {
      const pending = ensurePendingToolCall(callId, toolName);
      if (pending.executionPromise) {
        return pending.executionPromise;
      }

      const run = async (): Promise<{ suspendedAsk?: { ask: AskRequest; toolCallId: string; roundIndex: number } } | null> => {
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        const toolDef = toolsMap?.[toolName];
        const summary = generateToolSummary(
          agentName,
          toolName,
          args,
          toolDef?.summaryTemplate ?? "",
        );

        onToolCall?.(agentName, toolName, args, summary);

        let toolOutput: ToolResult | string;
        const execStartMs = Date.now();
        try {
          let preflight: ToolPreflightDecision | void = undefined;
          if (beforeToolExecute) {
            preflight = await beforeToolExecute({
              agentName,
              toolName,
              toolArgs: args,
              toolCallId: callId,
              summary,
            });
          }

          if (preflight && preflight.kind === "ask") {
            const ask = preflight.ask;
            ask.payload.toolCallId = callId;
            ask.roundIndex = roundIndex;
            return { suspendedAsk: { ask, toolCallId: callId, roundIndex } };
          }

          pending.execPhase = "running";
          pending.streamPhase = "closed";
          syncToolCallEntry(callId);

          if (fatalParseError) {
            toolOutput = new ToolResultClass({
              content: `ERROR: ${fatalParseError}`,
            });
          } else if (preflight && preflight.kind === "deny") {
            toolOutput = new ToolResultClass({
              content: `ERROR: ${preflight.message}`,
            });
          } else if (toolName in toolExecutors) {
            toolOutput = await toolExecutors[toolName](args, { signal });
          } else if (builtinExecutor) {
            toolOutput = await builtinExecutor(toolName, args, { signal });
          } else {
            toolOutput = new ToolResultClass({
              content: `ERROR: No executor found for tool '${toolName}'`,
            });
          }
        } catch (e) {
          if ((e as any)?.name === "AskPendingError") {
            const ask = (e as { ask?: AskRequest }).ask;
            if (ask) {
              ask.payload.toolCallId = callId;
              ask.roundIndex = roundIndex;
              return { suspendedAsk: { ask, toolCallId: callId, roundIndex } };
            }
            throw e;
          }
          if ((e as any)?.name === "AbortError" || signal?.aborted) {
            throw e;
          }
          console.error(`[${agentName}] tool '${toolName}' raised:`, e);
          toolOutput = new ToolResultClass({
            content: `ERROR: Tool execution failed 鈥?${e}`,
          });
        }

        // Re-check abort after executor returns: most tools don't listen
        // to the signal and will run to their natural exit. If the turn
        // was aborted while they were running, we must not synthesize a
        // tool_result 鈥?the interrupt cascade owns log normalization.
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        const resolved: ToolResultClass =
          typeof toolOutput === "string"
            ? new ToolResultClass({ content: toolOutput })
            : toolOutput instanceof ToolResultClass
              ? toolOutput
              : new ToolResultClass({ content: String(toolOutput) });

        let resultStr = resolved.content;
        if (getNotification) {
          const note = getNotification();
          if (note) resultStr += note;
        }

        const toolEntry: Record<string, unknown> = {
          tool: toolName,
          arguments: args,
          result: resultStr,
        };
        if (resolved.actionHint) toolEntry["action_hint"] = resolved.actionHint;
        if (resolved.tags.length > 0) toolEntry["tags"] = resolved.tags;
        if (Object.keys(resolved.metadata).length > 0) {
          toolEntry["tool_metadata"] = resolved.metadata;
        }
        toolHistory.push(toolEntry);

        const mergedMetadata = { ...resolved.metadata };
        if (resolved.contentBlocks) {
          mergedMetadata._contentBlocks = resolved.contentBlocks;
        }
        const isError = resolved.content.startsWith("ERROR:");
        if (pending.tuiVisibility === "hide" && isError) {
          pending.tuiVisibility = "show";
          syncToolCallEntry(callId);
        }
        const preview = extractToolPreview(resolved.metadata);
        // Auto-preview: when tool didn't set explicit tui_preview, use result
        // text directly (capped to avoid bloating log entries). The TUI layer
        // controls final display truncation via profile maxLines.
        let previewText = preview?.text;
        let previewDim = preview?.dim;
        if (!previewText && !isError) {
          // Cap at ~20 lines to keep log entry display field reasonable
          const lines = resultStr.split("\n");
          previewText = lines.length > 20
            ? lines.slice(0, 20).join("\n") + `\n... (${lines.length - 20} more lines)`
            : resultStr;
          previewDim = true;
        }
        const toolResultEntry = createToolResultEntry(
          allocId("tool_result"),
          turnIndex,
          roundIndex,
          {
            toolCallId: callId,
            toolName,
            content: resultStr,
            toolSummary: summary,
          },
          {
            isError,
            contextId: pending?.contextId ?? ensureRoundContextId(),
            toolMetadata: mergedMetadata,
            execStartMs,
            previewText,
            previewDim,
          },
        );
        if (pending.tuiVisibility === "hide" && !isError) {
          toolResultEntry.tuiVisible = false;
          toolResultEntry.displayKind = null;
        }
        appendEntry(toolResultEntry);
        if (onSaveCheckpoint) onSaveCheckpoint();
        onToolResult?.(agentName, toolName, callId, resolved.content.startsWith("ERROR:"), summary);

        pending.execPhase = resolved.content.startsWith("ERROR:") ? "failed" : "completed";
        syncToolCallEntry(callId);
        return null;
      };

      const promise = run();
      pending.executionPromise = promise;
      return promise;
    };

    const closeCommittedToolCall = (tc: ToolCall): void => {
      const pending = ensurePendingToolCall(tc.id, tc.name);
      pending.rawArguments = tc.rawArguments;
      pending.completeTopLevelArgs = {
        ...pending.completeTopLevelArgs,
        ...tc.arguments,
      };
      pending.closedCall = tc;

      const closedStreamable = buildStreamableToolCall(
        pending.name,
        tc.rawArguments || JSON.stringify(tc.arguments ?? {}),
      );
      if (closedStreamable) {
        pending.sections = closedStreamable.sections;
        pending.canonicalArgs = closedStreamable.canonicalArgs;
        // When provider sends full args at once without partial deltas,
        // recordPartialToolCall is never called 鈥?backfill stream metadata here.
        if (closedStreamable.language) pending.streamLanguage = closedStreamable.language;
        if (closedStreamable.streamMode) pending.streamMode = closedStreamable.streamMode;
        probeEditContext(pending, closedStreamable);
      }
      pending.tuiVisibility = resolvePendingToolVisibility(pending, true);
      pending.streamPhase = "closed";
      syncToolCallEntry(tc.id);
      // Note: do NOT start execution here. Tool execution is sequential in
      // emission order, drained after streaming completes (see post-streaming
      // drain below). This is required for correct approval semantics 鈥?      // a pending approval on tool b must block c, d, etc.
    };

    let wrappedToolCallPartial: ((callId: string, name: string, rawArguments: string) => void) | undefined;
    let wrappedToolCallClosed: ((call: ToolCall) => void) | undefined;
    let suspendedAskResult: { ask: AskRequest; toolCallId: string; roundIndex: number } | undefined;
    if (onToolCallPartialOpt) {
      wrappedToolCallPartial = (callId: string, name: string, rawArguments: string) => {
        onToolCallPartialOpt!(callId, name, rawArguments);
        recordPartialToolCall(callId, name, rawArguments);
      };
    }
    wrappedToolCallClosed = (call: ToolCall) => {
      closeCommittedToolCall(call);
    };

    let resp: ProviderResponse;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      try {
        resp = await provider.asyncSendMessage(
          getMessages() as any,
          tools?.length ? tools : undefined,
          {
            onTextChunk: wrappedChunk,
            onReasoningChunk: wrappedReasoningChunk,
            onToolCallPartial: wrappedToolCallPartial,
            onToolCallClosed: wrappedToolCallClosed,
            signal,
            thinkingLevel,
            promptCacheKey,
          },
        );
        if (networkRetryCount > 0) {
          onRetrySuccess?.(networkRetryCount);
          networkRetryCount = 0;
        }
        break;
      } catch (netErr) {
        if ((netErr as any)?.name === "AbortError" || signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (!isRetryableNetworkError(netErr) || networkRetryCount >= MAX_NETWORK_RETRIES) {
          if (isRetryableNetworkError(netErr)) {
            const errMsg = netErr instanceof Error ? netErr.message : String(netErr);
            onRetryExhausted?.(MAX_NETWORK_RETRIES, errMsg);
          }
          throw netErr;
        }
        networkRetryCount++;
        if (discardEntry) {
          for (const [, pending] of pendingToolCalls) {
            if (pending.entryId) discardEntry(pending.entryId);
          }
        }
        pendingToolCalls.clear();
        const errMsg = netErr instanceof Error ? netErr.message : String(netErr);
        const delay = computeRetryDelay(networkRetryCount - 1);
        const delaySec = Math.round(delay / 1000);
        onRetryAttempt?.(networkRetryCount, MAX_NETWORK_RETRIES, delaySec, errMsg);
        await retrySleep(delay, signal);
      }
    }

    lastInput = resp.usage.inputTokens;
    totalInput += resp.usage.inputTokens;
    totalOutput += resp.usage.outputTokens;

    if (onTokenUpdate) {
      onTokenUpdate(lastInput, resp.usage);
    }

    if (resp.toolCalls.length > 0) {
      throw new Error("Provider returned final-response toolCalls; tool-loop expects canonical streamed tool_call_closed events only.");
    }

    const hasCommittedToolCalls = Array.from(pendingToolCalls.values()).some((pending) =>
      Boolean(pending.closedCall),
    );

    // Compact check after each provider call
    let compactTriggered = false;
    let compactScenario: "mid_turn" | undefined;

    if (compactCheck) {
      const check = compactCheck(
        resp.usage.inputTokens,
        resp.usage.outputTokens,
        hasCommittedToolCalls,
      );
      if (check?.compactNeeded) {
        compactTriggered = true;
        compactScenario = check.scenario;
      }
    }

    // Fallback: emit text as single chunk if provider didn't stream
    if (resp.text && onTextChunk && !providerStreamedText) {
      textHandledViaCallback = onTextChunk(roundIndex, resp.text) === true || textHandledViaCallback;
    }

    if (resp.reasoningContent && onReasoningChunk && !providerStreamedReasoning) {
      reasoningHandledViaCallback =
        onReasoningChunk(roundIndex, resp.reasoningContent) === true || reasoningHandledViaCallback;
    }

    // Signal reasoning complete (whether streamed or returned in final response)
    if ((resp.reasoningContent || providerStreamedReasoning) && onReasoningDone) {
      onReasoningDone(roundIndex, resp.thinkingArtifact, resp.reasoningState);
    }

    if (resp.text) {
      hadStreamedText = true;
    }

    if (!hasCommittedToolCalls) {
      // No tool calls 鈥?return final result.
      // The caller (Session) is responsible for creating the final
      // assistant_text / reasoning / no_reply entries.
      return {
        text: resp.text,
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: resp.reasoningContent,
        reasoningState: resp.reasoningState,
        thinkingArtifact: resp.thinkingArtifact,
        lastRoundId: lastRoundId,
        compactNeeded: false,
        compactScenario: undefined,
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
        endedWithoutToolCalls: true,
      };
    }

    // Track reasoning from each round (used in max-rounds fallback)
    lastReasoningContent = resp.reasoningContent;
    lastReasoningState = resp.reasoningState;
    lastThinkingArtifact = resp.thinkingArtifact ?? null;

    // Context ID: allocate a flat ID per round
    if (contextIdAllocator) {
      lastRoundId = contextIdAllocator(roundIndex);
    }

    // --- Create entries for this round ---

    // Reasoning entry
    if (resp.reasoningContent && !(streamCallbacksOwnEntries && reasoningHandledViaCallback)) {
      appendEntry(createReasoning(
        allocId("reasoning"),
        turnIndex,
        roundIndex,
        resp.reasoningContent,
        resp.reasoningContent,
        resp.reasoningState,
        lastRoundId,
        resp.thinkingArtifact,
      ));
    }

    // Intermediate assistant text entry (text alongside tool_calls)
    if (resp.text && !(streamCallbacksOwnEntries && textHandledViaCallback)) {
      intermediateText.push(resp.text);
      appendEntry(createAssistantText(
        allocId("assistant_text"),
        turnIndex,
        roundIndex,
        resp.text,
        resp.text,
        lastRoundId,
      ));
    }

    // Sequential drain: execute committed tool calls IN EMISSION ORDER.
    // Maps preserve insertion order, so iterating pendingToolCalls gives us
    // the order tool_calls were emitted by the model. On any suspendedAsk,
    // we stop 鈥?remaining tool_calls become orphans (still in log with
    // toolExecState: "not_started") and Session resumes them after approval.
    for (const [callId, pending] of pendingToolCalls) {
      if (!pending.name || !pending.closedCall) continue;
      if (pending.execPhase === "completed" || pending.execPhase === "failed") continue;
      const result = await executeResolvedToolCall(
        callId,
        pending.name,
        pending.closedCall.arguments,
        pending.closedCall.parseError ?? undefined,
      );
      if (result?.suspendedAsk) {
        suspendedAskResult = result.suspendedAsk;
        break;
      }
    }
    pendingToolCalls.clear();

    // Tool round complete: all tool_results for this round are written.
    // Drain queued messages (e.g. user input) before the next model call.
    if (onToolRoundComplete && !suspendedAskResult) {
      onToolRoundComplete();
    }

    if (suspendedAskResult) {
      return {
        text: resp.text || "",
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: resp.reasoningContent,
        reasoningState: resp.reasoningState,
        thinkingArtifact: resp.thinkingArtifact,
        lastRoundId: lastRoundId,
        compactNeeded: false,
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
        suspendedAsk: suspendedAskResult,
      };
    }

    // After all tool calls executed: if compact was triggered, return early
    if (compactTriggered) {
      return {
        text: resp.text || "",
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: lastReasoningContent,
        reasoningState: lastReasoningState,
        thinkingArtifact: lastThinkingArtifact,
        lastRoundId: lastRoundId,
        compactNeeded: true,
        compactScenario: "mid_turn",
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
      };
    }
  }

  console.warn(`[${agentName}] hit max tool rounds (${maxRounds})`);
  return {
    text: "(Agent reached maximum tool call rounds without completing.)",
    toolHistory,
    totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
    intermediateText,
    lastInputTokens: lastInput,
    reasoningContent: lastReasoningContent,
    reasoningState: lastReasoningState,
    thinkingArtifact: lastThinkingArtifact,
    lastRoundId: lastRoundId,
    lastTotalTokens: totalInput + totalOutput,
    textHandledInLog: false,
    reasoningHandledInLog: false,
  };
}
