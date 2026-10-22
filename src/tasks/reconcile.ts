/**
 * 启动对账 —— 重启后子代理一律视为已终止，只按阈值判定是否「值得续跑」。
 *
 * 冻结决策（设计定稿）：
 *  - **统一为 fail**：`status = "error"`（展示），但 `outcome` 保持 `"interrupted"`
 *    —— 若把 outcome 覆盖成 `error`，会与「failed 不续」规则自锁：
 *       第一次重启归一为 error → 第二次重启读到 error → 永远不再可续。
 *  - **可续**：`lifecycle = "idle"` + 保留 Session（供 `_startChildTurn`）
 *    **不可续**：`lifecycle = "archived"` + 释放 Session（沿用现状行为）
 *  - `blocked` 只在**同一进程内**存在（等用户回答 / 有挂起 turn）；重启后与 running 同口径，
 *    因为 ask 是内存态（`_activeAsk` / `_pendingTurnState`），恢复后已无法回答。
 *
 * 本模块只做「纯判定」，不碰文件、不碰 Session —— 便于单测与复用。
 */

import { isWorthResuming } from "./resume.js";
import type { TaskResumeHint } from "./types.js";

/** 子会话持久化的 outcome 词表（注意：不是 agent_result 的 `failed`）。 */
export type ChildOutcome = "none" | "completed" | "interrupted" | "error";

/** 子会话终止原因（写进父日志的 agent_result.cause）。 */
export type TerminationCause = "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt";

export type ResumeReason =
  /** 有实际投入，值得回放上下文续跑。 */
  | "in_progress_work"
  /** 刚起步就挂：重派更干净。 */
  | "too_early"
  /** 用户主动停（kill_agent / Ctrl-C 级联），尊重用户意图。 */
  | "user_stopped"
  /** 子已正常跑完，无需续也无需重派（父按结果收尾即可）。 */
  | "already_completed"
  /** 子自身以 error 结束；续跑会立刻再撞一次（由 resumeAttempts 兜底）。 */
  | "failed"
  /** 父任务已被新的 run 接管，旧子作废。 */
  | "superseded"
  /** 子日志不可加载（恢复时已被跳过）→ 只能重派。 */
  | "log_unavailable"
  /** 模板缺失/不可解析 → 只能重派。 */
  | "template_missing"
  /** 子会话日志中的模型配置无法解析 → 只能重派或修复模型配置。 */
  | "model_unavailable"
  /** 子会话对象已被释放（归档过的 oneshot），无法直接续跑 → 重派。 */
  | "child_released"
  /** persistent 子会话（可多轮对话）豁免阈值：上下文本身就有价值。 */
  | "persistent_child";

export interface ChildResumeSignals {
  childId: string;
  /** 子日志是否被成功加载并回放。 */
  logAvailable: boolean;
  /** 模板是否仍可解析（子 Session 是否创建成功）。 */
  templateAvailable: boolean;
  /** 子 Session 对象是否仍在内存里（归档过的 oneshot 会被释放，无法直接续跑）。 */
  sessionAvailable: boolean;
  outcome: ChildOutcome;
  cause?: TerminationCause;
  /** 父任务 `metadata.agentId`；undefined 表示该任务从未派发过。 */
  taskAgentId?: string;
  /** 子会话形态：persistent 豁免阈值。 */
  mode?: "oneshot" | "persistent";
  toolCalls: number;
  tokensIn: number;
}

export interface ResumeDecision {
  resumable: boolean;
  reason: ResumeReason;
}

/**
 * 判定是否续跑。
 *
 * 判定顺序即优先级：结构门控 → 归属 → 用户意图 → 结局 → 阈值。
 */
export function decideChildResume(signals: ChildResumeSignals): ResumeDecision {
  if (!signals.logAvailable) return { resumable: false, reason: "log_unavailable" };
  if (!signals.templateAvailable) return { resumable: false, reason: "template_missing" };
  if (!signals.sessionAvailable) return { resumable: false, reason: "child_released" };
  if (signals.taskAgentId !== undefined && signals.taskAgentId !== signals.childId) {
    return { resumable: false, reason: "superseded" };
  }
  if (signals.cause === "user_targeted_kill" || signals.cause === "user_mass_interrupt") {
    return { resumable: false, reason: "user_stopped" };
  }
  if (signals.outcome === "completed") return { resumable: false, reason: "already_completed" };
  if (signals.outcome === "error") return { resumable: false, reason: "failed" };
  // persistent 子会话（多轮对话）不受阈值限制：它的上下文不该因为"动作少"被丢掉
  if (signals.mode === "persistent") return { resumable: true, reason: "persistent_child" };
  return isWorthResuming(signals.toolCalls, signals.tokensIn)
    ? { resumable: true, reason: "in_progress_work" }
    : { resumable: false, reason: "too_early" };
}

/** 重启归一后的子会话状态（写入 handle）。 */
export interface ChildRestartState {
  lifecycle: "idle" | "archived";
  status: "error" | "completed";
  outcome: ChildOutcome;
  /** 是否保留 Session 以支持续跑。 */
  keepSession: boolean;
}

/**
 * 重启归一：把「曾经活着」的子会话统一落成 fail。
 *
 * 注意 `outcome` 固定为 `"interrupted"`：它表达「被重启打断」，而不是子自身失败；
 * 这也让下次重启的判定不会因为读到 `error` 而自锁。
 */
export function childRestartState(resumable: boolean, priorOutcome: ChildOutcome = "none"): ChildRestartState {
  // 重启前就已经有结论的子（正常结束 / 自身出错）保留它自己的结局：
  // 既不能把成功的运行显示成 failed，也不该再提供续跑。
  if (priorOutcome === "completed" || priorOutcome === "error") {
    return {
      lifecycle: "archived",
      status: priorOutcome === "completed" ? "completed" : "error",
      outcome: priorOutcome,
      keepSession: false,
    };
  }
  return {
    lifecycle: resumable ? "idle" : "archived",
    status: "error",
    outcome: "interrupted",
    keepSession: resumable,
  };
}

/** 生成写入父任务 metadata 的续跑建议。 */
export function toResumeHint(signals: ChildResumeSignals, decision: ResumeDecision): TaskResumeHint {
  return {
    childId: signals.childId,
    toolCalls: signals.toolCalls,
    tokensIn: signals.tokensIn,
    resumable: decision.resumable,
    reason: decision.reason,
  };
}

/** 供提示文案使用的一句话说明。 */
export function describeResumeReason(reason: ResumeReason): string {
  switch (reason) {
    case "in_progress_work":
      return "上次运行有实际投入，可断点续跑";
    case "too_early":
      return "上次运行刚开始就中断，建议直接重派";
    case "user_stopped":
      return "用户主动停止过该子代理，不再续跑";
    case "already_completed":
      return "该子代理已正常完成，按结果收尾即可";
    case "failed":
      return "该子代理自身以错误结束，建议重派";
    case "superseded":
      return "父任务已由新的运行接管，旧子代理作废";
    case "log_unavailable":
      return "子会话日志不可用，只能重派";
    case "template_missing":
      return "子代理模板缺失或不可解析，只能重派";
    case "model_unavailable":
      return "子会话保存的模型配置无法解析，只能修复配置或重派";
    case "child_released":
      return "子会话对象已释放，无法直接续跑，需重派";
    case "persistent_child":
      return "persistent 子会话，可断点续跑";
    default:
      // resumeHint 来自 tasks.json（可被手工编辑），未知原因不允许渲染成 undefined
      return "无法续跑，建议重派";
  }
}
