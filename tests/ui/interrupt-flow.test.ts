/**
 * 中断决策表：忙态两段式的每一格都独立可测，不依赖渲染。
 * 期望值来自定稿语义（第一下 deny/停主，第二下全停，归属决定连带中止范围）。
 */

import { describe, expect, it } from "vitest";

import {
  ALL_STOPPED_KEY,
  PRESS_AGAIN_TO_STOP_KEY,
  decideInterrupt,
  type InterruptDecisionInput,
} from "../../external/opentui/interrupt-flow.js";

function input(overrides: Partial<InterruptDecisionInput>): InterruptDecisionInput {
  return {
    scope: "deny",
    pendingAskOwner: null,
    turnRunning: false,
    processing: false,
    runningChildren: false,
    hasFullStop: true,
    ...overrides,
  };
}

describe("两段式第一下（deny）", () => {
  it("deny 本会话自己的 ask 时连带中止本侧 controller", () => {
    const decision = decideInterrupt(input({ pendingAskOwner: "self", turnRunning: true, processing: true }));

    expect(decision.calls).toEqual(["denyAsk"]);
    expect(decision.abortOwnController).toBe(true);
    expect(decision.armFullStop).toBe(true);
    expect(decision.hintKey).toEqual(PRESS_AGAIN_TO_STOP_KEY);
  });

  it("deny 子会话的 ask 时不得中止本会话正在跑的轮次", () => {
    const decision = decideInterrupt(input({ pendingAskOwner: "child", turnRunning: true, processing: true }));

    expect(decision.calls).toEqual(["denyAsk"]);
    expect(decision.abortOwnController).toBe(false);
    expect(decision.armFullStop).toBe(true);
  });

  it("无 ask 且本会话在跑时只停本会话轮次", () => {
    const decision = decideInterrupt(input({ turnRunning: true, processing: true }));

    expect(decision.calls).toEqual(["interruptTurn"]);
    expect(decision.abortOwnController).toBe(true);
    expect(decision.armFullStop).toBe(true);
  });

  it("本会话已空闲、只剩子代理在跑时只布防，不做破坏性动作", () => {
    const decision = decideInterrupt(input({ runningChildren: true }));

    expect(decision.calls).toEqual([]);
    expect(decision.abortOwnController).toBe(false);
    expect(decision.armFullStop).toBe(true);
    expect(decision.hintKey).toEqual(PRESS_AGAIN_TO_STOP_KEY);
  });

  it("全空闲时不布防也不提示（交由空闲分支处理）", () => {
    const decision = decideInterrupt(input({}));

    expect(decision.calls).toEqual([]);
    expect(decision.armFullStop).toBe(false);
    expect(decision.hintKey).toBeNull();
  });

  it("包装器仍在 await 但引擎未标记轮次时也按停主处理", () => {
    const decision = decideInterrupt(input({ processing: true }));

    expect(decision.calls).toEqual(["interruptTurn"]);
    expect(decision.abortOwnController).toBe(true);
  });
});

describe("窗口内第二下（full）", () => {
  it("全停走单一原语，且任何归属都覆盖", () => {
    for (const pendingAskOwner of ["self", "child", null] as const) {
      const decision = decideInterrupt(input({ scope: "full", pendingAskOwner, turnRunning: true, processing: true }));

      expect(decision.calls).toEqual(["fullStop"]);
      expect(decision.abortOwnController).toBe(true);
      expect(decision.armFullStop).toBe(false);
      expect(decision.hintKey).toEqual(ALL_STOPPED_KEY);
    }
  });

  it("引擎没有全停原语时退化成停子加停主的组合", () => {
    const decision = decideInterrupt(input({ scope: "full", hasFullStop: false, runningChildren: true }));

    expect(decision.calls).toEqual(["stopChildren", "interruptTurn"]);
    expect(decision.hintKey).toEqual(ALL_STOPPED_KEY);
  });

  it("第二下不得再次布防（避免三击语义歧义）", () => {
    const decision = decideInterrupt(input({ scope: "full" }));

    expect(decision.armFullStop).toBe(false);
  });
});
