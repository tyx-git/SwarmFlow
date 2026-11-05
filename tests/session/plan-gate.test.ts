/**
 * 确认门（present_plan）的行为契约。
 *
 * 期望值来自计划规格，不来自实现：三选项由代码给出、决议按 decisionId 判定、
 * 只有批准才落盘且路径为绝对、取消不产生任何文件、修订请求留在 plan 模式内。
 * 面向模型的文本保持英文；面向人的标签跟随 ui_language（默认中文）。
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AskPendingError,
  toPendingAskUi,
  type AgentQuestion,
  type AgentQuestionDecision,
  type AgentQuestionItem,
} from "../../src/ask.js";
import { sessionDirName } from "../../src/session/plan-artifact.js";
import { makeSession, makeTempDir } from "./minimal-session.js";

const PLAN_BODY = "*** Begin Plan\n# 计划\n- [ ] 阶段一\n*** End Plan";

function answerOf(optionIndex: number, answerText: string): AgentQuestionDecision {
  return { answers: [{ questionIndex: 0, selectedOptionIndex: optionIndex, answerText }] };
}

/** 造一个挂起的确认门，返回被抛出的 ask。 */
function openGate(session: ReturnType<typeof makeSession>): AgentQuestion {
  let thrown: unknown;
  try {
    (session as any)._execPresentPlan({}, PLAN_BODY);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AskPendingError);
  return (thrown as AskPendingError).ask as AgentQuestion;
}

