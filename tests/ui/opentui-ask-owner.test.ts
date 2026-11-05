/**
 * 面板归属标注：子会话的询问冒泡到主 tab 时，必须按 owner 标出来源子代理。
 * 断言取自无头渲染出来的字符帧，不取自源码字符串。
 */

import React, { createRef } from "react";
import { describe, expect, it } from "vitest";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import type { InputRenderable } from "@opentui/core";

import type { PendingAskUi } from "../../src/ask.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { AskPanelView } from "../../external/opentui/display/panels/ask-panel.js";
import { createUiText } from "../../src/ui/text.js";

/** 主会话自己发起的审批询问（source 与 owner 一致）。 */
function ownApprovalAsk(): PendingAskUi {
  return {
    id: "approval-own",
    kind: "approval",
    createdAt: new Date().toISOString(),
    summary: "Allow Queen to write a file?",
    owner: { kind: "self" },
    source: { agentId: "Primary" },
    payload: {
      toolCallId: "call-1",
      toolName: "bash",
      toolSummary: "write a file",
      permissionClass: "write_potent",
      offers: [],
    },
    options: ["Allow once", "Deny"],
  };
}

/** 子会话的询问冒泡到主 tab：source 仍是子内部的 agent 自述，owner 才是实际来源。 */
function bubbledApprovalAsk(): PendingAskUi {
  const own = ownApprovalAsk();
  return {
    ...own,
    id: "approval-child",
    summary: "Allow worker-1 to write a file?",
    owner: { kind: "child", agentId: "worker-1", agentName: "worker-1" },
  };
}

async function renderAsk(ask: PendingAskUi, language: "zh" | "en"): Promise<string> {
  const theme = createDisplayTheme("dark");
  const setup = await createTestRenderer({ width: 100, height: 14, useThread: false, consoleMode: "disabled" });
  const root = createRoot(setup.renderer);
  try {
    flushSync(() => root.render(React.createElement(AskPanelView, {
      ask,
      uiText: createUiText(language),
      error: null,
      selectedIndex: 0,
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
      terminalHeight: 14,
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

describe("审批面板归属标注", () => {
  it("本会话自己的审批标注为 Queen", async () => {
    const frame = await renderAsk(ownApprovalAsk(), "en");

    expect(frame).toContain("Source: Queen");
    expect(frame).not.toContain("Sub-Agent");
  });

  it("冒泡到主 tab 的子会话审批标注为该子代理，而不是 Queen", async () => {
    const frame = await renderAsk(bubbledApprovalAsk(), "en");

    expect(frame).toContain("Source: Sub-Agent worker-1");
    expect(frame).not.toContain("Source: Queen");
  });

  it("中文界面同样按 owner 标注", async () => {
    const frame = await renderAsk(bubbledApprovalAsk(), "zh");

    expect(frame).toContain("来源：子代理 worker-1");
  });
});
