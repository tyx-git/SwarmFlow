import { describe, expect, it } from "bun:test";

import { buildActiveContextView } from "../src/active-context.js";
import {
  createAssistantText,
  createInputReceived,
  createSummary,
  createUserMessage,
  type LogEntry,
} from "../src/log-entry.js";

describe("buildActiveContextView", () => {
  it("inserts summaries where their covered context originally appeared", () => {
    const entries: LogEntry[] = [
      createUserMessage("user-001", 1, "old", "old", "c1"),
      createAssistantText("asst-001", 1, 0, "old reply", "old reply", "c1"),
      createUserMessage("user-002", 2, "new", "new", "c2"),
      createSummary(
        "sum-001",
        3,
        "Summary",
        "Summary",
        "s1",
        ["c1"],
        1,
        { summaryOrigin: "manual", coveredTurnStart: 1, coveredTurnEnd: 1 },
      ),
    ];

    const view = buildActiveContextView(entries);
    expect(view.order).toEqual(["s1", "c2"]);
  });

  it("keeps summary turn spans anchored to the covered range", () => {
    const entries: LogEntry[] = [
      createUserMessage("user-001", 1, "old", "old", "c1"),
      createSummary(
        "sum-001",
        5,
        "Summary",
        "Summary",
        "s1",
        ["c1"],
        1,
        { summaryOrigin: "manual", coveredTurnStart: 1, coveredTurnEnd: 1 },
      ),
      createAssistantText("asst-001", 5, 0, "compressed", "compressed", "s1"),
    ];

    const summaryGroup = buildActiveContextView(entries).groups[0];
    expect(summaryGroup.contextId).toBe("s1");
    expect(summaryGroup.turnStart).toBe(1);
    expect(summaryGroup.turnEnd).toBe(1);
    expect(summaryGroup.entries.map(({ entry }) => entry.id)).toEqual(["sum-001", "asst-001"]);
  });

  it("supports nested summaries that cover earlier summaries", () => {
    const entries: LogEntry[] = [
      createAssistantText("asst-001", 1, 0, "first", "first", "c1"),
      createAssistantText("asst-002", 1, 0, "second", "second", "c2"),
      createSummary(
        "sum-001",
        1,
        "First summary",
        "First summary",
        "s1",
        ["c1"],
        1,
        { summaryOrigin: "agent", coveredTurnStart: 1, coveredTurnEnd: 1 },
      ),
      createSummary(
        "sum-002",
        1,
        "Second summary",
        "Second summary",
        "s2",
        ["s1", "c2"],
        2,
        { summaryOrigin: "agent", coveredTurnStart: 1, coveredTurnEnd: 1 },
      ),
    ];

    const view = buildActiveContextView(entries);
    expect(view.order).toEqual(["s2"]);
  });

  it("assigns summaries to the nearest preceding surviving user-message turn", () => {
    const entries: LogEntry[] = [
      createUserMessage("user-001", 1, "anchor", "anchor", "u1"),
      createUserMessage("user-002", 2, "swallowed", "swallowed", "c1"),
      createAssistantText("asst-001", 2, 0, "work", "work", "c2"),
      createSummary(
        "sum-001",
        3,
        "Summary",
        "Summary",
        "s1",
        ["c1", "c2"],
        1,
        { summaryOrigin: "manual", coveredTurnStart: 2, coveredTurnEnd: 2 },
      ),
    ];

    const view = buildActiveContextView(entries);
    const anchor = view.groupByContextId.get("u1")!;
    const summary = view.groupByContextId.get("s1")!;
    expect(anchor.assignedTurn).toBe(1);
    expect(summary.assignedTurn).toBe(1);
    // Covered turn span is preserved as metadata.
    expect(summary.turnStart).toBe(2);
    expect(summary.turnEnd).toBe(2);
  });

  it("does not treat system notices as anchors for summary assignment", () => {
    const entries: LogEntry[] = [
      createUserMessage("user-001", 1, "anchor", "anchor", "u1"),
      createUserMessage("notice-001", 2, "[System]", "<system-message>note</system-message>", "n1", { inputKind: "system" }),
      createUserMessage("user-002", 3, "swallowed", "swallowed", "c1"),
      createSummary(
        "sum-001",
        4,
        "Summary",
        "Summary",
        "s1",
        ["c1"],
        1,
        { summaryOrigin: "manual", coveredTurnStart: 3, coveredTurnEnd: 3 },
      ),
    ];

    const view = buildActiveContextView(entries);
    const notice = view.groupByContextId.get("n1")!;
    const summary = view.groupByContextId.get("s1")!;
    expect(notice.hasUserMessage).toBe(false);
    expect(summary.assignedTurn).toBe(1);
  });

  it("orders queued input after current turn's assistant group", () => {
    // Simulates: user A sends message (turn 1), AI is processing,
    // user B sends message (turn 2, queued — input_received written immediately),
    // then AI finishes text-only reply (turn 1, own context_id).
    const entries: LogEntry[] = [
      createInputReceived("ir-001", 1, "ir-001", "user", "Question?", "Question?", "cA"),
      createUserMessage("user-001", 1, "Question?", "Question?", "cA"),
      createInputReceived("ir-002", 2, "ir-002", "user", "Follow-up", "Follow-up", "cB"),
      createAssistantText("asst-001", 1, 0, "Answer", "Answer", "cR"),
      createUserMessage("user-002", 2, "Follow-up", "Follow-up", "cB"),
    ];

    const view = buildActiveContextView(entries);
    expect(view.order).toEqual(["cA", "cR", "cB"]);
  });
});
