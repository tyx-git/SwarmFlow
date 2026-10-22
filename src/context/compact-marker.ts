/**
 * 上下文压缩标记与上下文 ID 标签——由基于日志的运行时共享。
 */

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

