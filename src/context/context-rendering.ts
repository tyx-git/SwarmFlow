/**
 * Context-tag and message-shaping utilities shared by the log-native runtime.
 *
 * Provides:
 *  - Compact marker constants and type guards
 *  - Context ID injection utilities
 *  - Consecutive same-role merging for provider-specific alternation rules
 */

import { randomBytes } from "node:crypto";

// ------------------------------------------------------------------
// Compact marker
// ------------------------------------------------------------------

/** Sentinel role used for compact markers in the conversation array. */
export const COMPACT_MARKER_ROLE = "__compact_marker";

/** Shape of a compact marker in provider-message-like projections. */
export interface CompactMarker {
  role: typeof COMPACT_MARKER_ROLE;
  marker_type: "plan_advance" | "auto_compact" | "context_reset";
  timestamp: number;
}

/** Type guard: is this message a compact marker? */
export function isCompactMarker(msg: Record<string, unknown>): boolean {
  return msg["role"] === COMPACT_MARKER_ROLE;
}

// ------------------------------------------------------------------
// Context ID
// ------------------------------------------------------------------

/** Metadata field name for context IDs stored on messages. */
export const CONTEXT_ID_KEY = "_context_id";

/**
 * Allocate a unique random hex context ID (4 hex chars).
 * Retries on collision (up to 10 times), then falls back to 6 hex chars.
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

/** Format a context ID into the injection tag: `搂{contextId}搂` */
export function formatContextTag(contextId: string): string {
  return `搂{${contextId}}搂`;
}

/** Regex matching any `搂{...}搂` context tag, plus optional trailing newline (global). */
export const CONTEXT_TAG_REGEX = /搂\{[^}]*\}搂\n?/g;

/** Strip all `搂{...}搂` context tags (and their trailing newline) from text. */
export function stripContextTags(text: string): string {
  return text.replace(CONTEXT_TAG_REGEX, "");
}

// ------------------------------------------------------------------
// ContextTagStripBuffer 鈥?streaming strip for 搂{...}搂 tags
// ------------------------------------------------------------------

/**
 * Buffers streaming text to strip `搂{...}搂` context tags that the model
 * may produce. When `搂` is encountered, buffering starts. If the buffer
 * completes a `搂{...}搂` pattern, it's discarded. Otherwise the buffer
 * is flushed downstream.
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
        // Not a newline 鈥?fall through to normal processing
      }
      if (this._buffering) {
        this._buffer += ch;
        if (ch === "搂" && this._buffer.length >= 4) {
          // Check if we completed a 搂{...}搂 pattern
          if (this._buffer.startsWith("搂{") && this._buffer.endsWith("}搂")) {
            // Discard the matched tag, and swallow the next \n if present
            this._buffer = "";
            this._buffering = false;
            this._swallowNewline = true;
          } else {
            // Not a valid tag 鈥?flush buffer
            this._flush();
          }
        } else if (this._buffer.length > 50) {
          // Safety: if buffer gets too long without closing, flush
          this._flush();
        }
      } else if (ch === "搂") {
        this._buffering = true;
        this._buffer = ch;
      } else {
        this._downstream(ch);
      }
    }
  }

  /** Flush any remaining buffered content. */
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
 * Inject a context tag at the beginning of message content.
 *
 * Handles both string content and Anthropic-style array content
 * (array of content blocks with `{type, text, ...}`).
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
    // Find first text block and prepend the tag
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
      // No text block found 鈥?insert one at the beginning
      copy.unshift({ type: "text", text: tag });
    }
    return copy;
  }

  return content;
}

// ------------------------------------------------------------------
// Consecutive same-role merging
// ------------------------------------------------------------------

/**
 * Role-aware merge for consecutive same-role messages.
 *
 * For providers that require strictly alternating user/assistant turns.
 *
 * Rules:
 *  - system messages: never merged
 *  - tool_result messages: never merged (each has its own tool_call_id)
 *  - assistant with tool_calls: never merged, but absorbs preceding pure-text assistant
 *  - user + user: block concat (concatAsContentBlocks)
 *  - assistant(text) + assistant(text): text concat via \n\n
 */
export function mergeConsecutiveSameRole(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [];

  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg["role"] as string;

    // Never merge these 鈥?but handle adjacent assistant edge case
    if (
      role === "system" ||
      role === "tool_result"
    ) {
      result.push(msg);
      continue;
    }

    if (role === "assistant" && msg["tool_calls"]) {
      // If the previous message is a pure-text assistant (e.g. a summary
      // inserted by summarize_context), merge its text into this message
      // to avoid consecutive model turns that violate strict
      // role-alternation requirements.
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
          // prev is empty 鈥?just remove it
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

    // Previous message also shouldn't be a "never merge" type
    if (
      prev["role"] === "system" ||
      prev["role"] === "tool_result" ||
      (prev["role"] === "assistant" && prev["tool_calls"])
    ) {
      result.push(msg);
      continue;
    }

    // Merge into previous
    const prevContent = prev["content"];
    const curContent = msg["content"];

    prev["content"] = mergeContent(prevContent, curContent);
  }

  return result;
}

/**
 * Merge two message content values together.
 * Handles string + string, array + array, string + array, array + string.
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

  // Convert strings to text blocks for array merging
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
