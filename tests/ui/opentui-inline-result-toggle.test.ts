import { describe, expect, it } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";

import { InlineResult } from "../../external/opentui/components/entry/inline-result.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";

interface RenderableLike {
  content?: unknown;
  getChildren?: () => unknown[];
  /** OpenTUI stores mouse handlers in a set-only map. */
  _mouseListeners?: Record<string, (event: unknown) => void>;
}

function collectText(node: RenderableLike): string {
  const content = node.content;
  let own = "";
  if (typeof content === "string") {
    own = content;
  } else if (content && typeof content === "object" && Array.isArray((content as { chunks?: unknown }).chunks)) {
    own = ((content as { chunks: Array<{ text?: unknown }> }).chunks)
      .map((chunk) => typeof chunk.text === "string" ? chunk.text : "")
      .join("");
  }
  const children = node.getChildren?.() ?? [];
  return [own, ...children.map((child) => collectText(child as RenderableLike))].join("\n");
}

function findClickableWithText(node: RenderableLike, needle: string): RenderableLike | undefined {
  if (typeof node._mouseListeners?.["down"] === "function" && collectText(node).includes(needle)) {
    return node;
  }
  for (const child of node.getChildren?.() ?? []) {
    const found = findClickableWithText(child as RenderableLike, needle);
    if (found) return found;
  }
  return undefined;
}

describe("inline result fold toggle", () => {
  it("is clickable in both expanded and collapsed states", async () => {
    const theme = createDisplayTheme("dark");
    const setup = await createTestRenderer({
      width: 80,
      height: 20,
      useThread: false,
      consoleMode: "disabled",
    });
    const root = createRoot(setup.renderer);

    function Harness(): React.ReactNode {
      const [expanded, setExpanded] = React.useState(false);
      return React.createElement(InlineResult, {
        data: {
          text: ["line 1", "line 2", "line 3", "line 4"].join("\n"),
          dim: false,
          maxLines: 1,
        },
        colors: theme.colors,
        contentWidth: 72,
        expanded,
        onToggleExpand: () => setExpanded((value) => !value),
      });
    }

    try {
      flushSync(() => root.render(React.createElement(Harness)));
      await setup.flush({ maxPasses: 100 });

      const expandTarget = findClickableWithText(setup.renderer.root as RenderableLike, "CLICK to expand");
      expect(expandTarget, "collapsed fold indicator must be clickable").toBeTruthy();

      flushSync(() => {
        expandTarget!._mouseListeners?.["down"]?.({
          stopPropagation: () => {},
          preventDefault: () => {},
        });
      });
      await setup.flush({ maxPasses: 100 });

      const collapseTarget = findClickableWithText(setup.renderer.root as RenderableLike, "click to collapse");
      expect(collapseTarget, "expanded fold indicator must be clickable").toBeTruthy();

      flushSync(() => {
        collapseTarget!._mouseListeners?.["down"]?.({
          stopPropagation: () => {},
          preventDefault: () => {},
        });
      });
      await setup.flush({ maxPasses: 100 });

      expect(findClickableWithText(setup.renderer.root as RenderableLike, "CLICK to expand")).toBeTruthy();
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      theme.markdownStyle.destroy();
    }
  });
});
