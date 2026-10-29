import { describe, expect, it } from "vitest";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";

import { createError, createWorkEnd } from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { projectToTuiEntries } from "../../src/context/projection/tui.js";
import { TurnSummaryEntry } from "../../external/opentui/components/entry/turn-summary-entry.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { presentationTransform } from "../../external/opentui/presentation/transform.js";
import type { PresentationEntry } from "../../external/opentui/presentation/types.js";
import { reconcileEntries } from "../../external/opentui/transcript/reconcile.js";

function transform(log: LogEntry[], previous: PresentationEntry[] = []): PresentationEntry[] {
  return presentationTransform(reconcileEntries([], projectToTuiEntries(log)), previous, false, null);
}

function failureLog(errorFirst = false): LogEntry[] {
  const workEnd = createWorkEnd("we-1", 1, "work-1", "error", 1000);
  const error = createError("err-1", 1, "Connection error.", "turn");
  return errorFirst ? [error, workEnd] : [workEnd, error];
}

function summaryText(entries: PresentationEntry[]): string | undefined {
  const summaries = entries.filter((entry) => entry.kind === "turn_summary");
  expect(summaries).toHaveLength(1);
  return summaries[0]!.turnSummaryText;
}

describe("failed turn summary merging", () => {
  it.each([
    { label: "loop failure (summary then error)", errorFirst: false },
    { label: "pre-loop failure (error then summary)", errorFirst: true },
  ])("renders one line for $label", ({ errorFirst }) => {
    const result = transform(failureLog(errorFirst));
    expect(result.filter((entry) => entry.kind === "turn_summary")).toEqual([
      expect.objectContaining({
        id: "we-1",
        turnSummaryText: "Failed · 1s — Connection error.",
        turnSummaryError: true,
      }),
    ]);
    expect(result.filter((entry) => entry.kind === "system" && entry.systemSeverity === "error")).toEqual([]);
  });

  it("does not merge errors from another turn or command errors", () => {
    const crossTurn = transform([
      createWorkEnd("we-1", 1, "work-1", "error", 1000),
      createError("err-2", 2, "Other turn failed", "turn"),
    ]);
    expect(summaryText(crossTurn)).toBe("Failed · 1s");
    expect(crossTurn.filter((entry) => entry.kind === "system" && entry.systemSeverity === "error"))
      .toEqual([expect.objectContaining({ systemText: "Other turn failed" })]);

    const commandError = transform([
      createError("cmd-err", 1, "Command failed: /model", "command"),
      ...failureLog(),
    ]);
    expect(summaryText(commandError)).toBe("Failed · 1s — Connection error.");
    expect(commandError.filter((entry) => entry.kind === "system" && entry.systemSeverity === "error"))
      .toEqual([expect.objectContaining({ systemText: "Command failed: /model" })]);
  });

  it("keeps the standalone error when the turn completed", () => {
    const result = transform([
      createWorkEnd("we-1", 1, "work-1", "completed", 1000),
      createError("err-1", 1, "Connection error.", "turn"),
    ]);
    expect(summaryText(result)).toBe("Worked for 1s");
    expect(result.filter((entry) => entry.kind === "system" && entry.systemSeverity === "error"))
      .toEqual([expect.objectContaining({ systemText: "Connection error." })]);
  });

  it("collapses multiline error text into the summary line", () => {
    const result = transform([
      createWorkEnd("we-1", 1, "work-1", "error", 1000),
      createError("err-1", 1, "upstream\n  failed\tnow", "turn"),
    ]);
    expect(summaryText(result)).toBe("Failed · 1s — upstream failed now");
  });

  it("refreshes the summary when the error entry arrives after the first render", () => {
    const workEnd = createWorkEnd("we-1", 1, "work-1", "error", 1000);
    const first = transform([workEnd]);
    expect(summaryText(first)).toBe("Failed · 1s");

    const second = transform([workEnd, createError("err-1", 1, "Connection error.", "turn")], first);
    expect(summaryText(second)).toBe("Failed · 1s — Connection error.");
    expect(second.filter((entry) => entry.kind === "system" && entry.systemSeverity === "error")).toEqual([]);
  });

  it("renders the merged summary as a single error line", async () => {
    const merged = transform(failureLog()).find((entry) => entry.kind === "turn_summary");
    expect(merged).toBeTruthy();

    const theme = createDisplayTheme("dark");
    const setup = await createTestRenderer({ width: 120, height: 6, useThread: false, consoleMode: "disabled" });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() => root.render(React.createElement(TurnSummaryEntry, {
        entry: merged!,
        colors: theme.colors,
        interruptionText: "Interrupted",
      })));
      await setup.flush({ maxPasses: 100 });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Failed · 1s — Connection error.");
      expect(frame.split("Connection error.").length - 1).toBe(1);
    } finally {
      flushSync(() => root.unmount());
      setup.renderer.destroy();
      theme.markdownStyle.destroy();
    }
  });
});
