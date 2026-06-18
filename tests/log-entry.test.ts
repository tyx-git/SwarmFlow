/**
 * Tests for LogEntry types, factory functions, and LogIdAllocator.
 */

import { describe, it, expect } from "bun:test";
import {
  LogIdAllocator,
  createSystemPrompt,
  createWorkStart,
  createWorkEnd,
  createInputReceived,
  createTurnStart,
  createTurnEnd,
  createUserMessage,
  createAgentResult,
  createAssistantText,
  createReasoning,
  createToolCall,
  createToolResult,
  createNoReply,
  createCompactMarker,
  createCompactContext,
  createSummary,
  createInterruptionMarker,
  createSubAgentStart,
  createSubAgentToolCall,
  createSubAgentEnd,
  createStatus,
  createError,
  createTokenUpdate,
  createAskRequest,
  createAskResolution,
  type LogEntry,
  type LogEntryType,
} from "../src/log-entry.js";

// ------------------------------------------------------------------
// LogIdAllocator
// ------------------------------------------------------------------

describe("LogIdAllocator", () => {
  it("generates sequential IDs with correct prefix", () => {
    const alloc = new LogIdAllocator();
    expect(alloc.next("user_message")).toBe("user-001");
    expect(alloc.next("user_message")).toBe("user-002");
    expect(alloc.next("tool_call")).toBe("tc-001");
    expect(alloc.next("user_message")).toBe("user-003");
    expect(alloc.next("tool_call")).toBe("tc-002");
  });

  it("restores counters from existing entries", () => {
    const alloc = new LogIdAllocator();
    const entries: LogEntry[] = [
      createUserMessage("user-005", 1, "hi", "hi", "c1"),
      createToolCall("tc-012", 1, 0, "summary", { id: "1", name: "bash", arguments: {} }, { toolCallId: "1", toolName: "bash", agentName: "a" }),
      createAssistantText("asst-003", 1, 0, "reply", "reply"),
    ];
    alloc.restoreFrom(entries);

    expect(alloc.next("user_message")).toBe("user-006");
    expect(alloc.next("tool_call")).toBe("tc-013");
    expect(alloc.next("assistant_text")).toBe("asst-004");
    // Types not seen should start at 001
    expect(alloc.next("reasoning")).toBe("rsn-001");
  });

  it("getCounter returns 0 for unseen types", () => {
    const alloc = new LogIdAllocator();
    expect(alloc.getCounter("error")).toBe(0);
  });
});

// ------------------------------------------------------------------
// Factory functions
// ------------------------------------------------------------------

