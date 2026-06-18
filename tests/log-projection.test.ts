/**
 * Tests for log projection functions (TUI + API).
 */

import { describe, it, expect } from "bun:test";
import {
  createSystemPrompt,
  createTurnStart,
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
  createStatus,
  createError,
  createTokenUpdate,
  createAskRequest,
  createAskResolution,
  createSubAgentStart,
  createSubAgentToolCall,
  createSubAgentEnd,
  type LogEntry,
} from "../src/log-entry.js";
import { projectToTuiEntries, projectToApiMessages } from "../src/log-projection.js";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function basicLog(): LogEntry[] {
  return [
    createSystemPrompt("sys-001", "You are helpful"),
    createTurnStart("ts-001", 1),
    createUserMessage("user-001", 1, "Hello", "Hello", "c1"),
    createAssistantText("asst-001", 1, 0, "Hi there!", "Hi there!", "c2"),
  ];
}

// ------------------------------------------------------------------
// TUI Projection
// ------------------------------------------------------------------

describe("projectToTuiEntries", () => {
  it("projects basic conversation", () => {
    const entries = basicLog();
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(2);
    expect(tui[0]).toEqual({ kind: "user", text: "Hello", id: "user-001" });
    expect(tui[1]).toEqual({ kind: "assistant", text: "Hi there!", id: "asst-001" });
  });

  it("skips tuiVisible=false entries", () => {
    const entries = [
      ...basicLog(),
      createToolResult("tr-001", 1, 0, { toolCallId: "1", toolName: "t", content: "r", toolSummary: "s" }, { isError: false }),
      createTokenUpdate("tok-001", 1, 5000),
    ];
    const tui = projectToTuiEntries(entries);
    // Only user + assistant visible
    expect(tui).toHaveLength(2);
  });

  it("projects tool calls and previewable tool results as dedicated TUI entries", () => {
    const entries = [
      ...basicLog(),
      createToolCall(
        "tc-001",
        1,
        1,
        "edit_file src/a.ts",
        { id: "call_1", name: "edit_file", arguments: { path: "src/a.ts" } },
        { toolCallId: "call_1", toolName: "edit_file", agentName: "agent", contextId: "c9" },
      ),
      createToolResult(
        "tr-001",
        1,
        1,
        { toolCallId: "call_1", toolName: "edit_file", content: "OK", toolSummary: "edit" },
        {
          isError: false,
          toolMetadata: {
            tui_preview: { kind: "diff", text: "@@ -1 +1 @@\n-old\n+new" },
          },
          previewText: "@@ -1 +1 @@\n-old\n+new",
        },
      ),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui[2]).toMatchObject({ kind: "tool_call", text: "edit_file src/a.ts", id: "tc-001" });
    expect(tui[3]).toMatchObject({ kind: "tool_result", text: "@@ -1 +1 @@\n-old\n+new", id: "tr-001" });
  });

  it("projects agent_result entries with structured meta for TUI consumers", () => {
    const entries = [
      createSystemPrompt("sys-001", "prompt"),
      createAgentResult(
        "ar-001",
        1,
        "reviewer-1",
        3,
        "reviewer",
        "failed",
        "natural",
        12300,
        "[Agent \"reviewer-1\" failed]\nBoom",
        "c-ar-1",
      ),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui).toEqual([
      {
        kind: "agent_result",
        text: "[Agent \"reviewer-1\" failed]\nBoom",
        id: "ar-001",
        fullText: "[Agent \"reviewer-1\" failed]\nBoom",
        meta: {
          contextId: "c-ar-1",
          agentId: "reviewer-1",
          agentNumericId: 3,
          agentTemplate: "reviewer",
          outcome: "failed",
          cause: "natural",
          elapsedMs: 12300,
        },
      },
    ]);
  });

  it("keeps both summarized originals and the summary visible in TUI (append-only history)", () => {
    const entries = basicLog();
    // Summary covers contextIds "c1" and "c2" (the user and assistant entries).
    // The TUI shows the full history — only the API projection hides the
    // covered originals. The user can still scroll back to verify what was
    // captured by the summary.
    const summary = createSummary("sum-001", 1, "Summary of conversation", "Summary of conversation", "c3", ["c1", "c2"], 1);
    entries.push(summary);

    const tui = projectToTuiEntries(entries);
    // Original user + assistant + summary entry are all visible.
    expect(tui).toHaveLength(3);
    expect(tui[0]).toMatchObject({ kind: "user", text: "Hello", id: "user-001" });
    expect(tui[1]).toMatchObject({ kind: "assistant", text: "Hi there!", id: "asst-001" });
    expect(tui[2]).toMatchObject({ kind: "user", text: "Summary of conversation", id: "sum-001" });
  });

  it("skips discarded entries", () => {
    const entries = basicLog();
    entries[3].discarded = true;
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(1);
    expect(tui[0].kind).toBe("user");
  });

  it("shows compact markers", () => {
    const entries = [
      ...basicLog(),
      createCompactMarker("cm-001", 2, 0, 100000, 20000),
      createCompactContext("cc-001", 2, "continuation", "c3", 0),
      createUserMessage("user-002", 2, "Next", "Next", "c4"),
    ];
    const tui = projectToTuiEntries(entries);
    // user + assistant + compact_mark + user (compact_context is invisible)
    expect(tui).toHaveLength(4);
    expect(tui[2].kind).toBe("compact_mark");
    expect(tui[2].text).toContain("Compacted");
  });

  it("splits interrupted assistant suffix into a dedicated TUI marker", () => {
    const entries = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "Analyze auth.ts", "Analyze auth.ts", "c1"),
      createAssistantText(
        "asst-001",
        1,
        0,
        "Let me check auth.ts [Interrupted here.]",
        "Let me check auth.ts [Interrupted here.]",
        "c2",
      ),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui).toEqual([
      { kind: "user", text: "Analyze auth.ts", id: "user-001" },
      { kind: "assistant", text: "Let me check auth.ts", id: "asst-001" },
      { kind: "interrupted_marker", text: "[Interrupted here.]", id: "asst-001:interrupt" },
    ]);
  });

  it("shows only the interrupted marker when no assistant text preceded it", () => {
    const entries = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "Analyze auth.ts", "Analyze auth.ts", "c1"),
      createAssistantText(
        "asst-001",
        1,
        0,
        "[Interrupted here.]",
        "[Interrupted here.]",
        "c2",
      ),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui).toEqual([
      { kind: "user", text: "Analyze auth.ts", id: "user-001" },
      { kind: "interrupted_marker", text: "[Interrupted here.]", id: "asst-001" },
    ]);
  });

  it("folds old windows when compact markers >= 3", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      // Window 0
      createUserMessage("user-001", 1, "msg1", "msg1", "c1"),
      createAssistantText("asst-001", 1, 0, "reply1", "reply1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      // Window 1
      createUserMessage("user-002", 2, "msg2", "msg2", "c2"),
      createAssistantText("asst-002", 2, 0, "reply2", "reply2"),
      createCompactMarker("cm-002", 2, 1, 100, 20),
      // Window 2
      createUserMessage("user-003", 3, "msg3", "msg3", "c3"),
      createAssistantText("asst-003", 3, 0, "reply3", "reply3"),
      createCompactMarker("cm-003", 3, 2, 100, 20),
      // Window 3 (current)
      createUserMessage("user-004", 4, "msg4", "msg4", "c4"),
    ];

    const tui = projectToTuiEntries(entries);

    // First entry should be fold placeholder
    expect(tui[0].kind).toBe("status");
    expect(tui[0].text).toContain("earlier entries");

    // Should show window 1, 2, 3 (3 visible windows)
    const userEntries = tui.filter((e) => e.kind === "user");
    expect(userEntries.map((e) => e.text)).toEqual(["msg2", "msg3", "msg4"]);
  });

  it("does not fold when compact markers < 3", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "msg1", "msg1", "c1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createUserMessage("user-002", 2, "msg2", "msg2", "c2"),
      createCompactMarker("cm-002", 2, 1, 100, 20),
      createUserMessage("user-003", 3, "msg3", "msg3", "c3"),
    ];

    const tui = projectToTuiEntries(entries);
    const userEntries = tui.filter((e) => e.kind === "user");
    expect(userEntries).toHaveLength(3); // All visible
  });

  it("shows status and error entries", () => {
    const entries = [
      ...basicLog(),
      createStatus("st-001", 1, "Retrying...", "retry"),
      createError("err-001", 1, "Network error", "network"),
    ];
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(4);
    expect(tui[2]).toEqual({ kind: "status", text: "Retrying...", id: "st-001", meta: { statusType: "retry" } });
    expect(tui[3]).toEqual({ kind: "error", text: "Network error", id: "err-001" });
  });

  it("ask_request and ask_resolution are invisible", () => {
    const entries = [
      ...basicLog(),
      createAskRequest("askq-001", 1, {}, "a1", "agent_question", "tc-1", 0),
      createAskResolution("askr-001", 1, {}, "a1", "agent_question"),
    ];
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(2); // Only user + assistant
  });

  it("hides legacy sub-agent tool call entries from the TUI projection", () => {
    const entries = [
      ...basicLog(),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createSubAgentToolCall("satc-002", 1, "[#2 explorer-B] grep \"auth\" src/", 2, "explorer-B", "grep", 1),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(2);
    expect(tui.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
  });

  it("ignores interleaved legacy sub-agent tool calls between reasoning and assistant text", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createReasoning("rsn-001", 1, 0, "thinking...", "thinking...", { state: "r0" }),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createSubAgentToolCall("satc-002", 1, "[#2 explorer-B] grep \"auth\" src/", 2, "explorer-B", "grep", 1),
      createAssistantText("asst-001", 1, 0, "Done.", "Done."),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "assistant",
    ]);
    expect(tui[1].text).toBe("thinking...");
    expect(tui[2].text).toBe("Done.");
  });

  it("ignores interleaved legacy sub-agent tool calls between reasoning and tool calls", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createReasoning("rsn-001", 1, 0, "thinking...", "thinking...", { state: "r0" }),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createToolCall(
        "tc-001",
        1,
        0,
        "read_file src/main.ts",
        { id: "call_1", name: "read_file", arguments: { path: "src/main.ts" } },
        { toolCallId: "call_1", toolName: "read_file", agentName: "agent" },
      ),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "tool_call",
    ]);
    expect(tui[2].text).toBe("read_file src/main.ts");
  });

  it("ignores idle-period legacy sub-agent tool calls before the next primary-agent round", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createAssistantText("asst-001", 1, 0, "First answer", "First answer"),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createReasoning("rsn-001", 1, 1, "second thinking", "second thinking", { state: "r1" }),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "reasoning",
    ]);
  });

  it("hides legacy sub-agent lifecycle and tool-call entries", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createSubAgentStart("sas-001", 1, "started", 1, "explorer", "task"),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer] tool 1", 1, "explorer", "tool1", 1),
      createSubAgentToolCall("satc-002", 1, "[#1 explorer] tool 2", 1, "explorer", "tool2", 2),
      createSubAgentToolCall("satc-003", 1, "[#1 explorer] tool 3", 1, "explorer", "tool3", 3),
      createSubAgentToolCall("satc-004", 1, "[#1 explorer] tool 4", 1, "explorer", "tool4", 4),
      createSubAgentToolCall("satc-005", 1, "[#1 explorer] tool 5", 1, "explorer", "tool5", 5),
      createSubAgentToolCall("satc-006", 1, "[#1 explorer] tool 6", 1, "explorer", "tool6", 6),
      createSubAgentToolCall("satc-007", 1, "[#1 explorer] tool 7", 1, "explorer", "tool7", 7),
      createSubAgentEnd("sae-001", 1, "done", 1, "explorer", 10, 7),
      createStatus("st-001", 1, "Status line", "info"),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual(["user", "status"]);
  });

  it("ignores legacy sub-agent completion entries between await_event calls", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createToolCall(
        "tc-001",
        1,
        0,
        "await_event 120s",
        { id: "await_event:1", name: "await_event", arguments: { seconds: 120 } },
        { toolCallId: "await_event:1", toolName: "await_event", agentName: "main" },
      ),
      createSubAgentEnd("sae-001", 1, "done", 6, "investigate-other-packages", 89.4, 49),
      createReasoning("rsn-001", 1, 1, "thinking", "thinking", { state: "r1" }),
      createAssistantText("asst-001", 1, 1, "continue waiting", "continue waiting"),
      createToolCall(
        "tc-002",
        1,
        1,
        "await_event 120s",
        { id: "await_event:2", name: "await_event", arguments: { seconds: 120 } },
        { toolCallId: "await_event:2", toolName: "await_event", agentName: "main" },
      ),
      createSubAgentEnd("sae-002", 1, "done", 2, "investigate-opencode", 95.4, 34),
      createReasoning("rsn-002", 1, 2, "thinking again", "thinking again", { state: "r2" }),
      createAssistantText("asst-002", 1, 2, "still waiting", "still waiting"),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "tool_call",
      "reasoning",
      "assistant",
      "tool_call",
      "reasoning",
      "assistant",
    ]);
  });
});

