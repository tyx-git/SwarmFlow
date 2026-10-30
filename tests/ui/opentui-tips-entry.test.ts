import { describe, expect, it } from "vitest";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import { createTextAttributes, RGBA } from "@opentui/core";

import { TipsEntry, TIPS_MAX_LINES } from "../../external/opentui/components/entry/tips-entry.js";
import { PresentationPanel } from "../../external/opentui/components/entry/presentation-panel.js";
import { wrapToLines } from "../../external/opentui/display/utils/format.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import type { PresentationEntry } from "../../external/opentui/presentation/types.js";

function tipsEntry(text: string): PresentationEntry {
  return {
    id: "tips-test",
    contentVersion: 1,
    kind: "tips",
    state: "done",
    tipsText: text,
  };
}

describe("tips entry", () => {
  it("uses the #949494 italic tips style in every built-in theme", () => {
    for (const mode of ["brief", "dark", "light"] as const) {
      expect(createDisplayTheme(mode).colors.tips).toBe("#949494");
    }
  });

  it("renders the `└ Tips:` prefix and italic summary", async () => {
    const theme = createDisplayTheme("dark");
    const setup = await createTestRenderer({ width: 80, height: 10, useThread: false, consoleMode: "disabled" });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() => root.render(React.createElement(TipsEntry, {
        entry: tipsEntry("stage summary"),
        colors: theme.colors,
        contentWidth: 70,
      })));
      await setup.flush({ maxPasses: 100 });

      const frame = setup.captureCharFrame();
      expect(frame).toContain("└ Tips: stage summary");

      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const prefix = spans.find((span) => span.text.includes("Tips:"));
      const summary = spans.find((span) => span.text.includes("stage summary"));
      expect(prefix?.attributes).toBe(createTextAttributes({ italic: true }));
      expect(summary?.attributes).toBe(createTextAttributes({ italic: true }));
      expect(prefix?.fg?.toString()).toBe(RGBA.fromHex(theme.colors.tips).toString());
      expect(summary?.fg?.toString()).toBe(RGBA.fromHex(theme.colors.tips).toString());
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      theme.markdownStyle.destroy();
    }
  });

  it("attaches directly below the assistant entry without a blank line", async () => {
    const theme = createDisplayTheme("dark");
    const setup = await createTestRenderer({ width: 80, height: 12, useThread: false, consoleMode: "disabled" });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() => root.render(React.createElement(PresentationPanel, {
        items: [
          {
            id: "previous",
            contentVersion: 1,
            kind: "user",
            state: "done",
            userText: "answer",
          },
          tipsEntry("stage summary"),
        ],
        colors: theme.colors,
        interruptionText: "",
        theme,
        contentWidth: 70,
        diffDisplayMode: "compact",
        markdownStyle: theme.markdownStyle,
        processing: false,
        selectedChildId: null,
        showLogoInScroll: false,
        branding: theme.branding,
      })));
      await setup.flush({ maxPasses: 100 });

      const lines = setup.captureCharFrame().split("\n");
      const answerIndex = lines.findIndex((line) => line.includes("answer"));
      const tipsIndex = lines.findIndex((line) => line.includes("Tips:"));
      expect(answerIndex).toBeGreaterThanOrEqual(0);
      expect(tipsIndex).toBe(answerIndex + 1);
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      theme.markdownStyle.destroy();
    }
  });

  it("caps the summary at four lines and appends an ellipsis", async () => {
    const theme = createDisplayTheme("dark");
    const setup = await createTestRenderer({ width: 60, height: 12, useThread: false, consoleMode: "disabled" });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() => root.render(React.createElement(TipsEntry, {
        entry: tipsEntry("长".repeat(1000)),
        colors: theme.colors,
        contentWidth: 50,
      })));
      await setup.flush({ maxPasses: 100 });

      const frame = setup.captureCharFrame();
      const summaryLines = frame.split("\n").filter((line) => line.includes("长"));
      expect(summaryLines.length).toBe(TIPS_MAX_LINES);
      expect(frame).toContain("…");
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      theme.markdownStyle.destroy();
    }
  });

  it("wraps by display width and reports truncation", () => {
    const short = wrapToLines("short", 20, 4);
    expect(short).toEqual({ lines: ["short"], truncated: false });

    const long = wrapToLines("中".repeat(20), 6, 4);
    expect(long.lines).toHaveLength(4);
    expect(long.truncated).toBe(true);
    expect(long.lines.at(-1)?.endsWith("…")).toBe(true);
  });
});
