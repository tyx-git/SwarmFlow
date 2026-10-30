import { describe, expect, it } from "vitest";

import type { ReconciledConversationEntry } from "../../external/opentui/transcript/types.js";
import { presentationTransform } from "../../external/opentui/presentation/transform.js";

function reconciled(
  id: string,
  entry: ReconciledConversationEntry["entry"],
  contentVersion = 1,
): ReconciledConversationEntry {
  return { id, entry, contentVersion };
}

function handoff(conclusion: string, extra: Record<string, unknown> = {}): string {
  return [
    "```swarmflow-handoff",
    JSON.stringify({ conclusion, ...extra }),
    "```",
  ].join("\n");
}

function turnEnd(id: string, status: string, turnIndex = 1): ReconciledConversationEntry {
  return reconciled(id, {
    id,
    kind: "status",
    text: "",
    elapsedMs: 1200,
    meta: { turnEndStatus: status, turnIndex },
  });
}

describe("OpenTUI presentation transform", () => {
  it("strips a handoff and emits one tips entry at the completed turn boundary", () => {
    const result = presentationTransform([
      reconciled("asst", {
        id: "asst",
        kind: "assistant",
        text: `answer\n\n${handoff("stage summary")}`,
      }),
      turnEnd("end", "completed", 1),
    ], [], false, null);

    expect(result[0]).toMatchObject({ kind: "assistant", assistantText: "answer" });
    expect(result[1]).toMatchObject({ kind: "tips", tipsText: "stage summary" });
    expect(result[2]).toMatchObject({ kind: "turn_summary" });
    expect(result.filter((entry) => entry.kind === "tips")).toHaveLength(1);
  });

  it("keeps one tips per turn and uses the last valid conclusion", () => {
    const result = presentationTransform([
      reconciled("asst-1", {
        id: "asst-1",
        kind: "assistant",
        text: handoff("first"),
      }),
      reconciled("asst-2", {
        id: "asst-2",
        kind: "assistant",
        text: `final prose\n\n${handoff("last")}`,
      }),
      turnEnd("work-end", "completed", 7),
      turnEnd("turn-end", "completed", 7),
    ], [], false, null);

    expect(result.filter((entry) => entry.kind === "tips")).toHaveLength(1);
    expect(result.find((entry) => entry.kind === "tips")?.tipsText).toBe("last");
  });

  it("hides a streaming handoff without emitting tips before the turn ends", () => {
    const result = presentationTransform([
      reconciled("asst", {
        id: "asst",
        kind: "assistant",
        text: `answer\n\n${handoff("not yet")}`,
      }),
    ], [], true, "asst");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "assistant", assistantText: "answer" });
    expect(result.some((entry) => entry.kind === "tips")).toBe(false);
  });

  it("does not emit tips on failed or interrupted turns", () => {
    for (const status of ["error", "interrupted"]) {
      const result = presentationTransform([
        reconciled("asst", {
          id: "asst",
          kind: "assistant",
          text: handoff("should not show"),
        }),
        turnEnd(`end-${status}`, status),
      ], [], false, null);

      expect(result.some((entry) => entry.kind === "tips"), status).toBe(false);
      expect(result.some((entry) => entry.kind === "assistant"), status).toBe(false);
      expect(JSON.stringify(result), status).not.toContain("should not show");
    }
  });

  it("does not emit tips in child-session transcripts", () => {
    const result = presentationTransform([
      reconciled("asst", {
        id: "asst",
        kind: "assistant",
        text: `child prose\n\n${handoff("child summary")}`,
      }),
      turnEnd("end", "completed"),
    ], [], false, null, false);

    expect(result[0]).toMatchObject({ kind: "assistant", assistantText: "child prose" });
    expect(result.some((entry) => entry.kind === "tips")).toBe(false);
  });

  it("strips handoff blocks from agent result previews and full text", () => {
    const result = presentationTransform([
      reconciled("ar", {
        id: "ar",
        kind: "agent_result",
        text: `child prose\n\n${handoff("child conclusion")}`,
        fullText: `child prose\n\n${handoff("child conclusion")}`,
        meta: { agentId: "scout-1", outcome: "completed", elapsedMs: 1000 },
      }),
    ], [], false, null);

    expect(result[0]).toMatchObject({
      kind: "tool_operation",
      toolInlineResult: { text: "child prose" },
      toolResultFullText: "child prose",
    });
  });

  it("places the single tips entry after all visible work in the request", () => {
    const result = presentationTransform([
      reconciled("asst", {
        id: "asst",
        kind: "assistant",
        text: `answer\n\n${handoff("final summary")}`,
      }),
      reconciled("tc", {
        id: "tc",
        kind: "tool_call",
        text: "bash",
        meta: {
          toolName: "bash",
          toolCallId: "call-1",
          toolArgs: { command: "npm test" },
          toolExecState: "completed",
          toolStreamState: "closed",
        },
      }),
      reconciled("tr", {
        id: "tr",
        kind: "tool_result",
        text: "ok",
        meta: { toolName: "bash", toolCallId: "call-1", isError: false },
      }),
      turnEnd("end", "completed"),
    ], [], false, null);

    const kinds = result.map((entry) => entry.kind);
    expect(kinds).toEqual(["assistant", "tool_operation", "tips", "turn_summary"]);
    expect(result[2]?.tipsText).toBe("final summary");
  });

  it("drops an agent result preview that consists only of a handoff", () => {
    const result = presentationTransform([
      reconciled("ar", {
        id: "ar",
        kind: "agent_result",
        text: handoff("child conclusion"),
        fullText: handoff("child conclusion"),
        meta: { agentId: "scout-1", outcome: "completed", elapsedMs: 1000 },
      }),
    ], [], false, null);

    expect(result[0]).toMatchObject({
      kind: "tool_operation",
      toolInlineResult: null,
      toolResultFullText: "",
    });
  });

  it("does not require open_questions in a root handoff", () => {
    const result = presentationTransform([
      reconciled("asst", {
        id: "asst",
        kind: "assistant",
        text: handoff("root summary only"),
      }),
      turnEnd("end", "completed"),
    ], [], false, null);

    expect(result.find((entry) => entry.kind === "tips")?.tipsText).toBe("root summary only");
  });

  it("keeps failed turn summaries out of the normal Worked state", () => {
    const result = presentationTransform([
      reconciled("work-error", {
        id: "work-error",
        kind: "status",
        text: "",
        elapsedMs: 1200,
        meta: { turnEndStatus: "error" },
      }),
    ], [], false, null);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "turn_summary",
      turnSummaryError: true,
      turnSummaryInterrupted: false,
      turnSummaryText: "Failed · 1s",
    });
  });

  it("treats an unknown turn status as a failure", () => {
    const result = presentationTransform([
      reconciled("work-unknown", {
        id: "work-unknown",
        kind: "status",
        text: "",
        elapsedMs: 0,
        meta: { turnEndStatus: "unknown" },
      }),
    ], [], false, null);

    expect(result[0]).toMatchObject({
      state: "error",
      turnSummaryError: true,
      turnSummaryText: "Failed · 0s",
    });
  });

  it("does not keep a completed tool active just because activeEntryId still points at its tool_call", () => {
    const entries: ReconciledConversationEntry[] = [
      reconciled("tc-old", {
        id: "tc-old",
        kind: "tool_call",
        text: "bash mkdir -p /tmp/demo",
        meta: {
          toolName: "bash",
          toolCallId: "call-old",
          toolArgs: { command: "mkdir -p /tmp/demo" },
          toolExecState: "completed",
          toolStreamState: "closed",
        },
      }),
      reconciled("tr-old", {
        id: "tr-old",
        kind: "tool_result",
        text: "OK",
        meta: {
          toolName: "bash",
          toolCallId: "call-old",
          isError: false,
        },
      }),
      reconciled("tc-new", {
        id: "tc-new",
        kind: "tool_call",
        text: "write_file /tmp/demo.txt",
        meta: {
          toolName: "write_file",
          toolCallId: "call-new",
          toolArgs: { path: "/tmp/demo.txt", content: "hello" },
          toolExecState: "running",
          toolStreamState: "closed",
        },
      }),
    ];

    const result = presentationTransform(entries, [], true, "tc-old");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      kind: "tool_operation",
      toolDisplayName: "Run",
      state: "done",
    });
    expect(result[1]).toMatchObject({
      kind: "tool_operation",
      toolDisplayName: "Write",
      state: "active",
    });
  });

  it("maps agent_result entries to tool_operation entries using structured meta", () => {
    const entries: ReconciledConversationEntry[] = [
      reconciled("ar-001", {
        id: "ar-001",
        kind: "agent_result",
        text: "[Agent \"reviewer-1\" interrupted by the user]\nline 1\nline 2",
        fullText: "[Agent \"reviewer-1\" interrupted by the user]\nline 1\nline 2",
        meta: {
          agentId: "reviewer-1",
          outcome: "interrupted",
          cause: "user_mass_interrupt",
          elapsedMs: 4200,
        },
      }),
    ];

    const result = presentationTransform(entries, [], false, null);

    expect(result).toEqual([
      {
        id: "ar-001",
        contentVersion: 1,
        kind: "tool_operation",
        state: "done",
        toolDisplayName: "Agent Complete",
        toolCategory: "orchestrate",
        toolText: "reviewer-1",
        toolSuffix: "(4.2s, interrupted)",
        toolInterrupted: true,
        toolAgentName: "reviewer-1",
        toolInlineResult: {
          text: "[Agent \"reviewer-1\" interrupted by the user]\nline 1\nline 2",
          dim: false,
          maxLines: 8,
        },
        toolResultFullText: "[Agent \"reviewer-1\" interrupted by the user]\nline 1\nline 2",
      },
    ]);
  });

  it("marks truncated agent_result previews as expandable while preserving received message text", () => {
    const receivedMessage = Array.from(
      { length: 12 },
      (_, idx) => idx === 0 ? "[Agent \"docs-scout\" completed]" : `line ${idx}`,
    ).join("\n");
    const preview = receivedMessage.split("\n").slice(0, 8).join("\n");

    const entries: ReconciledConversationEntry[] = [
      reconciled("ar-002", {
        id: "ar-002",
        kind: "agent_result",
        text: preview,
        fullText: receivedMessage,
        meta: {
          agentId: "docs-scout",
          outcome: "completed",
          cause: "natural",
          elapsedMs: 196900,
          tuiPreviewTruncated: true,
        },
      }),
    ];

    const result = presentationTransform(entries, [], false, null);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tool_operation",
      toolDisplayName: "Agent Complete",
      toolText: "docs-scout",
      toolSuffix: "(196.9s)",
      toolInlineResult: {
        text: preview,
        dim: false,
        maxLines: 8,
        truncated: true,
      },
      toolResultFullText: receivedMessage,
    });
  });

  it("does not truncate ask inline previews", () => {
    const entries: ReconciledConversationEntry[] = [
      reconciled("tc-ask", {
        id: "tc-ask",
        kind: "tool_call",
        text: "ask",
        meta: {
          toolName: "ask",
          toolCallId: "call-ask",
          toolArgs: {
            questions: [
              {
                question: "你最喜欢的编程语言是什么？",
                options: [
                  { label: "Python" },
                  { label: "JavaScript/TypeScript" },
                  { label: "Rust" },
                ],
              },
            ],
          },
          toolExecState: "completed",
          toolStreamState: "closed",
        },
      }),
      reconciled("tr-ask", {
        id: "tr-ask",
        kind: "tool_result",
        text: [
          "Q: 你最喜欢的编程语言是什么？",
          "  ○ Python",
          "  ● JavaScript/TypeScript",
          "  ○ Rust",
          "  ○ Go",
          "  ○ C++",
          "  ○ 其他",
        ].join("\n"),
        fullText: [
          "Question 1: \"你最喜欢的编程语言是什么？\"",
          "Answer: JavaScript/TypeScript",
        ].join("\n"),
        meta: {
          toolName: "ask",
          toolCallId: "call-ask",
          isError: false,
        },
      }),
    ];

    const result = presentationTransform(entries, [], false, null);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "tool_operation",
      toolDisplayName: "Ask",
      toolInlineResult: {
        text: entries[1].entry.text,
        dim: false,
        maxLines: Number.POSITIVE_INFINITY,
      },
      toolResultFullText: entries[1].entry.fullText,
    });
  });
});
