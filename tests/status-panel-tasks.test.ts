import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_TASKS,
  taskSpinnerGlyph,
  taskViewportHeight,
} from "../external/opentui/display/panels/status-panel.js";

describe("task status panel layout and presentation", () => {
  it("sizes the viewport to the task count and caps it at four rows", () => {
    expect(MAX_VISIBLE_TASKS).toBe(4);
    expect(taskViewportHeight(0)).toBe(0);
    expect(taskViewportHeight(1)).toBe(1);
    expect(taskViewportHeight(3)).toBe(3);
    expect(taskViewportHeight(4)).toBe(4);
    expect(taskViewportHeight(7)).toBe(4);
  });

  it("rotates the active spinner frames and wraps at the end", () => {
    expect(taskSpinnerGlyph(0)).toBe("✳");
    expect(taskSpinnerGlyph(1)).toBe("✴");
    expect(taskSpinnerGlyph(11)).toBe("✳");
  });

  it("renders task rows without protocol-style hash IDs and keeps completed feedback", () => {
    const source = readFileSync("external/opentui/display/panels/status-panel.tsx", "utf8");
    expect(source).toContain('const MARK_DONE = "✔";');
    expect(source).toContain("getCommonColors");
    expect(source).toContain("COMMON_COLORS.taskOpenText");
    expect(source).toContain("COMMON_COLORS.taskActiveText");
    expect(source).toContain('const MARK_PENDING = "□";');
    expect(source).toContain("COMMON_COLORS.taskDoneText");
    expect(source).toContain("COMMON_COLORS.taskIdText");
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
    expect(source).toContain("● ${tasks.length} tasks (${openTasks.length} open)");
    expect(source).toContain("height={Math.max(1, taskContentHeight)}");
    expect(source).toContain('const TASK_ROW_STATUS_INDENT = "  ";');
    expect(source).toContain("chunk(TASK_ROW_STATUS_INDENT)");
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
