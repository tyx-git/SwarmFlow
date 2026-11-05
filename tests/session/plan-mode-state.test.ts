/**
 * plan 模式状态：期望值来自计划契约——"plan 段每个请求都可见，且不因其他运行状态为空而消失"，
 * 不来自实现。基线断言（未进入时整块为空串）证明非空确实由 plan 段造成。
 */

import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { makeSession, makeTempDir } from "./minimal-session.js";

describe("plan 模式状态与 [RUNTIME STATE] 计划段", () => {
  function withSession(run: (session: ReturnType<typeof makeSession>) => void): void {
    const projectRoot = makeTempDir("swarmflow-plan-mode-");
    try {
      run(makeSession(projectRoot));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }

  it("未进入 plan 模式且无其他运行状态时整块为空串", () => {
    withSession((session) => {
      expect(session.isPlanModeActive()).toBe(false);
      expect(session._buildRuntimeStateBlock()).toBe("");
    });
  });

  it("进入后即使没有任务/子代理/shell，plan 段仍然出现在每个请求的快照里", () => {
    withSession((session) => {
      session.enterPlanMode("把收尾门做实");

      expect(session.isPlanModeActive()).toBe(true);
      const block = session._buildRuntimeStateBlock();
      expect(block).toContain("[RUNTIME STATE]");
      expect(block).toContain("Plan mode: active.");
      expect(block).toContain("Goal: 把收尾门做实");
      // 收尾契约的两条硬要求必须出现在模型可见文本里
      expect(block).toContain("Resolve every question that needs a user decision with `ask`");
      expect(block).toContain("Do not end the turn with a list of unresolved questions");
      expect(block).toContain("'*** Begin Plan' and '*** End Plan'");
    });
  });

  it("没有 goal 时计划段仍然给出，并标注未指定", () => {
    withSession((session) => {
      session.enterPlanMode("   ");

      const block = session._buildRuntimeStateBlock();
      expect(block).toContain("Plan mode: active.");
      expect(block).toContain("Goal: not specified.");
    });
  });

  it("退出后计划段消失，快照回到空串", () => {
    withSession((session) => {
      session.enterPlanMode("第一段目标");
      expect(session._buildRuntimeStateBlock()).toContain("Plan mode: active.");

      session.exitPlanMode();

      expect(session.isPlanModeActive()).toBe(false);
      expect(session.getPlanModeGoal()).toBeUndefined();
      expect(session._buildRuntimeStateBlock()).toBe("");
    });
  });

  it("再次进入覆盖 goal 但保持 active，未进入时退出是无害操作", () => {
    withSession((session) => {
      session.enterPlanMode("旧目标");
      session.enterPlanMode("新目标");
      expect(session.isPlanModeActive()).toBe(true);
      expect(session.getPlanModeGoal()).toBe("新目标");

      session.exitPlanMode();
      expect(() => session.exitPlanMode()).not.toThrow();
      expect(session.isPlanModeActive()).toBe(false);
    });
  });
});
