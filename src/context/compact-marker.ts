/** 压缩标记消息的角色、投影形状与类型守卫。 */

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
// 上下文 ID
// ------------------------------------------------------------------