// ------------------------------------------------------------------
// API Projection
// ------------------------------------------------------------------

describe("projectToApiMessages", () => {
  it("keeps tool results immediately after tool calls when agent_result lands before await_event result", () => {
    const legacyAgentResult = createAgentResult(
      "ar-001",
      1,
      "worker-1",
      1,
      "explorer",
      "completed",
      "natural",
      1000,
      "[Agent \"worker-1\" completed]\nDone",
      "agent-result-ctx",
    );
    legacyAgentResult.apiRole = "user";

    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createTurnStart("ts-001", 1),
      createUserMessage("user-001", 1, "spawn a worker", "spawn a worker", "u1"),
      createReasoning("rsn-001", 1, 0, "waiting", "waiting", undefined, "r1"),
      createToolCall(
        "tc-001",
        1,
        0,
        "await_event 60s",
        { id: "await_event:2", name: "await_event", arguments: { seconds: 60 } },
        { toolCallId: "await_event:2", toolName: "await_event", agentName: "main", contextId: "r1" },
      ),
      legacyAgentResult,
      createToolResult(
        "tr-001",
        1,
        0,
        {
          toolCallId: "await_event:2",
          toolName: "await_event",
          content: "Waited - sub-session changed.",
          toolSummary: "main is awaiting runtime events",
        },
        { isError: false, contextId: "r1" },
      ),
    ];

    const msgs = projectToApiMessages(entries);
    const assistantIndex = msgs.findIndex((message) =>
      message.role === "assistant" && Array.isArray((message as any).tool_calls)
    );

    expect(assistantIndex).toBeGreaterThan(-1);
    expect(msgs[assistantIndex + 1]).toMatchObject({
      role: "tool_result",
      tool_call_id: "await_event:2",
    });
    expect(msgs[assistantIndex + 2]).toMatchObject({
      role: "user",
      content: expect.stringContaining("worker-1"),
    });
  });

  it("projects basic conversation", () => {
    const entries = basicLog();
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(msgs[1]).toMatchObject({ role: "user", content: "Hello" });
    expect(msgs[2]).toMatchObject({ role: "assistant", content: "Hi there!" });
  });

  it("keeps agent_result entries out of API projection", () => {
    const msgs = projectToApiMessages([
      createSystemPrompt("sys-001", "prompt"),
      createAgentResult(
        "ar-001",
        1,
        "reviewer-1",
        3,
        "reviewer",
        "interrupted",
        "user_targeted_kill",
        4200,
        "[Agent \"reviewer-1\" interrupted by the user]\n(no output)",
        "c-ar-1",
      ),
    ]);

    expect(msgs).toEqual([{ role: "system", content: "prompt" }]);
  });

  it("uses provided systemPrompt override", () => {
    const entries = basicLog();
    const msgs = projectToApiMessages(entries, { systemPrompt: "Override" });
    expect(msgs[0]).toEqual({ role: "system", content: "Override" });
  });

  it("handles tool calls and results", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createAssistantText("asst-001", 1, 0, "OK", "OK", "r1"),
      createToolCall("tc-001", 1, 0, "summary", { id: "call_1", name: "read_file", arguments: { path: "x.ts" } }, { toolCallId: "call_1", toolName: "read_file", agentName: "agent", contextId: "r1" }),
      createToolResult("tr-001", 1, 0, { toolCallId: "call_1", toolName: "read_file", content: "file content", toolSummary: "read" }, { isError: false, contextId: "r1" }),
    ];
    const msgs = projectToApiMessages(entries);

    // system + user + assistant(with tool_calls) + tool_result
    expect(msgs).toHaveLength(4);

    // Assistant message should have tool_calls and text
    const assistantMsg = msgs[2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "x.ts" } }]);
    expect(assistantMsg.text).toBe("OK"); // text field when tool_calls present
    expect(assistantMsg._context_id).toBe("r1");

    // Tool result
    const toolResult = msgs[3];
    expect(toolResult.role).toBe("tool_result");
    expect(toolResult.tool_call_id).toBe("call_1");
    expect(toolResult.content).toBe("file content");
  });

  it("handles reasoning in assistant messages", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "think", "think", "c1"),
      createReasoning("rsn-001", 1, 0, "thinking...", "thinking...", { state: "abc" }),
      createAssistantText("asst-001", 1, 0, "result", "result"),
    ];
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(3);

    const assistantMsg = msgs[2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("result");
    expect(assistantMsg.reasoning_content).toBe("thinking...");
    expect(assistantMsg._reasoning_state).toEqual({ state: "abc" });
  });

  it("keeps interrupted assistant content unchanged in API projection", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "Analyze auth.ts", "Analyze auth.ts", "c1"),
      createAssistantText(
        "asst-001",
        1,
        0,
        "Let me check auth.ts [Interrupted here.]",
        "Let me check auth.ts [Interrupted here.]",
        "c2",
      ),
      createUserMessage("user-002", 2, "Continue with login.ts", "Continue with login.ts", "c3"),
    ];

    const msgs = projectToApiMessages(entries);
    expect(msgs).toEqual([
      { role: "system", content: "prompt" },
      { role: "user", content: "Analyze auth.ts", _context_id: "c1" },
      { role: "assistant", content: "Let me check auth.ts [Interrupted here.]", _context_id: "c2" },
      { role: "user", content: "Continue with login.ts", _context_id: "c3" },
    ]);
  });

  it("handles no_reply", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "await", "await", "c1"),
      createNoReply("nr-001", 1, 0, "<NO_REPLY>"),
    ];
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(3);
    expect(msgs[2].content).toBe("<NO_REPLY>");
  });

  it("windows to last compact marker", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      // Old window
      createUserMessage("user-001", 1, "old", "old", "c1"),
      createAssistantText("asst-001", 1, 0, "old reply", "old reply"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      // New window
      createCompactContext("cc-001", 2, "continuation", "c2", 0),
      createUserMessage("user-002", 2, "new", "new", "c3"),
    ];
    const msgs = projectToApiMessages(entries);

    // system + compact_context(user) + new user
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1]).toMatchObject({ role: "user", content: "continuation" });
    expect(msgs[2]).toMatchObject({ role: "user", content: "new" });
  });

  it("replaces summarized entries at their original API position", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "c1"),
      createAssistantText("asst-001", 1, 0, "old reply", "old reply", "c1"),
      createUserMessage("user-002", 2, "newer", "newer", "c2"),
    ];

    // Summary covers contextId "c1" (both user + assistant share it).
    const summary = createSummary("sum-001", 1, "Summary", "Summary text", "c3", ["c1"], 1);
    entries.push(summary);

    const msgs = projectToApiMessages(entries);
    // system + summary(user) + user-002 (covered entries c1 hidden)
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toMatchObject({ role: "user", content: "Summary text" });
    expect(msgs[2]).toMatchObject({ role: "user", content: "newer" });
  });

  it("skips discarded entries", () => {
    const entries = basicLog();
    entries[3].discarded = true;
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(2); // system + user
  });

  it("keeps hidden user messages in API projection", () => {
    const hidden = createUserMessage("user-002", 2, "hidden", "hidden", "c2");
    hidden.tuiVisible = false;
    hidden.displayKind = null;

    const msgs = projectToApiMessages([
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "visible", "visible", "c1"),
      hidden,
    ]);

    expect(msgs).toEqual([
      { role: "system", content: "prompt" },
      { role: "user", content: "visible", _context_id: "c1" },
      { role: "user", content: "hidden", _context_id: "c2" },
    ]);
  });

  it("keeps API tool results before later user messages from the same log round", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "await", "await", "c1"),
      createToolCall(
        "tc-001",
        1,
        0,
        "await_event 15s",
        { id: "await_event:1", name: "await_event", arguments: { seconds: 15 } },
        { toolCallId: "await_event:1", toolName: "await_event", agentName: "main", contextId: "r1" },
      ),
      createUserMessage("user-002", 1, "side channel", "side channel", "c2"),
      createToolResult(
        "tr-001",
        1,
        0,
        { toolCallId: "await_event:1", toolName: "await_event", content: "done", toolSummary: "main is awaiting runtime events" },
        { isError: false, contextId: "r1" },
      ),
    ];

    const msgs = projectToApiMessages(entries, { enforceToolCallProtocol: true });
    expect(msgs.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool_result",
      "user",
    ]);
    expect(msgs[3]).toMatchObject({
      role: "tool_result",
      tool_call_id: "await_event:1",
    });
    expect(msgs[4]).toMatchObject({ role: "user", content: "side channel" });
  });

  it("handles interruption_marker as user message", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createAssistantText("asst-001", 1, 0, "partial", "partial"),
      createInterruptionMarker("int-001", 1, "[System]: interrupted"),
    ];
    const msgs = projectToApiMessages(entries);
    // system + user + assistant + interruption(user)
    expect(msgs).toHaveLength(4);
    expect(msgs[3]).toEqual({ role: "user", content: "[System]: interrupted" });
  });

  it("skips sub_agent entries (apiRole null)", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createSubAgentStart("sas-001", 1, "started", 1, "ex", "task"),
      createSubAgentEnd("sae-001", 1, "done", 1, "ex", 10, 5),
      createAssistantText("asst-001", 1, 0, "done", "done"),
    ];
    const msgs = projectToApiMessages(entries);
    // system + user + assistant (sub-agent entries skipped)
    expect(msgs).toHaveLength(3);
  });

  it("injects important log", () => {
    const entries = basicLog();
    const msgs = projectToApiMessages(entries, { importantLog: "Remember: use TypeScript" });
    // Important log merged into first user message
    expect(msgs).toHaveLength(3);
    expect((msgs[1].content as string)).toContain("[IMPORTANT LOG]");
    expect((msgs[1].content as string)).toContain("Remember: use TypeScript");
    expect((msgs[1].content as string)).toContain("[User Message]\nHello");
    expect((msgs[1].content as string)).toContain("Hello");
  });

  it("AGENTS.md is included in system prompt via systemPrompt option, not as user message", () => {
    const entries = basicLog();
    const agentsMdContent = "## Global Memory\n\n(empty file)";
    const systemPromptWithAgentsMd = "prompt\n\n---\n\n# Persistent Memory (AGENTS.md)\n\n" + agentsMdContent;
    const msgs = projectToApiMessages(entries, {
      systemPrompt: systemPromptWithAgentsMd,
      importantLog: "(empty file)",
    });
    expect(msgs).toHaveLength(3);
    // AGENTS.md is in system prompt, not in user message
    expect((msgs[0].content as string)).toContain("Persistent Memory (AGENTS.md)");
    expect((msgs[0].content as string)).toContain("Global Memory");
    // Important log still in user message
    const content = msgs[1].content as string;
    expect(content).toContain("[IMPORTANT LOG]");
    expect(content).toContain("[User Message]\nHello");
  });

  it("multiple rounds in same turn", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "multi", "multi", "c1"),
      // Round 0: tool call
      createAssistantText("asst-001", 1, 0, "Let me check", "Let me check"),
      createToolCall("tc-001", 1, 0, "reading", { id: "call_1", name: "read", arguments: {} }, { toolCallId: "call_1", toolName: "read", agentName: "a" }),
      createToolResult("tr-001", 1, 0, { toolCallId: "call_1", toolName: "read", content: "data", toolSummary: "ok" }, { isError: false }),
      // Round 1: final reply
      createAssistantText("asst-002", 1, 1, "Done", "Done"),
    ];
    const msgs = projectToApiMessages(entries);
    // system + user + assistant(round0 with tool_calls) + tool_result + assistant(round1)
    expect(msgs).toHaveLength(5);
    expect(msgs[2].tool_calls).toBeDefined();
    expect(msgs[4].content).toBe("Done");
  });
});
