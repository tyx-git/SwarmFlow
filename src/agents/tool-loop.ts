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
  buildAppendDisplayData,
  buildWriteDisplayData,
} from "../lib/diff-hunk.js";

// ------------------------------------------------------------------
// 工具执行器类型
// ------------------------------------------------------------------

import type { ToolExecutor, ToolExecutorContext } from "../tools/executor-types.js";
export type { ToolExecutor, ToolExecutorContext };

// ------------------------------------------------------------------
// 工具摘要 / 显示帮助函数
// ------------------------------------------------------------------

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

/** 从工具结果的 metadata 中提取 tui_preview。 */
function extractToolPreview(metadata: Record<string, unknown>): { text: string; dim?: boolean } | null {
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

/** 工具调用流式阶段：隐藏部分 -> 可见部分 -> 关闭 */
type PendingToolStreamPhase = "hidden_partial" | "visible_partial" | "closed";
/** 工具调用执行阶段：未开始 -> 运行中 -> 完成 / 失败 */
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
  // 上下文探测（edit_file replace / append 模式）
  cachedFileContent?: string;
  cachedTotalLineCount?: number;
  /** 每个编辑的探测状态（单编辑=1个元素，多编辑=N个元素）。 */
  editProbes?: EditProbeState[];
  appendStartLine?: number;
  // 流式显示提示
  streamLanguage?: string;
  streamMode?: StreamMode;
  contextId?: string;
}

interface ParsedPartialField {
  value: string | number | boolean | null;
  complete: boolean;
  kind: "string" | "number" | "boolean" | "null";
}

/** 修剪不完整的 Unicode 转义后缀（防止 JSON.parse 失败）。 */
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

/** 将 JSON 字符串片段解码为实际字符串。 */
function decodeJsonStringFragment(raw: string): string {
  const sanitized = trimIncompleteEscapeSuffix(raw);
  try {
    return JSON.parse(`"${sanitized}"`) as string;
  } catch {
    return sanitized;
  }
}

/** 跳过空白字符。 */
function skipWhitespace(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
  return cursor;
}

/** 读取引号内的字符串 token，支持 Unicode 转义。 */
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

/** 读取字面量 token（数字、布尔、null）。 */
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

/**
 * 增量解析不完整 JSON 对象。
 * 返回每个字段的值、类型、以及是否已完成解析。
 * 用于流式传输场景——provider 逐片段发送参数。
 */
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

/** 从解析结果中提取已完成的参数。 */
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

/** 提取可选参数的已完成字段。 */
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
// 部分 edits 数组解析器（支持多编辑流式传输）
// ------------------------------------------------------------------

interface ParsedEditItem {
  old_str: ParsedPartialField | null;
  new_str: ParsedPartialField | null;
  complete: boolean;
}

/** 解析 edits 数组（可能为多编辑）。 */
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

    // 解析单个 { old_str: "...", new_str: "..." } 对象
    const innerFields = parsePartialFlatObject(input.slice(cursor));
    // 找到闭合 } 以判断编辑项是否完整
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

/**
 * 从原始参数缓冲区构建 StreamableToolCall。
 * 仅处理 write_file 和 edit_file，返回 null 表示不适用。
 */
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

    // edits 数组（可能与 append 组合）
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

    // 仅 append（无 edits 数组）
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

/** 构建工具调用的 metadata 对象。 */
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

/** 根据 ToolDef.tuiPolicy.partialReveal 解析工具调用默认可见性。 */
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

/**
 * asyncRunToolLoop 的返回值。包含调用方（通常是 Session）
 * 构建日志条目和决定下一步所需的一切。
 */
export interface ToolLoopResult {
  text: string;
  toolHistory: Array<Record<string, unknown>>;
  totalUsage: { inputTokens: number; outputTokens: number };
  intermediateText: string[];
  lastInputTokens: number;
  reasoningContent: string;
  reasoningState: unknown;
  thinkingArtifact?: ThinkingArtifact | null;
  /** 最后一个 tool-call round 的扁平 context_id（无 tool call 时为 undefined）。 */
  lastRoundId?: string;
  /** 是否触发了中途压缩（提前返回）。 */
  compactNeeded?: boolean;
  compactScenario?: "mid_turn";
  lastTotalTokens?: number;
  /** 流式回调是否已写入最终文本条目。 */
  textHandledInLog?: boolean;
  /** 流式回调是否已写入最终推理条目。 */
  reasoningHandledInLog?: boolean;
  /** 模型本轮返回无 tool call 时为 true。 */
  endedWithoutToolCalls?: boolean;
  /** 模型调用了 ask 工具、需要用户输入才能继续时设置。 */
  suspendedAsk?: {
    ask: AskRequest;
    toolCallId: string;
    roundIndex: number;
  };
}