describe("present_plan 的入参与状态校验", () => {
  it("带参数、缺载荷、空载荷、非 plan 模式都被拒并给出纠正提示", () => {
    const root = makeTempDir("swarmflow-plan-gate-");
    try {
      const session = makeSession(root);
      session.enterPlanMode("把收尾门做实");

      const withArgs = (session as any)._execPresentPlan({ content: "# 计划" }, PLAN_BODY);
      expect(withArgs.isError).toBe(true);
      expect(withArgs.content).toContain("takes no arguments");

      const noPayload = (session as any)._execPresentPlan({}, undefined);
      expect(noPayload.isError).toBe(true);
      expect(noPayload.content).toContain("'*** Begin Plan'");

      const blankPayload = (session as any)._execPresentPlan({}, "*** Begin Plan\n   \n*** End Plan");
      expect(blankPayload.isError).toBe(true);

      session.exitPlanMode();
      const outsidePlan = (session as any)._execPresentPlan({}, PLAN_BODY);
      expect(outsidePlan.isError).toBe(true);
      expect(outsidePlan.content).toContain("/plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("确认门的选项集", () => {
  it("恰为三项：确认执行、取消计划、自定义输入，全部由代码给出", () => {
    const root = makeTempDir("swarmflow-plan-options-");
    try {
      const session = makeSession(root);
      session.enterPlanMode();
      const ask = openGate(session);

      expect(ask.kind).toBe("agent_question");
      expect(ask.payload.toolName).toBe("present_plan");
      const question = ask.payload.questions[0];
      expect(question.planContent).toBe("# 计划\n- [ ] 阶段一");
      expect(question.options.map((option) => option.label)).toEqual([
        "确认执行",
        "取消计划",
        "自定义输入",
      ]);
      expect(question.options.map((option) => option.kind)).toEqual([
        "normal",
        "normal",
        "custom_input",
      ]);
      expect(question.options.map((option) => option.decisionId)).toEqual([
        "plan_confirm",
        "plan_cancel",
        undefined,
      ]);
      // 三项都是 systemAdded：不出现附注输入，面板同时只有一个输入框
      expect(question.options.every((option) => option.systemAdded === true)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("确认门走真实工具循环", () => {
  it("计划块经载荷绑定进入 present_plan，批准后写出 plan.md", async () => {
    const { PRESENT_PLAN_TOOL } = await import("../../src/tools/comm.js");
    const { makeScriptedSession } = await import("../helpers/session-harness.js");
    const planBody = "*** Begin Plan\n# 计划\n- [ ] 阶段一\n*** End Plan";

    const h = makeScriptedSession({
      rounds: [
        { text: planBody, toolCalls: [{ id: "call-plan", name: "present_plan", arguments: {} }] },
        { text: "done" },
      ],
      tools: [PRESENT_PLAN_TOOL],
    });
    try {
      h.session.enterPlanMode("走一遍真实循环");
      const running = h.session.turn("进入 plan 模式并给出计划");
      await vi.waitFor(() => expect(h.session.getPendingAsk()).not.toBeNull());

      const pending = h.session.getPendingAsk()!;
      const questions = pending.payload["questions"] as AgentQuestionItem[];
      // 载荷真的从正文绑到了这次零参数调用上
      expect(questions[0].planContent).toBe("# 计划\n- [ ] 阶段一");
      expect(questions[0].options.map((option) => option.decisionId)).toEqual([
        "plan_confirm",
        "plan_cancel",
        undefined,
      ]);

      h.session.resolveAgentQuestionAsk(pending.id, {
        answers: [{ questionIndex: 0, selectedOptionIndex: 0, answerText: "确认执行" }],
      });
      await running;

      expect(h.session.isPlanModeActive()).toBe(false);
      const planPath = join(
        h.projectRoot,
        ".swarmflow",
        sessionDirName((h.session as any)._store),
        "plan",
        "plan.md",
      );
      expect(existsSync(planPath)).toBe(true);
      expect(readFileSync(planPath, "utf-8")).toContain("- [ ] 阶段一");
    } finally {
      h.dispose();
    }
  });
});

describe("确认门的权限归类", () => {
  it("present_plan 归类为 read，展示计划前不会多弹一次审批", async () => {
    const { classifyTool } = await import("../../src/permissions/classify.js");
    expect(classifyTool("present_plan", {}).permissionClass).toBe("read");
  });
});

describe("确认门结算", () => {
  it("批准时写出绝对路径的 plan.md 并退出 plan 模式", () => {
    const root = makeTempDir("swarmflow-plan-approve-");
    try {
      const session = makeSession(root);
      session.enterPlanMode("ship it");
      const ask = openGate(session);

      const lines = (session as any)._settlePlanMode(ask, answerOf(0, "确认执行"));
      const expectedPath = join(
        root,
        ".swarmflow",
        sessionDirName((session as any)._store),
        "plan",
        "plan.md",
      );

      expect(session.isPlanModeActive()).toBe(false);
      expect(lines.join("\n")).toContain("Plan decision: approved.");
      expect(lines.join("\n")).toContain(`Plan file: ${expectedPath}`);
      expect(existsSync(expectedPath)).toBe(true);
      const text = readFileSync(expectedPath, "utf-8");
      expect(text).toContain("# 计划");
      expect(text).toContain("Goal: ship it");

      // 计划正文之外不再产出文件
      const dir = join(root, ".swarmflow", sessionDirName((session as any)._store), "plan");
      expect(existsSync(join(dir, "process.md"))).toBe(false);
      expect(existsSync(join(dir, "finding.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("取消时不写任何文件，同样退出 plan 模式", () => {
    const root = makeTempDir("swarmflow-plan-cancel-");
    try {
      const session = makeSession(root);
      session.enterPlanMode("ship it");
      const ask = openGate(session);

      const lines = (session as any)._settlePlanMode(ask, answerOf(1, "取消计划"));

      expect(lines.join("\n")).toContain("Plan decision: cancelled.");
      expect(session.isPlanModeActive()).toBe(false);
      expect(existsSync(join(root, ".swarmflow"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("自定义输入视为要求修订：留在 plan 模式内并把原文交回模型", () => {
    const root = makeTempDir("swarmflow-plan-revision-");
    try {
      const session = makeSession(root);
      session.enterPlanMode("ship it");
      const ask = openGate(session);

      const lines = (session as any)._settlePlanMode(ask, answerOf(2, "先补一轮回归"));

      expect(lines.join("\n")).toContain("Plan decision: revision requested: 先补一轮回归");
      expect(session.isPlanModeActive()).toBe(true);
      expect(existsSync(join(root, ".swarmflow"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("决议按 decisionId 判定，标签换成别的语言仍然正确", () => {
    const root = makeTempDir("swarmflow-plan-byid-");
    try {
      const session = makeSession(root);
      session.enterPlanMode("ship it");
      const ask = openGate(session);
      // 模拟英文界面下的同一扇门：标签不同，decisionId 不变
      ask.payload.questions[0].options = ask.payload.questions[0].options.map((option) => ({
        ...option,
        label: option.decisionId === "plan_confirm" ? "Confirm execution" : option.label,
      }));

      const lines = (session as any)._settlePlanMode(ask, answerOf(0, "Confirm execution"));

      expect(lines.join("\n")).toContain("Plan decision: approved.");
      expect(session.isPlanModeActive()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
