import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import { RGBA, type TextareaRenderable } from "@opentui/core";

import { InputArea } from "../../external/opentui/input/input-area.js";
import { createComposerTokenVisuals } from "../../external/opentui/composer-tokens.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { getCommonColors } from "../../external/opentui/display/theme/color-config.js";
import { createUiText } from "../../src/ui/text.js";

const SCREEN_PATH = "external/opentui/display/layout/open-tui-screen.tsx";
const screenSource = readFileSync(SCREEN_PATH, "utf8");
const screenFile = ts.createSourceFile(SCREEN_PATH, screenSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 取某个顶层 const 的初始化表达式源码，用于断言面板挂在哪个布局块里。 */
function initializerOf(name: string): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer.getText(screenFile);
    }
    ts.forEachChild(node, visit);
  };
  visit(screenFile);
  return found;
}

function askMountCount(): number {
  return (screenSource.match(/<AskPanelView/g) ?? []).length;
}

async function activitySpan(phase: "Asking" | "Working") {
  const theme = createDisplayTheme("dark");
  const visuals = createComposerTokenVisuals(theme.colors);
  const setup = await createTestRenderer({ width: 120, height: 12, useThread: false, consoleMode: "disabled" });
  const root = createRoot(setup.renderer);
  try {
    flushSync(() => root.render(React.createElement(InputArea, {
      inputRef: React.createRef<TextareaRenderable>(),
      processing: true,
      pendingAsk: phase === "Asking",
      selectedChildId: null,
      phase,
      modelName: "test-model",
      thinkingSuffix: "",
      modelColor: theme.colors.text,
      elapsed: 0,
      cwd: ".",
      hint: null,
      contextTokens: 0,
      contextLimit: 8192,
      cacheInputTokens: 0,
      cacheReadTokens: 0,
      cacheSupported: false,
      sessionName: "ask-test",
      contentWidth: 118,
      colors: theme.colors,
      maxInputLines: 3,
      composerTokenVisuals: visuals,
      uiText: createUiText("en"),
      keyBindings: [],
      onSubmit: () => {},
      onModelClick: () => {},
      commandOverlayVisible: false,
      commandPicker: false,
      promptSelect: false,
      promptSecret: false,
    })));
    await setup.flush({ maxPasses: 100 });
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    return {
      frame: setup.captureCharFrame(),
      activity: spans.find((span) => span.text.includes(phase)),
      waitingStatus: theme.colors.waitingStatus,
      dim: theme.colors.dim,
    };
  } finally {
    flushSync(() => root.unmount());
    setup.renderer.destroy();
    visuals.syntaxStyle.destroy();
    theme.markdownStyle.destroy();
  }
}

describe("ask panel placement", () => {
  it("mounts the ask panel exactly once", () => {
    expect(askMountCount()).toBe(1);
  });

  it("keeps the ask panel out of the conversation scroll block", () => {
    expect(initializerOf("overlaysBlock") ?? "").not.toContain("<AskPanelView");
  });

  it("declares the ask panel as its own footer block", () => {
    expect(initializerOf("askPanelBlock") ?? "").toContain("<AskPanelView");
  });

  it("swaps the Tasks/Agents footer slot while an ask is pending", () => {
    const footer = initializerOf("footerStatusBlock") ?? "";
    expect(footer).toContain("pendingAsk");
    expect(footer).toContain("askPanelBlock");
    expect(footer).toContain("statusPanel");
  });
});

describe("asking activity indicator", () => {
  it("paints `Asking` with the waiting-for-answer color instead of dim", async () => {
    const rendered = await activitySpan("Asking");
    expect(rendered.frame).toMatch(/[◉◎] Asking/);
    expect(rendered.activity?.fg?.toString()).toBe(RGBA.fromHex(rendered.waitingStatus).toString());
    expect(rendered.waitingStatus).not.toBe(rendered.dim);
  });

  it("keeps `Working` on its own color", async () => {
    const rendered = await activitySpan("Working");
    expect(rendered.activity?.fg?.toString()).toBe(RGBA.fromHex(getCommonColors().workingStatus).toString());
  });
});