describe("Factory functions", () => {
  it("createSystemPrompt", () => {
    const e = createSystemPrompt("sys-001", "You are helpful");
    expect(e.id).toBe("sys-001");
    expect(e.type).toBe("system_prompt");
    expect(e.turnIndex).toBe(0);
    expect(e.tuiVisible).toBe(false);
    expect(e.displayKind).toBeNull();
    expect(e.display).toBe("");
    expect(e.apiRole).toBe("system");
    expect(e.content).toBe("You are helpful");
    expect(e.archived).toBe(false);
  });

  it("createTurnStart", () => {
    const e = createTurnStart("ts-001", 1);
    expect(e.type).toBe("turn_start");
    expect(e.turnIndex).toBe(1);
    expect(e.tuiVisible).toBe(false);
    expect(e.apiRole).toBeNull();
    expect(e.meta.turnIndex).toBe(1);
  });

  it("createWorkStart", () => {
    const e = createWorkStart("ws-001", 1, "work-001");
    expect(e.type).toBe("work_start");
    expect(e.turnIndex).toBe(1);
    expect(e.tuiVisible).toBe(false);
    expect(e.apiRole).toBeNull();
    expect(e.meta.workId).toBe("work-001");
  });

  it("createWorkEnd", () => {
    const e = createWorkEnd("we-001", 2, "work-001", "completed", 1234);
    expect(e.type).toBe("work_end");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("status");
    expect(e.meta.workId).toBe("work-001");
    expect(e.meta.status).toBe("completed");
    expect(e.meta.elapsedMs).toBe(1234);
  });

  it("createInputReceived", () => {
    const e = createInputReceived("in-001", 1, "in-001", "user", "Hello", "Hello", "c1");
    expect(e.type).toBe("input_received");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("user");
    expect(e.apiRole).toBeNull();
    expect(e.meta.inputId).toBe("in-001");
    expect(e.meta.inputKind).toBe("user");
    expect(e.meta.contextId).toBe("c1");
  });

  it("createUserMessage", () => {
    const e = createUserMessage("user-001", 1, "Hello", "<ctx>Hello</ctx>", "c1");
    expect(e.type).toBe("user_message");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("user");
    expect(e.display).toBe("Hello");
    expect(e.apiRole).toBe("user");
    expect(e.content).toBe("<ctx>Hello</ctx>");
    expect(e.meta.contextId).toBe("c1");
  });

  it("createAgentResult", () => {
    const e = createAgentResult(
      "ar-001",
      1,
      "reviewer-1",
      3,
      "reviewer",
      "interrupted",
      "user_mass_interrupt",
      4200,
      "[Agent \"reviewer-1\" interrupted by the user]\n(no output)",
      "c-ar-1",
      "artifacts/agent-outputs/reviewer-1.md",
    );
    expect(e.type).toBe("agent_result");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("agent_result");
    expect(e.display).toBe("[Agent \"reviewer-1\" interrupted by the user]\n(no output)");
    expect(e.apiRole).toBeNull();
    expect(e.meta.contextId).toBe("c-ar-1");
    expect(e.meta.agentId).toBe("reviewer-1");
    expect(e.meta.agentNumericId).toBe(3);
    expect(e.meta.agentTemplate).toBe("reviewer");
    expect(e.meta.outcome).toBe("interrupted");
    expect(e.meta.cause).toBe("user_mass_interrupt");
    expect(e.meta.elapsedMs).toBe(4200);
    expect(e.meta.fullOutputPath).toBe("artifacts/agent-outputs/reviewer-1.md");
  });

  it("createAgentResult stores a preview derived from the delivered message", () => {
    const content = Array.from(
      { length: 10 },
      (_, idx) => idx === 0 ? "[Agent \"agent-1\" completed]" : `line ${idx}`,
    ).join("\n");

    const e = createAgentResult(
      "ar-002",
      1,
      "agent-1",
      1,
      "reviewer",
      "completed",
      "natural",
      1200,
      content,
      "c-ar-2",
    );

    expect(e.content).toBe(content);
    expect(e.display).toBe(content.split("\n").slice(0, 8).join("\n"));
    expect(e.meta.tuiPreviewTruncated).toBe(true);
    expect(e.meta.preview).toBeUndefined();
  });

  it("createAssistantText", () => {
    const e = createAssistantText("asst-001", 1, 0, "reply", "reply", "c2");
    expect(e.type).toBe("assistant_text");
    expect(e.roundIndex).toBe(0);
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("assistant");
    expect(e.apiRole).toBe("assistant");
    expect(e.meta.contextId).toBe("c2");
  });

  it("createAssistantText without contextId", () => {
    const e = createAssistantText("asst-002", 1, 0, "reply", "reply");
    expect(e.meta).toEqual({});
  });

  it("createReasoning", () => {
    const e = createReasoning("rsn-001", 1, 0, "thinking...", "thinking...", { state: "abc" }, "c7");
    expect(e.type).toBe("reasoning");
    expect(e.roundIndex).toBe(0);
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("reasoning");
    expect(e.apiRole).toBeNull();
    expect(e.meta.reasoningState).toEqual({ state: "abc" });
    expect(e.meta.contextId).toBe("c7");
  });

  it("createToolCall", () => {
    const e = createToolCall(
      "tc-001", 1, 0, "[agent] -> read_file",
      { id: "call_1", name: "read_file", arguments: { path: "src/main.ts" } },
      { toolCallId: "call_1", toolName: "read_file", agentName: "agent", contextId: "c8" },
    );
    expect(e.type).toBe("tool_call");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("tool_call");
    expect(e.apiRole).toBe("assistant");
    expect(e.meta.toolCallId).toBe("call_1");
    expect(e.meta.toolName).toBe("read_file");
    expect(e.meta.agentName).toBe("agent");
    expect(e.meta.contextId).toBe("c8");
  });

  it("createToolResult", () => {
    const e = createToolResult(
      "tr-001", 1, 0,
      { toolCallId: "call_1", toolName: "read_file", content: "file contents", toolSummary: "128 lines" },
      { isError: false },
    );
    expect(e.type).toBe("tool_result");
    expect(e.tuiVisible).toBe(false);
    expect(e.apiRole).toBe("tool_result");
    expect(e.meta.isError).toBe(false);
  });

  it("createToolResult with preview", () => {
    const e = createToolResult(
      "tr-002", 1, 0,
      { toolCallId: "call_2", toolName: "edit_file", content: "OK", toolSummary: "edit" },
      {
        isError: false,
        toolMetadata: {
          path: "src/a.ts",
          tui_preview: { kind: "diff", text: "@@ -1 +1 @@\n-old\n+new" },
        },
        previewText: "@@ -1 +1 @@\n-old\n+new",
      },
    );
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("tool_result");
    expect(e.display).toContain("@@ -1 +1 @@");
    expect((e.meta.toolMetadata as Record<string, unknown>).path).toBe("src/a.ts");
  });

  it("createNoReply", () => {
    const e = createNoReply("nr-001", 1, 0, "<NO_REPLY>", "c3");
    expect(e.type).toBe("no_reply");
    expect(e.tuiVisible).toBe(false);
    expect(e.apiRole).toBe("assistant");
    expect(e.content).toBe("<NO_REPLY>");
  });

  it("createCompactMarker", () => {
    const e = createCompactMarker("cm-001", 5, 0, 100000, 20000);
    expect(e.type).toBe("compact_marker");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("compact_mark");
    expect(e.display).toContain("Compacted");
    expect(e.apiRole).toBeNull();
    expect(e.meta.compactIndex).toBe(0);
    expect(e.meta.originalTokens).toBe(100000);
  });

  it("createCompactContext", () => {
    const e = createCompactContext("cc-001", 5, "continuation...", "c4", 0);
    expect(e.type).toBe("compact_context");
    expect(e.tuiVisible).toBe(false);
    expect(e.apiRole).toBe("user");
    expect(e.content).toBe("continuation...");
  });

  it("createSummary", () => {
    const e = createSummary("sum-001", 3, "Summary text", "Summary text", "c5", ["user-001", "asst-001"], 1);
    expect(e.type).toBe("summary");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("user");
    expect(e.apiRole).toBe("user");
    expect(e.meta.coveredContextIds).toEqual(["user-001", "asst-001"]);
    expect(e.meta.summaryDepth).toBe(1);
  });

  it("createInterruptionMarker", () => {
    const e = createInterruptionMarker("int-001", 2, "[System]: interrupted", ["#1"]);
    expect(e.type).toBe("interruption_marker");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("status");
    expect(e.apiRole).toBe("user");
    expect(e.meta.terminatedSubAgents).toEqual(["#1"]);
  });

  it("createInterruptionMarker without sub-agents", () => {
    const e = createInterruptionMarker("int-002", 2, "[System]: interrupted");
    expect(e.meta).toEqual({});
  });

  it("createSubAgentStart", () => {
    const e = createSubAgentStart("sas-001", 2, "Sub-agent #1 started", 1, "explorer", "find files");
    expect(e.type).toBe("sub_agent_start");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("progress");
    expect(e.apiRole).toBeNull();
  });

  it("createSubAgentToolCall", () => {
    const e = createSubAgentToolCall("satc-001", 2, "[#1] reading file", 1, "explorer", "read_file", 5);
    expect(e.type).toBe("sub_agent_tool_call");
    expect(e.meta.toolCallCount).toBe(5);
  });

  it("createSubAgentEnd", () => {
    const e = createSubAgentEnd("sae-001", 2, "Sub-agent #1 completed", 1, "explorer", 12.3, 5);
    expect(e.type).toBe("sub_agent_end");
    expect(e.meta.elapsed).toBe(12.3);
  });

  it("createStatus", () => {
    const e = createStatus("st-001", 2, "Retrying in 3s...", "retry");
    expect(e.type).toBe("status");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("status");
    expect(e.apiRole).toBeNull();
  });

  it("createError", () => {
    const e = createError("err-001", 2, "Network error", "network");
    expect(e.type).toBe("error");
    expect(e.tuiVisible).toBe(true);
    expect(e.displayKind).toBe("error");
    expect(e.meta.errorType).toBe("network");
  });

  it("createTokenUpdate", () => {
    const e = createTokenUpdate("tok-001", 2, 5000, 3000, 1000);
    expect(e.type).toBe("token_update");
    expect(e.tuiVisible).toBe(false);
    expect(e.apiRole).toBeNull();
    expect(e.meta.inputTokens).toBe(5000);
    expect(e.meta.cacheReadTokens).toBe(3000);
    expect(e.meta.cacheCreationTokens).toBe(1000);
  });

  it("createTokenUpdate without cache info", () => {
    const e = createTokenUpdate("tok-002", 2, 5000);
    expect(e.meta).toEqual({ inputTokens: 5000 });
  });

  it("createAskRequest", () => {
    const e = createAskRequest("askq-001", 2, { questions: [] }, "ask-1", "agent_question", "tc-1", 0);
    expect(e.type).toBe("ask_request");
    expect(e.tuiVisible).toBe(false);
    expect(e.apiRole).toBeNull();
    expect(e.meta.askId).toBe("ask-1");
    expect(e.meta.roundIndex).toBe(0);
  });

  it("createAskResolution", () => {
    const e = createAskResolution("askr-001", 2, { answers: [] }, "ask-1", "agent_question");
    expect(e.type).toBe("ask_resolution");
    expect(e.tuiVisible).toBe(false);
    expect(e.meta.askId).toBe("ask-1");
  });
});

