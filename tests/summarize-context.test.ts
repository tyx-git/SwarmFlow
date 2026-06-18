import { describe, expect, it } from "bun:test";

import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createSummary,
  createSystemPrompt,
  createToolCall,
  createToolResult,
  createUserMessage,
  type LogEntry,
} from "../src/log-entry.js";
import { execSummarizeContextOnLog, truncateSummarizeContextContent } from "../src/summarize-context.js";

function allocIds(prefix: string): () => string {
  let i = 0;
  return () => `${prefix}${++i}`;
}

describe("truncateSummarizeContextContent", () => {
  it("keeps short content unchanged", () => {
    const text = "short content";
    expect(truncateSummarizeContextContent(text)).toBe(text);
  });

  it("truncates long content at space boundary and includes context reference", () => {
    const text = "A".repeat(95) + " word " + "B".repeat(80);
    const out = truncateSummarizeContextContent(text, "ctx9");
    expect(out).toContain("truncated");
    expect(out).toContain("context_id ctx9");
    expect(out.length).toBeLessThan(text.length);
  });

  it("hard-truncates at 120 chars when no space found", () => {
    const text = "A".repeat(200);
    const out = truncateSummarizeContextContent(text);
    // 120 chars of A + suffix
    expect(out.startsWith("A".repeat(120))).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("execSummarizeContextOnLog", () => {
  it("manual summarize can cover a user-selected range", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c1", to: "c1", content: "compressed" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
      { origin: "manual", exactRange: { from: "c1", to: "c1", contextIds: ["c1"] } },
    );

    expect(result.output).toContain("1 succeeded");
    expect(result.newEntries.length).toBe(1);
    expect(result.newEntries[0].type).toBe("summary");
    const meta = result.newEntries[0].meta as Record<string, unknown>;
    expect(meta["summaryDepth"]).toBe(1);
    expect(meta["summaryOrigin"]).toBe("manual");
    expect(result.newEntries[0].display).toStartWith("[Summarized context");
  });

  it("rejects manual summarize calls that shrink the selected range", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "first", "first", "c1"),
      createUserMessage("user-002", 2, "second", "second", "c2"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c1", to: "c1", content: "too small" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      2,
      { origin: "manual", exactRange: { from: "c1", to: "c2", contextIds: ["c1", "c2"] } },
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("must use exactly");
  });

  it("rejects autonomous summaries that cover user messages", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c1", to: "c1", content: "compressed" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("contains user messages");
  });

  it("skips compact_context entries (not indexable by context ID)", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "old1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createCompactContext("cc-001", 1, "continuation", "cc1", 0),
      createUserMessage("user-002", 1, "new", "new", "u2"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "cc1", to: "cc1", content: "compact summarized" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("not found");
  });

  it("compresses a tool round sharing a single context ID", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "Checking", "Checking", "c7"),
      createToolCall(
        "tc-001",
        1,
        0,
        "read_file",
        { id: "call_1", name: "read_file", arguments: { path: "x.ts" } },
        { toolCallId: "call_1", toolName: "read_file", agentName: "agent", contextId: "c7" },
      ),
      createToolResult(
        "tr-001",
        1,
        0,
        { toolCallId: "call_1", toolName: "read_file", content: "source", toolSummary: "read" },
        { isError: false, contextId: "c7" },
      ),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c7", to: "c7", content: "tool round summarized" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
  });

  it("rejects autonomous summaries that cross user turns", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "turn one", "turn one", "c1"),
      createAssistantText("asst-002", 2, 0, "turn two", "turn two", "c2"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c1", to: "c2", content: "cross turn" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      2,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("one operation per turn");
  });

  it("expands from/to range to include all context IDs between them", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "first", "first", "c1"),
      createAssistantText("asst-002", 1, 0, "second", "second", "c2"),
      createAssistantText("asst-003", 1, 0, "third", "third", "c3"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c1", to: "c2", content: "turns 1 and 2 summarized" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect(result.newEntries.length).toBe(1);
    // c3 should not be covered
    const coveredIds = (result.newEntries[0].meta as Record<string, unknown>)["coveredContextIds"] as string[];
    expect(coveredIds).toContain("c1");
    expect(coveredIds).toContain("c2");
    expect(coveredIds).not.toContain("c3");
  });

  it("rejects non-contiguous contexts (from/to spanning a gap is fine — it includes everything)", () => {
    // With from/to, a range that spans c1..c3 will include c2 automatically.
    // This test verifies from/to expands correctly, not that it rejects.
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "a", "a", "c1"),
      createAssistantText("asst-001", 1, 0, "gap", "gap", "c2"),
      createAssistantText("asst-002", 1, 0, "b", "b", "c3"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c1", to: "c3", content: "all three" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    // Should succeed — c1..c3 includes c2
    expect(result.output).toContain("1 succeeded");
  });

  it("rejects contexts before the last compact marker", () => {
    // old1 is before the compact marker and covered by summary → not in spatial order
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "old1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createSummary("sum-keep", 1, "kept", "kept", "new1", ["old1"], 1),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "old1", to: "old1", content: "hidden" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("not found");
  });

  it("rejects duplicate references within the same call", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      {
        operations: [
          { from: "c1", to: "c1", content: "first" },
          { from: "c1", to: "c1", content: "second" },
        ],
      },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded, 1 failed");
    expect(result.output).toContain("already referenced by another operation");
  });

  it("supports re-compression with depth tracking", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "hello", "hello", "c1"),
    ];
    const ctxAlloc = allocIds("ctx-");
    const logAlloc = allocIds("sum-");

    const first = execSummarizeContextOnLog(
      { operations: [{ from: "c1", to: "c1", content: "first summarized" }] },
      entries,
      ctxAlloc,
      logAlloc,
      1,
    );
    entries.push(...first.newEntries);
    const firstSummaryId = first.results[0].newContextId!;

    const second = execSummarizeContextOnLog(
      { operations: [{ from: firstSummaryId, to: firstSummaryId, content: "second summarized" }] },
      entries,
      ctxAlloc,
      logAlloc,
      1,
    );

    expect(second.output).toContain("1 succeeded");
    expect(second.newEntries.length).toBe(1);
    expect((second.newEntries[0].meta as Record<string, unknown>)["summaryDepth"]).toBe(2);
  });

  it("allows autonomous summaries over system notices (not the user's own words)", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("notice-001", 1, "[System]", "<system-message>hint</system-message>", "n1", { inputKind: "system" }),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "n1", to: "n1", content: "old hint summarized" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
  });

  it("allows agents to re-summarize manual summaries (summaries are ordinary context)", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "hello", "hello", "c1"),
      createSummary("sum-manual", 1, "manual sum", "manual sum", "m1", ["c1"], 1, {
        summaryOrigin: "manual",
        coveredTurnStart: 1,
        coveredTurnEnd: 1,
      }),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "m1", to: "m1", content: "re-summarized" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect((result.newEntries[0].meta as Record<string, unknown>)["summaryDepth"]).toBe(2);
  });

  it("merges adjacent summaries whose covered anchors are gone (same assigned turn)", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "anchor", "anchor", "u1"),
      createUserMessage("user-002", 2, "a", "a", "a1"),
      createAssistantText("asst-001", 2, 0, "work-a", "work-a", "a2"),
      createUserMessage("user-003", 3, "b", "b", "b1"),
      createAssistantText("asst-002", 3, 0, "work-b", "work-b", "b2"),
      // Manual summaries swallowed turns 2 and 3 (including their user
      // messages), so both fold into surviving turn 1 and become mergeable.
      createSummary("sum-a", 4, "sumA", "sumA", "sA", ["a1", "a2"], 1, {
        summaryOrigin: "manual",
        coveredTurnStart: 2,
        coveredTurnEnd: 2,
      }),
      createSummary("sum-b", 4, "sumB", "sumB", "sB", ["b1", "b2"], 1, {
        summaryOrigin: "manual",
        coveredTurnStart: 3,
        coveredTurnEnd: 3,
      }),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "sA", to: "sB", content: "merged phases" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      4,
    );

    expect(result.output).toContain("1 succeeded");
    const meta = result.newEntries[0].meta as Record<string, unknown>;
    expect(meta["coveredContextIds"]).toEqual(["sA", "sB"]);
    expect(meta["summaryDepth"]).toBe(2);
  });

  it("returns a direct error when no operations are provided", () => {
    const result = execSummarizeContextOnLog(
      { operations: [] },
      [],
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toBe("Error: no operations provided.");
    expect(result.results[0].success).toBe(false);
  });

  it("handles multiple independent operations in one call", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "first msg", "first msg", "c1"),
      createAssistantText("asst-002", 1, 0, "second msg", "second msg", "c2"),
      createAssistantText("asst-003", 1, 0, "third msg", "third msg", "c3"),
    ];

    const result = execSummarizeContextOnLog(
      {
        operations: [
          { from: "c1", to: "c1", content: "Phase 1: initial exploration of the auth module, found strategy pattern in src/auth/provider.ts", reason: "phase 1 complete" },
          { from: "c2", to: "c2", content: "Phase 2: config analysis, roles.yaml at src/config/, no validation on load", reason: "phase 2 complete" },
        ],
      },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("2 submitted, 2 succeeded, 0 failed");
    expect(result.newEntries.length).toBe(2);
    expect(result.newEntries.every((e) => e.type === "summary")).toBe(true);
  });

  it("rejects when from appears after to in spatial order", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "a", "a", "c1"),
      createUserMessage("user-002", 1, "b", "b", "c2"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ from: "c2", to: "c1", content: "backwards" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("appears after");
  });

  it("rejects missing from/to fields", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ content: "no range" } as any] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("Missing required fields");
  });
});
