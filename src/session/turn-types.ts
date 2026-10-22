/** turn 接口契约：内联图片输入、轮次生命周期事件与工具排空结果。 */

import type { AskRequest } from "../ask.js";

export type DrainPendingToolCallsResult =
  | { kind: "drained" }
  | { kind: "suspended"; ask: AskRequest; toolCallId: string }
  | { kind: "interrupted" };

// ------------------------------------------------------------------
// InlineImageInput —clipboard / drag-drop image passed to turn()
// ------------------------------------------------------------------

export interface InlineImageInput {
  id: string;
  base64: string;
  mediaType: string;
}

// ------------------------------------------------------------------
// TurnLifecycleEvent —runtime-emitted turn start/end notifications
// ------------------------------------------------------------------

/** Terminal status of a turn. `waiting` = parked on a pending ask (not done). */
export type TurnLifecycleStatus = "completed" | "interrupted" | "error" | "waiting";

/**
 * Emitted by the Session around every activation-loop run —including
 * auto-resume and post-approval resume turns that have no external caller.
 * Subscribed by the RPC layer (forwarded as `turn.started` / `turn.ended`
 * wire events) and available to in-process UIs.
 */
export type TurnLifecycleEvent =
  | { phase: "started"; turnIndex: number }
  | { phase: "ended"; turnIndex: number; status: TurnLifecycleStatus; error?: string };
