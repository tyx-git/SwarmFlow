import { describe, expect, it } from "bun:test";

import type { ReconciledConversationEntry } from "../opentui-src/transcript/types.js";
import { presentationTransform } from "../opentui-src/presentation/transform.js";

function reconciled(
  id: string,
  entry: ReconciledConversationEntry["entry"],
  contentVersion = 1,
): ReconciledConversationEntry {
  return { id, entry, contentVersion };
}

describe("OpenTUI presentation transform", () => {
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
      (_, idx) => idx === 0 ? "[Agent \"docs-explorer\" completed]" : `line ${idx}`,
    ).join("\n");
    const preview = receivedMessage.split("\n").slice(0, 8).join("\n");

    const entries: ReconciledConversationEntry[] = [
      reconciled("ar-002", {
        id: "ar-002",
        kind: "agent_result",
        text: preview,
        fullText: receivedMessage,
        meta: {
          agentId: "docs-explorer",
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
      toolText: "docs-explorer",
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
