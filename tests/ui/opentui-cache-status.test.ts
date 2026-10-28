import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";

import { InputArea } from "../../external/opentui/input/input-area.js";
import { createComposerTokenVisuals } from "../../external/opentui/composer-tokens.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { createUiText } from "../../src/ui/text.js";

const source = ts.createSourceFile("app.tsx", readFileSync("external/opentui/app.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const variables = new Map<string, string>();
const screenProps = new Map<string, string>();
let sameChildrenSource = "";
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    variables.set(node.name.text, node.initializer.getText(source));
  }
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "OpenTuiScreen") {
    for (const prop of node.attributes.properties) {
      if (ts.isJsxAttribute(prop) && prop.initializer && ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
        screenProps.set(prop.name.getText(source), prop.initializer.expression.getText(source));
      }
    }
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "sameChildSessionList") sameChildrenSource = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);

interface ChildUsage {
  inputTokens: number;
  lastTotalTokens: number;
  cacheReadTokens: number;
  cacheSupported: boolean;
}
interface CacheProps {
  contextTokens: number;
  cacheInputTokens: number;
  cacheReadTokens: number;
  cacheSupported: boolean;
}

// 执行 App 的实际选择表达式，避免测试复制一份主/子代理判断。
const selectCacheProps = new Function(
  "childSnapshot", "selectedChildId", "contextTokens", "cacheInputTokens", "cacheReadTokens", "session",
  ["effectiveContextTokens", "effectiveCacheReadTokens", "effectiveCacheSupported"]
    .map((key) => `const ${key} = ${variables.get(key)};`).join("\n")
    + `\nreturn {${["contextTokens", "cacheInputTokens", "cacheReadTokens", "cacheSupported"]
      .map((key) => `${key}: ${screenProps.get(key)}`).join(",")}};`,
) as (child: ChildUsage | null, selected: string | null, total: number, input: number, cached: number, session: { cacheSupported: boolean }) => CacheProps;

const sameChildren = new Function(
  ts.transpileModule(sameChildrenSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    + "\nreturn sameChildSessionList;",
)() as (a: ChildUsage[], b: ChildUsage[]) => boolean;

const child: ChildUsage = { inputTokens: 2000, lastTotalTokens: 2500, cacheReadTokens: 1000, cacheSupported: true };

describe("cache status for root and child pages", () => {
  it.each([
    { label: "root", snapshot: null, parentSupported: true, expected: "80.00%", context: 1250, input: 1000, cached: 800, supported: true },
    { label: "child hit independent of root support", snapshot: child, parentSupported: false, expected: "50.00%", context: 2500, input: 2000, cached: 1000, supported: true },
    { label: "child reported zero", snapshot: { ...child, cacheReadTokens: 0 }, parentSupported: true, expected: "0.00%", context: 2500, input: 2000, cached: 0, supported: true },
    { label: "child unreported metric", snapshot: { ...child, cacheReadTokens: 0, cacheSupported: false }, parentSupported: true, expected: "null", context: 2500, input: 2000, cached: 0, supported: false },
    { label: "child before first usage", snapshot: { inputTokens: 0, lastTotalTokens: 0, cacheReadTokens: 0, cacheSupported: false }, parentSupported: true, expected: "null", context: 0, input: 0, cached: 0, supported: false },
    { label: "root unreported metric", snapshot: null, parentSupported: false, expected: "null", context: 1250, input: 1000, cached: 800, supported: false },
  ])("renders $label", async ({ snapshot, parentSupported, expected, context, input, cached, supported }) => {
    const selectedChildId = snapshot ? "worker-1" : null;
    const props = selectCacheProps(snapshot, selectedChildId, 1250, 1000, 800, { cacheSupported: parentSupported });
    expect(props).toEqual({ contextTokens: context, cacheInputTokens: input, cacheReadTokens: cached, cacheSupported: supported });

    const theme = createDisplayTheme("dark");
    const visuals = createComposerTokenVisuals(theme.colors);
    const uiText = createUiText("en");
    const setup = await createTestRenderer({ width: 120, height: 12, useThread: false, consoleMode: "disabled" });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() => root.render(React.createElement(InputArea, {
        ...props,
        inputRef: React.createRef<TextareaRenderable>(),
        processing: false,
        pendingAsk: false,
        selectedChildId,
        phase: "idle",
        modelName: "test-model",
        thinkingSuffix: "",
        modelColor: theme.colors.text,
        elapsed: 0,
        cwd: ".",
        hint: null,
        contextLimit: 8192,
        sessionName: "cache-test",
        contentWidth: 118,
        colors: theme.colors,
        maxInputLines: 3,
        composerTokenVisuals: visuals,
        uiText,
        keyBindings: [],
        onSubmit: () => {},
        onModelClick: () => {},
        commandOverlayVisible: false,
        commandPicker: false,
        promptSelect: false,
        promptSecret: false,
      })));
      await setup.flush({ maxPasses: 100 });
      const label = `${uiText.get(["Views", "statusBar", "cacheHit"])}: `;
      const frame = setup.captureCharFrame();
      const statusLine = frame.split("\n").find((line) => line.includes(label));
      expect(statusLine?.slice(statusLine.indexOf(label) + label.length).trim().split(/\s+/)[0]).toBe(expected);
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      visuals.syntaxStyle.destroy();
      theme.markdownStyle.destroy();
    }
  });

  it.each([
    { label: "input tokens", change: { inputTokens: 2100 } },
    { label: "cached tokens", change: { cacheReadTokens: 1500 } },
    { label: "metric availability", change: { cacheSupported: false } },
  ])("refreshes child snapshots when only $label changes", ({ change }) => {
    expect(sameChildren([child], [{ ...child }])).toBe(true);
    expect(sameChildren([child], [{ ...child, ...change }])).toBe(false);
  });
});
