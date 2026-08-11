/**
 * 上下文标签和消息整形工具——由基于日志的运行时共享。
 *
 * 提供：
 *  - 压缩标记常量和类型守卫
 *  - 上下文 ID 注入工具
 *  - 连续同角色合并（用于提供商特定的交替规则）
 */

import { randomBytes } from "node:crypto";

// ------------------------------------------------------------------
// Compact marker
// ------------------------------------------------------------------

/** 对话数组中压缩标记使用的哨兵角色 */
export const COMPACT_MARKER_ROLE = "__compact_marker";

/** 类似提供商消息投影中的压缩标记形状 */
export interface CompactMarker {
  role: typeof COMPACT_MARKER_ROLE;
  marker_type: "plan_advance" | "auto_compact" | "context_reset";
  timestamp: number;
}

/** 类型守卫：此消息是否为压缩标记？ */
export function isCompactMarker(msg: Record<string, unknown>): boolean {
  return msg["role"] === COMPACT_MARKER_ROLE;
}

// ------------------------------------------------------------------
// Context ID
// ------------------------------------------------------------------

/** 存储在消息上的上下文 ID 的元数据字段名 */
export const CONTEXT_ID_KEY = "_context_id";

/**
 * 分配唯一的随机十六进制上下文 ID（4 个十六进制字符）。
 * 碰撞时重试（最多 10 次），然后回退到 6 个十六进制字符。
 */
export function allocateContextId(usedIds: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = randomBytes(2).toString("hex");
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  // Fallback to 6 hex chars
  const id = randomBytes(3).toString("hex");
  usedIds.add(id);
  return id;
}

/** 将上下文 ID 格式化为注入标签：`§{contextId}§` */
const CONTEXT_TAG_DELIMITER = "§";

export function formatContextTag(contextId: string): string {
  return `${CONTEXT_TAG_DELIMITER}{${contextId}}${CONTEXT_TAG_DELIMITER}`;
}

/** 匹配任何 `§{...}§` 上下文标签的正则表达式，包含可选的尾随换行符（全局） */
export const CONTEXT_TAG_REGEX = /§\{[^}]*\}§\n?/g;

/** 从文本中剥离所有 `§{...}§` 上下文标签（及其尾随换行符） */
export function stripContextTags(text: string): string {
  return text.replace(CONTEXT_TAG_REGEX, "");
}

// ------------------------------------------------------------------
// ContextTagStripBuffer——流式剥离 §{...}§ 标签
// ------------------------------------------------------------------

/**
 * 缓冲流式文本以剥离模型可能产生的 `§{...}§` 上下文标签。
 * 遇到 `§` 时开始缓冲。如果缓冲区完成 `§{...}§` 模式则丢弃；
 * 否则将缓冲区刷新到下游。
 */
export class ContextTagStripBuffer {
  private _downstream: (chunk: string) => void;
  private _buffer = "";
  private _buffering = false;
  private _swallowNewline = false;  // eat one \n after a matched tag

  constructor(downstream: (chunk: string) => void) {
    this._downstream = downstream;
  }

  feed(chunk: string): void {
    for (const ch of chunk) {
      if (this._swallowNewline) {
        this._swallowNewline = false;
        if (ch === "\n") continue;  // consumed
        // Not a newline —fall through to normal processing
      }
      if (this._buffering) {
        this._buffer += ch;
        if (ch === CONTEXT_TAG_DELIMITER && this._buffer.length >= 4) {
          // Check if we completed a §{...}§ pattern
          if (
            this._buffer.startsWith(`${CONTEXT_TAG_DELIMITER}{`) &&
            this._buffer.endsWith(`}${CONTEXT_TAG_DELIMITER}`)
          ) {
            // Discard the matched tag, and swallow the next \n if present
            this._buffer = "";
            this._buffering = false;
            this._swallowNewline = true;
          } else {
            // Not a valid tag —flush buffer
            this._flush();
          }
        } else if (this._buffer.length > 50) {
          // Safety: if buffer gets too long without closing, flush
          this._flush();
        }
      } else if (ch === CONTEXT_TAG_DELIMITER) {
        this._buffering = true;
        this._buffer = ch;
      } else {
        this._downstream(ch);
      }
    }
  }

  /** 刷新任何剩余的缓冲内容 */
  flush(): void {
    if (this._buffer) {
      this._downstream(this._buffer);
      this._buffer = "";
    }
    this._buffering = false;
  }

