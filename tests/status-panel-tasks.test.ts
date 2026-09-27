import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_TASKS,
  taskSpinnerGlyph,
  taskSummaryLabel,
  taskViewportHeight,
} from "../external/opentui/display/panels/status-panel.js";

describe("task status panel layout and presentation", () => {
  it("sizes the viewport to the task count and caps it at six rows", () => {
    expect(MAX_VISIBLE_TASKS).toBe(6);
    expect(taskViewportHeight(0)).toBe(0);
    expect(taskViewportHeight(1)).toBe(1);
    expect(taskViewportHeight(3)).toBe(3);
    expect(taskViewportHeight(6)).toBe(6);
    expect(taskViewportHeight(7)).toBe(6);
  });

  it("shows in-progress count instead of open count while a task is active", () => {
    expect(taskSummaryLabel(2, 5)).toBe("2 in progress");
    expect(taskSummaryLabel(0, 5)).toBe("5 open");
    expect(taskSummaryLabel(0, 0)).toBe("0 open");
  });

  it("rotates the active spinner frames and wraps at the end", () => {
    expect(taskSpinnerGlyph(0)).toBe("✳");
    expect(taskSpinnerGlyph(1)).toBe("✴");
    expect(taskSpinnerGlyph(11)).toBe("✳");
  });

  it("renders task rows without protocol-style hash IDs and keeps completed feedback", () => {
    const source = readFileSync("external/opentui/display/panels/status-panel.tsx", "utf8");
    expect(source).toContain('const MARK_DONE = "✔";');
    expect(source).toContain('const TASK_OPEN_TEXT = "#CCCCCC";');
    expect(source).toContain('const TASK_ACTIVE_TEXT = "#8ABEB7";');
    expect(source).toContain('const MARK_PENDING = "□";');
    expect(source).toContain('const TASK_DONE_TEXT = "#535354";');
    expect(source).toContain('const TASK_ID_TEXT = "#535354";');
    expect(source).toContain("chunks.push(chunk(`#${task.id} `, idColor))");
    expect(source).toContain("ATTRS_STRIKE");
    expect(source).toContain("TASK_SPINNER_INTERVAL_MS = 150");
    expect(source).toContain("React.useEffect(() => {");
    expect(source).toContain("{ordered.map((task) => {");
    expect(source).not.toContain("… and ${hiddenCount} more");
  });

  it("keeps task tool IDs intact because the hash was presentation-only", () => {
    const source = readFileSync("src/session.ts", "utf8");
    expect(source).toContain("Task #${task.id} created:");
    expect(source).toContain("#${task.id} [${task.status}]");
  });

  it("uses a title-only top line without a surrounding task box", () => {
    const source = readFileSync("external/opentui/display/panels/status-panel.tsx", "utf8");
    expect(source).not.toContain('borderStyle="rounded"');
    expect(source).not.toContain("border={true}");
    expect(source).toContain("● ${tasks.length} tasks (${taskSummaryLabel(inProgressCount, openTasks.length)})");
    expect(source).toContain("height={Math.max(1, taskContentHeight)}");
    expect(source).toContain('const TASK_ROW_STATUS_INDENT = "  ";');
    expect(source).toContain("chunk(TASK_ROW_STATUS_INDENT)");
    expect(source).toContain("taskSummaryLabel(inProgressCount, openTasks.length)");
  });
});


describe("useTasks mutable-store refresh regression", () => {
  it("clones store tasks before comparing React snapshots", () => {
    const source = readFileSync("external/opentui/presentation/use-tasks.ts", "utf8");
    expect(source).toContain("const snapshot = next.map(cloneTaskForUi);");
    expect(source).toContain("metadata: { ...task.metadata }");
    expect(source).toContain("function cloneTaskForUi(task: Task): Task");
    expect(source).toContain("a.blockedBy.some");
  });
});