// ------------------------------------------------------------------
// 回调类型
// ------------------------------------------------------------------

/** 工具调用前的回调。 */
export type OnToolCallCallback = (
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summary: string,
) => void;

/** 工具结果返回后的回调。 */
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

/** 工具预检决定：放行、拒绝、或暂停询问用户。 */
export type ToolPreflightDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; ask: AskRequest };

/** 工具执行前的预检钩子（可返回 allow/deny/ask）。 */
export type BeforeToolExecuteCallback = (
  ctx: ToolPreflightContext,
) => ToolPreflightDecision | void | Promise<ToolPreflightDecision | void>;

/** TUI 中工具调用的可见性状态。 */
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

/** 解析工具调用可见性的回调。 */
export type ResolveToolCallVisibilityCallback = (
  ctx: ToolCallVisibilityContext,
) => ToolCallTuiVisibility | void;

// ------------------------------------------------------------------
// asyncRunToolLoop
// ------------------------------------------------------------------

export interface ToolLoopOptions {
  provider: BaseProvider;
  /**
   * 返回当前 API 消息序列。每次 provider 调用前都会调用。
   * 主 Agent：从 _log 投影；子 Agent：返回本地数组。
   */
  getMessages: () => Array<Record<string, unknown>>;
  /**
   * 追加 LogEntry 到后端存储。
   * 主 Agent：追加到 _log；子 Agent：转换为原始消息并推送。
   */
  appendEntry: (entry: LogEntry) => void;
  /** 分配下一个条目 ID。 */
  allocId: (type: LogEntry["type"]) => string;
  /** 当前 turn 索引（用于创建条目）。 */
  turnIndex: number;
  /** 当前 turn 内的基础 round 索引。 */
  baseRoundIndex?: number;
  tools?: ToolDef[];
  toolExecutors: Record<string, ToolExecutor>;
  maxRounds: number;
  agentName?: string;
  onToolCall?: OnToolCallCallback;
  onToolResult?: OnToolResultCallback;
  toolsMap?: Record<string, ToolDef>;
  /** 流式文本块回调。返回 true 表示已处理（不再需要默认处理）。 */
  onTextChunk?: (roundIndex: number, chunk: string) => boolean | void;
  /** 流式推理内容回调。返回 true 表示已处理。 */
  onReasoningChunk?: (roundIndex: number, chunk: string) => boolean | void;
  /** 一轮的推理内容全部接收完毕后调用。 */
  onReasoningDone?: (
    roundIndex: number,
    thinkingArtifact?: ThinkingArtifact | null,
    reasoningState?: unknown,
  ) => void;
  /** 未在 toolExecutors 中找到时的内置执行器回退。 */
  builtinExecutor?: (
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolExecutorContext,
  ) => Promise<ToolResult | string>;
  /** 中断信号。 */
  signal?: AbortSignal;
  /** 为 round 分配 context_id（用于 text/reasoning）。 */
  contextIdAllocator?: (roundIndex: number) => string;
  /** 为每个 tool_call 分配独立的 context_id。 */
  toolContextIdAllocator?: () => string;
  /** 每次 provider 响应后调用，报告最新输入 token 数和完整使用量。 */
  onTokenUpdate?: (inputTokens: number, usage?: import("../providers/base.js").Usage) => void;
  /**
   * 每次 provider 调用后检查是否需要压缩。
   * 返回 null 表示跳过检查（如子 Agent）。
   */
  compactCheck?: (
    inputTokens: number,
    outputTokens: number,
    hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null;
  /** 统一思考深度覆盖（传递给 provider）。 */
  thinkingLevel?: string;
  /** OpenAI prompt cache 亲和路由键（如子会话 ID）。 */
  promptCacheKey?: string;
  /** 每次 tool_result 追加后调用，用于增量持久化。 */
  onSaveCheckpoint?: () => void;
  /** 工具执行前的预检门禁（可询问/暂停/拒绝）。 */
  beforeToolExecute?: BeforeToolExecuteCallback;
  /** 返回要追加到 tool_result 内容的通知字符串，无则返回 null。 */
  getNotification?: () => string | null;
  /** 一轮所有 tool_result 写完后、下一轮模型调用前调用。
   *  Session 用此耗尽队列中的收件消息。 */
  onToolRoundComplete?: () => void;
  /** 为 true 时，流式 text/reasoning 回调拥有对应的日志条目。 */
  streamCallbacksOwnEntries?: boolean;
  /** 检测到网络错误并重试时调用。 */
  onRetryAttempt?: (attempt: number, maxRetries: number, delaySec: number, errMsg: string) => void;
  /** 重试的网络调用成功时调用。 */
  onRetrySuccess?: (attempt: number) => void;
  /** 所有网络重试耗尽时调用。 */
  onRetryExhausted?: (maxRetries: number, errMsg: string) => void;
  /** 工具调用参数演进时调用；provider 传递最新原始参数缓冲区。 */
  onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
  /** 解析工具调用在 TUI 中是延迟、显示还是隐藏。 */
  resolveToolCallVisibility?: ResolveToolCallVisibilityCallback;
  /**
   * 判断文件路径是否为会话 plan 文件。
   * 若是，写/编辑该文件时 tool_call 条目会被标记为 planFileOperation，
   * TUI 将其重标签为"Update Todos"。在 path 参数已知后检查。
   */
  isPlanFilePath?: (filePath: string) => boolean;
  /** 就地更新已有日志条目（用于最终化 pending tool call 条目）。 */
  updateEntry?: (entryId: string, patch: {
    apiRole?: LogEntry["apiRole"];
    content?: unknown;
    display?: string;
    tuiVisible?: boolean;
    displayKind?: LogEntry["displayKind"];
    meta?: Record<string, unknown>;
  }) => void;
  /** 将日志条目标记为已丢弃（重试时清理）。 */
  discardEntry?: (entryId: string) => void;
}

/**
 * 异步工具循环：调用 LLM，执行工具，重复直到完成。
 *
 * 工具执行器接收参数字典，可能是同步或异步的。
 * 异常被捕获并作为错误 ToolResult 内容返回。
 */
export async function asyncRunToolLoop(
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  // 诊断：在主要循环入口加 trace，便于 native panic 时关联最后调用栈。
  try {
    const { getLogger } = await import("../lib/logger.js");
    getLogger("tool-loop").info("asyncRunToolLoop:enter", {
      agent: opts.agentName,
      turn: opts.turnIndex,
      tools: opts.tools?.length ?? 0,
      maxRounds: opts.maxRounds,
    });
  } catch { /* logger not initialized */ }
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
  let totalInput = 0;
  let totalOutput = 0;
  let lastInput = 0;
  let lastReasoningContent = "";
  let lastReasoningState: unknown = null;
  let lastThinkingArtifact: ThinkingArtifact | null = null;

  // 每个 tool-call round 的扁平 context ID
  let lastRoundId: string | undefined;

  // 跨 round 的网络重试计数器（连续失败计数）
  let networkRetryCount = 0;

  for (let roundIdx = 0; roundIdx < maxRounds; roundIdx++) {
    const roundIndex = baseRoundIndex + roundIdx;
    // 每次 provider 调用前检查中断
    if (signal?.aborted) {
      throw new DOMException("操作已被中止。", "AbortError");
    }

    // 追踪 provider 是否调用了 onTextChunk（流式传输）
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

    // 追踪进行中的 tool call
    const pendingToolCalls = new Map<string, PendingToolCallState>();

    /** 获取或创建 PendingToolCallState。 */
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

    /** 从 pending 状态获取工具参数（优先 closedCall > canonicalArgs > completeTopLevelArgs）。 */
    const getToolArgsForEntry = (pending: PendingToolCallState): Record<string, unknown> | null => {
      return pending.closedCall?.arguments ?? pending.canonicalArgs ?? pending.completeTopLevelArgs ?? {};
    };

    /** 解析 pending tool call 的 TUI 可见性。 */
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

    /** 从 pending 状态派生 ToolStreamSection 数组。 */
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
      // 当 provider 一次性发送完整参数而没有流式增量时，回填语言/模式
      if (!pending.streamLanguage && streamable.language) pending.streamLanguage = streamable.language;
      if (!pending.streamMode && streamable.streamMode) pending.streamMode = streamable.streamMode;
      pending.sections = streamable.sections;
      probeEditContext(pending, streamable);
      return pending.sections;
    };

    /** 从 pending 状态派生流式状态字符串。 */
    const deriveToolStreamState = (pending: PendingToolCallState): string | undefined => {
      if (pending.streamPhase === "hidden_partial") return undefined;
      if (pending.streamPhase === "visible_partial") return "partial";
      return "closed";
    };

    /** 构建工具调用的内容对象（用于日志条目）。 */
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

    /**
     * 同步 tool_call 日志条目。
     * 若是新建则追加条目，若是更新则调用 updateEntry。
     */
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
      // 当 path 已知且为 plan 文件时，标记为 planFileOperation
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

    /**
     * 探测 edit_file 上下文：在流式传输 old_str 时读取目标文件，
     * 解析匹配位置以提供"修改前"视图的上下文（行号、周围代码）。
     */
    const probeEditContext = (
      pending: PendingToolCallState,
      streamable: StreamableToolCall,
    ): void => {
      if (streamable.streamMode !== "replace" && streamable.streamMode !== "append") return;

      const filePath = streamable.canonicalArgs.path as string | undefined;
      if (!filePath) return;

      // 读取并缓存文件内容（replace 和 append 共用）
      if (pending.cachedFileContent === undefined) {
        try {
          if (existsSync(filePath)) {
            pending.cachedFileContent = readFileSync(filePath, "utf-8");
            pending.cachedTotalLineCount = countFileLines(pending.cachedFileContent);
          }
        } catch { /* skip */ }
        if (pending.cachedFileContent === undefined) {
          pending.cachedFileContent = ""; // 标记为已尝试
          return;
        }
      }
      if (!pending.cachedFileContent) return;

      // --- append 模式 ---
      if (streamable.streamMode === "append") {
        if (pending.appendStartLine === undefined) {
          pending.appendStartLine = (pending.cachedTotalLineCount ?? 0) + 1;
        }
        return;
      }

      // --- replace 模式（单编辑或多编辑） ---
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

        // 仅在 old_str 至少有一个换行（或已完整）时探测
        if (!pair.oldText.includes("\n") && !pair.oldComplete) continue;

        // 首次解析：查找唯一匹配
        if (!probe.resolved) {
          const idx = fc.indexOf(pair.oldText);
          if (idx === -1) continue;
          if (fc.indexOf(pair.oldText, idx + 1) !== -1) continue;

          probe.resolved = true;
          probe.matchOffset = idx;
          probe.startLine = fc.substring(0, idx).split("\n").length;
          probe.contextBefore = computeContextBefore(fc, idx, 3);
        }

        // old_str 完整时计算 contextAfter
        if (pair.oldComplete && probe.resolved && !probe.contextAfter) {
          const matchEnd = probe.matchOffset! + pair.oldText.length;
          probe.contextAfter = computeContextAfter(fc, matchEnd, 3);
        }
      }
    };

