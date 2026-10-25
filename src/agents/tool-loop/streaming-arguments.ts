import type { AskRequest } from "../../ask.js";
import { type EditProbeState, inferLanguageByExt } from "../../patches/hunk.js";

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

import type { ToolCall } from "../../providers/types.js";

import { type ToolCallTuiVisibility } from "./types.js";

export interface ToolStreamSection {
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

export interface StreamableToolCall {
  canonicalArgs: Record<string, unknown>;
  sections: ToolStreamSection[];
  language?: string;
  streamMode?: StreamMode;
}

/** 工具调用流式阶段：隐藏部分 -> 可见部分 -> 关闭 */
type PendingToolStreamPhase = "hidden_partial" | "visible_partial" | "closed";

/** 工具调用执行阶段：未开始 -> 运行中 -> 完成 / 失败 */
type PendingToolExecPhase = "not_started" | "running" | "completed" | "failed";

export interface PendingToolCallState {
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
  /** 上次解析/同步流式参数的时间；用于把每 chunk 的重建压到 ~100ms 一次。 */
  lastPartialParseAt?: number;
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
export function parsePartialFlatObject(input: string): Record<string, ParsedPartialField> {
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
export function extractCompleteFlatArgs(
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
export function buildStreamableToolCall(
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
