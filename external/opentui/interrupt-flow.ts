/**
 * 中断决策：把"这一按键该调用哪些引擎原语"从渲染层摘出来，便于独立测试。
 *
 * 两段式：忙态第一下只 deny 当前可见 ask（或中止本会话正在跑的轮次），
 * 窗口内第二下全停（先停子再停主）。决策只看输入量，不做任何副作用。
 */

/** deny = 第一下；full = 窗口内第二下，全停。 */
export type InterruptScope = "deny" | "full";

/** 可见挂起 ask 的归属；null 表示当前没有挂起 ask。 */
export type InterruptAskOwnerKind = "self" | "child";

export type InterruptCall =
  | "denyAsk"
  | "interruptTurn"
  | "fullStop"
  | "stopChildren";

export interface InterruptDecisionInput {
  scope: InterruptScope;
  pendingAskOwner: InterruptAskOwnerKind | null;
  /** 引擎量：本会话是否有轮次正在跑（含外部入口自起的轮次）。 */
  turnRunning: boolean;
  /** 渲染量：某个回合包装器仍在 await（覆盖 `started` 之前就被中止的红区）。 */
  processing: boolean;
  runningChildren: boolean;
  /** 引擎是否提供全停原语；没有时全退成"停子 + 停主"组合。 */
  hasFullStop: boolean;
}

export interface InterruptDecision {
  /** 按顺序执行的引擎调用。 */
  calls: InterruptCall[];
  /**
   * 是否中止本侧 controller。只在 deny 本会话自己的 ask、或直接停轮次时才中止：
   * deny 子会话的 ask 不得连带中止本会话正在跑的轮次。
   */
  abortOwnController: boolean;
  /** 是否布防窗口内的第二下（全停）。 */
  armFullStop: boolean;
  /** 提示文案的 uiText 路径；null 表示不提示。 */
  hintKey: string[] | null;
}

/**
 * 忙态第一下的提示文案键：提示"再按一次停止全部"。
 * 全停后的提示文案键：说明主轮次与所有子代理都已停止。
 */
export const PRESS_AGAIN_TO_STOP_KEY = ["Views", "interrupt", "pressAgainToStop"];
export const ALL_STOPPED_KEY = ["Views", "interrupt", "allStopped"];

export function decideInterrupt(input: InterruptDecisionInput): InterruptDecision {
  if (input.scope === "full") {
    return {
      calls: input.hasFullStop ? ["fullStop"] : ["stopChildren", "interruptTurn"],
      abortOwnController: true,
      armFullStop: false,
      hintKey: ALL_STOPPED_KEY,
    };
  }

  // 有可见 ask：先给它一个明确结果。归属决定会不会连带中止本会话的轮次。
  if (input.pendingAskOwner !== null) {
    return {
      calls: ["denyAsk"],
      abortOwnController: input.pendingAskOwner === "self",
      armFullStop: true,
      hintKey: PRESS_AGAIN_TO_STOP_KEY,
    };
  }

  // 无 ask、本会话在跑：只停本会话的轮次，子代理作为独立后台工作继续运行。
  if (input.turnRunning || input.processing) {
    return {
      calls: ["interruptTurn"],
      abortOwnController: true,
      armFullStop: true,
      hintKey: PRESS_AGAIN_TO_STOP_KEY,
    };
  }

  // 本会话已空闲、只剩子代理在跑：第一按键不做任何破坏性动作，只布防第二下。
  if (input.runningChildren) {
    return {
      calls: [],
      abortOwnController: false,
      armFullStop: true,
      hintKey: PRESS_AGAIN_TO_STOP_KEY,
    };
  }

  // 全空闲：没有可 deny 也没有可中止的轮次，交由调用方的空闲分支处理
  // （双击 /rewind 或退出）。
  return {
    calls: [],
    abortOwnController: false,
    armFullStop: false,
    hintKey: null,
  };
}
