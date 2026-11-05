/**
 * 确认门面板的真实渲染：计划正文进带边框的视图、三选项齐全、
 * 第三行是带背景字的输入行。断言取自无头渲染出来的字符帧，不取自源码字符串。
 */

import { describe, expect, it } from "vitest";
import React, { createRef } from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import type { InputRenderable } from "@opentui/core";

import { AskPendingError, toPendingAskUi, type AgentQuestion, type PendingAskUi } from "../../src/ask.js";
import { execPresentPlan } from "../../src/session/ask-flow.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { AskPanelView } from "../../external/opentui/display/panels/ask-panel.js";
import { createUiText } from "../../src/ui/text.js";

const PLAN_BODY = [
  "*** Begin Plan",
  "# 计划",
  "## 阶段一",
  "- [ ] 抽出通用层",
  "*** End Plan",
].join("\n");

/** 用真实执行器造出挂起的确认门，保证渲染读的是生产数据结构。 */
function openPlanAsk(): AgentQuestion {
  const host = { primaryAgent: { name: "Primary" }, isPlanModeActive: () => true } as never;
  let thrown: unknown;
  try {
    execPresentPlan(host, {}, PLAN_BODY);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AskPendingError);
  return (thrown as AskPendingError).ask as AgentQuestion;
}

async function renderGate(language: "zh" | "en", selectedIndex: number) {
  const ask: PendingAskUi = toPendingAskUi(openPlanAsk())!;
  const theme = createDisplayTheme("dark");
  const setup = await createTestRenderer({ width: 100, height: 20, useThread: false, consoleMode: "disabled" });
  const root = createRoot(setup.renderer);
  try {
    flushSync(() => root.render(React.createElement(AskPanelView, {
      ask,
      uiText: createUiText(language),
      error: null,
      selectedIndex,
      currentQuestionIndex: 0,
      totalQuestions: 1,
      questionAnswers: new Map(),
      customInputMode: false,
      noteInputMode: false,
      reviewMode: false,
      inlineValue: "",
      optionNotes: new Map(),
      inputRef: createRef<InputRenderable>(),
      onInput: () => {},
      onSubmit: () => {},
      theme,
      terminalHeight: 20,
      contentWidth: 96,
    })));
    await setup.flush({ maxPasses: 100 });
    return setup.captureCharFrame();
  } finally {
    flushSync(() => root.unmount());
    setup.renderer.destroy();
    theme.markdownStyle.destroy();
  }
}

describe("确认门面板渲染", () => {
  it("中文界面给出计划正文、两个决议项和一行输入", async () => {
    const frame = await renderGate("zh", 0);
    expect(frame).toContain("# 计划");
    expect(frame).toContain("## 阶段一");
    expect(frame).toContain("- [ ] 抽出通用层");
    expect(frame).toContain("确认执行");
    expect(frame).toContain("取消计划");
    // 计划视图有边框，正文不散落回普通文本
    expect(frame).toMatch(/[┌┐│─]/);
    // 计划正文不在聊天流里重复出现标记行
    expect(frame).not.toContain("*** Begin Plan");
  });

  it("英文界面同步给出 chrome（选项标签随创建时的语言冻结在载荷里）", async () => {
    const frame = await renderGate("en", 0);
    expect(frame).toContain("Question 1/1:");
    expect(frame).toContain("Use ↑/↓ to select");
    expect(frame).toContain("How to adjust?");
  });

  it("第三行显示为背景字输入行，且不出现自定义输入标签", async () => {
    const frame = await renderGate("zh", 2);
    expect(frame).toContain("如何调整?");
    expect(frame).not.toContain("自定义输入");
  });
});
