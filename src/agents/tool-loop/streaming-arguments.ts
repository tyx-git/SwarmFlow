import type { AskRequest } from "../../ask.js";

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
 *   执行状态、TUI 可见性）
 * - 顺序排出：已提交的 tool call 按发射顺序执行；挂起的 ask 暂停排出，
 *   以保证审批语义正确
 * - Compact：可在任意 provider 调用后触发中途压缩，返回 compactNeeded=true
 */

import type { ToolCall } from "../../providers/types.js";

import { type ToolCallTuiVisibility } from "./types.js";

/** 工具调用流式阶段：隐藏部分 -> 可见部分 -> 关闭 */
type PendingToolStreamPhase = "hidden_partial" | "visible_partial" | "closed";

/** 工具调用执行阶段：未开始 -> 运行中 -> 完成 / 失败 */
type PendingToolExecPhase = "not_started" | "running" | "completed" | "failed";

export interface PendingToolCallState {
  name: string;
  rawArguments: string;
  entryId: string | null;
  completeTopLevelArgs: Record<string, unknown>;
  closedCall: ToolCall | null;
  executionPromise: Promise<{ suspendedAsk?: { ask: AskRequest; toolCallId: string; roundIndex: number } } | null> | null;
  /** 零参数 edit 的补丁正文；执行后立即清除。 */
  executionPayload?: string;
  streamPhase: PendingToolStreamPhase;
  execPhase: PendingToolExecPhase;
  tuiVisibility: ToolCallTuiVisibility;
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
