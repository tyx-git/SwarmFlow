import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_TASKS,
  MAX_VISIBLE_AGENTS,
  agentViewportHeight,
  dismissSettledAgentIds,
  isSettledAgentSnapshot,
  statusPanelBodyHeight,
  syncDismissedAgentIds,
  taskSpinnerGlyph,
  taskViewportHeight,
} from "../external/opentui/display/panels/status-panel.js";

describe("task status panel layout and presentation", () => {
  const agentSnapshot = (overrides: Record<string, unknown> = {}) => ({
    id: "worker-1",
    numericId: 1,
    logRevision: 0,
    template: "scout",
    mode: "oneshot",
    lifecycle: "idle",
    phase: "idle",
    status: "completed",
    outcome: "completed",
    running: false,
    lifetimeToolCallCount: 0,
    lastTotalTokens: 0,
    lastToolCallSummary: "",
    recentEvents: [],
    pendingInboxCount: 0,
    lastActivityAt: 0,
    inputTokens: 0,
    contextBudget: 0,
    modelConfigName: "",
    modelProvider: "",
    pendingAskId: null,
    pendingAskKind: null,
    activeLogEntryId: null,
    turnElapsed: 0,
    cacheReadTokens: 0,
    ...overrides,
  }) as any;

  it("hides settled agents on the next user turn but keeps active ones visible", () => {
    const completed = agentSnapshot();
    const active = agentSnapshot({
      id: "worker-2",
      lifecycle: "running",
      status: "working",
      outcome: "none",
      running: true,
    });

    expect(isSettledAgentSnapshot(completed)).toBe(true);
    expect(isSettledAgentSnapshot(active)).toBe(false);
    expect(dismissSettledAgentIds(new Set(), [completed, active])).toEqual(new Set(["worker-1"]));
  });

  it("shows a dismissed agent again if it resumes and removes stale hidden IDs", () => {
    const resumed = agentSnapshot({
      lifecycle: "running",
      status: "working",
      outcome: "none",
      running: true,
    });
    expect(syncDismissedAgentIds(new Set(["worker-1", "removed"]), [resumed])).toEqual(new Set());
  });

  it("sizes the viewport to the task count and caps it at four rows", () => {
    expect(MAX_VISIBLE_TASKS).toBe(4);
    expect(taskViewportHeight(0)).toBe(0);
    expect(taskViewportHeight(1)).toBe(1);
    expect(taskViewportHeight(3)).toBe(3);
    expect(taskViewportHeight(4)).toBe(4);
    expect(taskViewportHeight(7)).toBe(4);
  });

  it("sizes agent rows to three entries and shares the taller panel height", () => {
    expect(MAX_VISIBLE_AGENTS).toBe(3);
    expect(agentViewportHeight(0)).toBe(0);
    expect(agentViewportHeight(1)).toBe(2);
    expect(agentViewportHeight(3)).toBe(6);
    expect(agentViewportHeight(8)).toBe(6);
    expect(statusPanelBodyHeight(4, 6, 8)).toBe(6);
    expect(statusPanelBodyHeight(9, 2, 8)).toBe(8);
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
    expect(source).toContain("const STATUS_PANEL_TITLE_COLOR = COMMON_COLORS.workingStatus;");
    expect(source).toContain("useShimmer");
    expect(source).toContain("agentIsCompleted");
    expect(source).toContain("agentIsFailed");
    expect(source).toContain("agentIsInterrupted");
    expect(source).not.toContain("agentStatusLabel");
    expect(source).not.toContain("lifecycleLabel");
    expect(source).toContain("width=\"60%\"");
    expect(source).toContain("<AgentList");
    expect(source).toContain("paddingTop={1}");
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