    /** 从 pending 状态构建 FileModifyDisplayData，用于注入 metadata。 */
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

      // Replace 模式：从 editProbes 构建 hunks
      if (!pending.editProbes || pending.editProbes.length === 0) return undefined;

      const hunks: DiffHunk[] = [];
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

    /**
     * 记录部分 tool call（参数仍在流式传输中）。
     * 解析参数、构建 sections、探测编辑上下文、更新 TUI 可见性。
     */
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

    /**
     * 执行已解析的 tool call。
     * 包含预检、信号处理、执行、结果记录。
     * 返回 suspendedAsk 表示需要用户输入以继续。
     */
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
          throw new DOMException("操作已被中止。", "AbortError");
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
          console.error(`[${agentName}] 工具 '${toolName}' 抛出异常:`, e);
          toolOutput = new ToolResultClass({
            content: `ERROR: 工具执行失败 — ${e}`,
          });
        }

        // 执行器返回后再次检查中止信号
        if (signal?.aborted) {
          throw new DOMException("操作已被中止。", "AbortError");
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
        // 自动预览：工具未设置显式 tui_preview 时，直接使用结果文本
        let previewText = preview?.text;
        let previewDim = preview?.dim;
        if (!previewText && !isError) {
          // 限制约 20 行以保持日志条目 display 字段合理
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

    /**
     * 关闭已提交的 tool call（参数流式传输完毕）。
     * 注意：不在此处开始执行，工具执行在流式传输完成后统一排出
     *（见流式传输后的 drain）。这保证审批语义——工具 b 的待处理审批
     * 必须阻塞 c、d 等。
     */
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
        // 当 provider 一次性发送完整参数时（无流式增量），在此回填流式元数据
        if (closedStreamable.language) pending.streamLanguage = closedStreamable.language;
        if (closedStreamable.streamMode) pending.streamMode = closedStreamable.streamMode;
        probeEditContext(pending, closedStreamable);
      }
      pending.tuiVisibility = resolvePendingToolVisibility(pending, true);
      pending.streamPhase = "closed";
      syncToolCallEntry(tc.id);
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
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("操作已被中止。", "AbortError");
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
          throw new DOMException("操作已被中止。", "AbortError");
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
      throw new Error("Provider 返回了 final-response toolCalls；tool-loop 期望仅接收规范流式 tool_call_closed 事件。");
    }

    const hasCommittedToolCalls = Array.from(pendingToolCalls.values()).some((pending) =>
      Boolean(pending.closedCall),
    );

    // 每次 provider 调用后检查是否需要压缩
    let compactTriggered = false;

    if (compactCheck) {
      const check = compactCheck(
        resp.usage.inputTokens,
        resp.usage.outputTokens,
        hasCommittedToolCalls,
      );
      if (check?.compactNeeded) {
        compactTriggered = true;
      }
    }

    // 非流式时的文本回退
    if (resp.text && onTextChunk && !providerStreamedText) {
      textHandledViaCallback = onTextChunk(roundIndex, resp.text) === true || textHandledViaCallback;
    }

    if (resp.reasoningContent && onReasoningChunk && !providerStreamedReasoning) {
      reasoningHandledViaCallback =
        onReasoningChunk(roundIndex, resp.reasoningContent) === true || reasoningHandledViaCallback;
    }

    // 通知推理内容完毕（无论流式或最终响应返回）
    if ((resp.reasoningContent || providerStreamedReasoning) && onReasoningDone) {
      onReasoningDone(roundIndex, resp.thinkingArtifact, resp.reasoningState);
    }

    if (!hasCommittedToolCalls) {
      // 无 tool call — 返回最终结果。
      // 调用方（Session）负责创建最终的 assistant_text / reasoning / no_reply 条目。
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

    // 追踪每轮的推理内容（用于 max-rounds 回退）
    lastReasoningContent = resp.reasoningContent;
    lastReasoningState = resp.reasoningState;
    lastThinkingArtifact = resp.thinkingArtifact ?? null;

    // 为 round 分配扁平 context ID
    if (contextIdAllocator) {
      lastRoundId = contextIdAllocator(roundIndex);
    }

    // --- 为本轮创建条目 ---

    // 推理条目
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

    // 中间助手文本条目（与 tool_calls 伴随的文本）
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

    // 顺序排出：按发射顺序执行已提交的 tool call。
    // Map 保持插入顺序，迭代即得到模型发射顺序。
    // 遇到 suspendedAsk 时停止 — 剩余 tool call 成为孤儿
    //（仍在日志中，execPhase: "not_started"），Session 审批后恢复。
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

    // 工具轮次结束：所有 tool_result 已写入。
    // 下一轮模型调用前耗尽队列中的消息。
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

    // 所有工具调用执行完毕后：若触发了压缩，提前返回
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

  console.warn(`[${agentName}] 达到最大工具调用轮数 (${maxRounds})`);
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