// ------------------------------------------------------------------
// All entry types produce valid entries
// ------------------------------------------------------------------

describe("All entry types", () => {
  it("every type has a factory that produces correct type field", () => {
    const allTypes: LogEntryType[] = [
      "system_prompt", "work_start", "work_end", "input_received",
      "turn_start", "turn_end", "user_message", "agent_result", "assistant_text",
      "reasoning", "tool_call", "tool_result", "ask_request",
      "ask_resolution", "no_reply", "compact_marker", "compact_context",
      "summary", "interruption_marker", "sub_agent_start", "sub_agent_tool_call",
      "sub_agent_end", "status", "error", "token_update",
    ];

    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createWorkStart("ws-001", 1, "work-001"),
      createWorkEnd("we-001", 1, "work-001", "completed", 100),
      createInputReceived("in-001", 1, "in-001", "user", "hi", "hi", "c0"),
      createTurnStart("ts-001", 1),
      createTurnEnd("te-001", 1, "completed", 100),
      createUserMessage("user-001", 1, "hi", "hi", "c1"),
      createAgentResult("ar-001", 1, "agent-1", 1, "reviewer", "completed", "natural", 1200, "[Agent \"agent-1\" completed]\nok", "c-ar"),
      createAssistantText("asst-001", 1, 0, "reply", "reply"),
      createReasoning("rsn-001", 1, 0, "thinking", "thinking"),
      createToolCall("tc-001", 1, 0, "summary", { id: "1", name: "t", arguments: {} }, { toolCallId: "1", toolName: "t", agentName: "a" }),
      createToolResult("tr-001", 1, 0, { toolCallId: "1", toolName: "t", content: "r", toolSummary: "s" }, { isError: false }),
      createAskRequest("askq-001", 1, {}, "a1", "agent_question", "tc-1", 0),
      createAskResolution("askr-001", 1, {}, "a1", "agent_question"),
      createNoReply("nr-001", 1, 0, "<NO_REPLY>"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createCompactContext("cc-001", 1, "ctx", "c2", 0),
      createSummary("sum-001", 1, "s", "s", "c3", [], 0),
      createInterruptionMarker("int-001", 1, "interrupted"),
      createSubAgentStart("sas-001", 1, "started", 1, "ex", "task"),
      createSubAgentToolCall("satc-001", 1, "tool", 1, "ex", "read", 1),
      createSubAgentEnd("sae-001", 1, "done", 1, "ex", 10, 5),
      createStatus("st-001", 1, "status", "info"),
      createError("err-001", 1, "error"),
      createTokenUpdate("tok-001", 1, 1000),
    ];

    // Verify we have all 21 types
    const typesProduced = entries.map((e) => e.type);
    for (const t of allTypes) {
      expect(typesProduced).toContain(t);
    }

    // Verify basic structure
    for (const e of entries) {
      expect(e.id).toBeTruthy();
      expect(e.type).toBeTruthy();
      expect(typeof e.timestamp).toBe("number");
      expect(typeof e.turnIndex).toBe("number");
      expect(typeof e.tuiVisible).toBe("boolean");
      expect(typeof e.archived).toBe("boolean");
      expect(typeof e.meta).toBe("object");
    }
  });
});
