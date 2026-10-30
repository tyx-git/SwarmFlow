/** turn 接口契约：内联图片输入、轮次生命周期事件与工具排空结果。 */

import type { AskRequest } from "../ask.js";

export type DrainPendingToolCallsResult =
  | { kind: "drained" }
  | { kind: "suspended"; ask: AskRequest; toolCallId: string }
  | { kind: "interrupted" };

// ------------------------------------------------------------------
// InlineImageInput——传给 turn() 的剪贴板/拖放图片
// ------------------------------------------------------------------

export interface InlineImageInput {
  id: string;
  base64: string;
  mediaType: string;
}

// ------------------------------------------------------------------
// TurnLifecycleEvent——运行时发出的轮次开始/结束通知
// ------------------------------------------------------------------

/** 轮次的终态。`waiting` 表示停在待处理的 ask 上（尚未结束）。 */
export type TurnLifecycleStatus = "completed" | "interrupted" | "error" | "waiting";

/**
 * Session 在每次 activation 循环运行前后发出——包括没有外部调用方的
 * auto-resume 与审批后 resume 轮次。
 * RPC 层订阅后转发为 `turn.started` / `turn.ended` 事件，
 * 进程内 UI 也可直接使用。
 */
export type TurnLifecycleEvent =
  | { phase: "started"; turnIndex: number }
  | { phase: "ended"; turnIndex: number; status: TurnLifecycleStatus; error?: string };