  private _flush(): void {
    this._downstream(this._buffer);
    this._buffer = "";
    this._buffering = false;
  }
}

/**
 * 在消息内容开头注入上下文标签。
 *
 * 处理字符串内容和 Anthropic 风格的数组内容
 * （包含 `{type, text, ...}` 的内容块数组）。
 */
export function injectContextIdTag(
  content: string | Array<Record<string, unknown>>,
  contextId: number | string,
): string | Array<Record<string, unknown>> {
  const tag = formatContextTag(String(contextId));

  if (typeof content === "string") {
    return `${tag}\n${content}`;
  }

  if (Array.isArray(content)) {
    // 查找第一个文本块并在前面插入标签
    const copy = content.map((block) => ({ ...block }));
    let injected = false;
    for (const block of copy) {
      if (block["type"] === "text" && typeof block["text"] === "string") {
        block["text"] = `${tag}\n${block["text"]}`;
        injected = true;
        break;
      }
    }
    if (!injected) {
      // 未找到文本块——在开头插入一个
      copy.unshift({ type: "text", text: tag });
    }
    return copy;
  }

  return content;
}

// ------------------------------------------------------------------
// 连续同角色消息合并
// ------------------------------------------------------------------

/**
 * 角色感知的连续同角色消息合并。
 *
 * 用于需要严格交替 user/assistant turn 的提供商。
 *
 * 规则：
 *  - 系统消息：永不合并
 *  - tool_result 消息：永不合并（每个都有自己的 tool_call_id）
 *  - 带 tool_calls 的 assistant：永不合并，但吸收前面的纯文本 assistant
 *  - user + user：块拼接（concatAsContentBlocks）
 *  - assistant(text) + assistant(text)：通过 \n\n 文本拼接
 */
export function mergeConsecutiveSameRole(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [];

  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg["role"] as string;

    // 永不合并这些——但处理相邻 assistant 的边缘情况
    if (
      role === "system" ||
      role === "tool_result"
    ) {
      result.push(msg);
      continue;
    }

    if (role === "assistant" && msg["tool_calls"]) {
      // 如果前一条消息是纯文本 assistant（例如 summarize_context 插入的摘要），
      // 将其文本合并到此消息中，以避免违反严格角色交替要求的连续模型 turn。
      const prev = result.length > 0 ? result[result.length - 1] : null;
      if (
        prev &&
        prev["role"] === "assistant" &&
        !prev["tool_calls"]
      ) {
        const prevText =
          (typeof prev["content"] === "string" ? prev["content"] : "") ||
          (typeof prev["text"] === "string" ? prev["text"] : "");
        if (prevText) {
          const merged = { ...msg };
          const curText =
            (typeof merged["text"] === "string" ? merged["text"] : "") ||
            (typeof merged["content"] === "string" ? merged["content"] : "");
          merged["text"] = curText ? `${prevText}\n\n${curText}` : prevText;
          result.pop();
          result.push(merged);
        } else {
          // 前一条为空——直接移除
          result.pop();
          result.push(msg);
        }
      } else {
        result.push(msg);
      }
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : null;
    if (!prev || prev["role"] !== role) {
      result.push(msg);
      continue;
    }

    // 前一条消息也不应是"永不合并"类型
    if (
      prev["role"] === "system" ||
      prev["role"] === "tool_result" ||
      (prev["role"] === "assistant" && prev["tool_calls"])
    ) {
      result.push(msg);
      continue;
    }

    // 合并到前一条消息
    const prevContent = prev["content"];
    const curContent = msg["content"];

    prev["content"] = mergeContent(prevContent, curContent);
  }

  return result;
}

/**
 * 合并两个消息内容值。
 * 处理 string + string、array + array、string + array、array + string。
 */
function mergeContent(
  a: unknown,
  b: unknown,
): string | Array<Record<string, unknown>> {
  const aIsString = typeof a === "string";
  const bIsString = typeof b === "string";
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);

  if (aIsString && bIsString) {
    return `${a}\n\n${b}`;
  }

  // 将字符串转换为文本块用于数组合并
  const aBlocks = aIsArray
    ? (a as Array<Record<string, unknown>>)
    : aIsString
      ? [{ type: "text", text: a }]
      : [{ type: "text", text: String(a) }];

  const bBlocks = bIsArray
    ? (b as Array<Record<string, unknown>>)
    : bIsString
      ? [{ type: "text", text: b }]
      : [{ type: "text", text: String(b) }];

  return [...aBlocks, ...bBlocks];
}
