import { describe, expect, it } from "bun:test";

import { createEphemeralLogState } from "../src/ephemeral-log.js";
import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createToolCall,
  createToolResult,
  createUserMessage,
} from "../src/log-entry.js";

describe("createEphemeralLogState", () => {
  it("round-trips imported assistant tool-call rounds through log projection", () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "inspect", _context_id: "u1" },
      {
        role: "assistant",
        reasoning_content: "thinking...",
        text: "Checking files",
        tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "x.ts" } }],
        _context_id: "r1",
      },
    ]);

    const msgs = runtime.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      text: "Checking files",
      reasoning_content: "thinking...",
      _context_id: "r1",
    });
    expect(msgs[2].tool_calls).toEqual([
      { id: "call_1", name: "read_file", arguments: { path: "x.ts" } },
    ]);
    const reasoning = runtime.entries.find((e) => e.type === "reasoning");
    const toolCall = runtime.entries.find((e) => e.type === "tool_call");
    expect((reasoning?.meta as Record<string, unknown>)["contextId"]).toBe("r1");
    expect((toolCall?.meta as Record<string, unknown>)["contextId"]).toBe("r1");
  });

  it("projects appended round entries from the ephemeral log", () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "inspect" },
    ]);

    runtime.appendEntry(createAssistantText(
      runtime.allocId("assistant_text"),
      0,
      0,
      "Checking files",
      "Checking files",
      "r2",
    ));
    runtime.appendEntry(createToolCall(
      runtime.allocId("tool_call"),
      0,
      0,
      "read_file",
      { id: "call_1", name: "read_file", arguments: { path: "x.ts" } },
      { toolCallId: "call_1", toolName: "read_file", agentName: "sub", contextId: "r2" },
    ));
    runtime.appendEntry(createToolResult(
      runtime.allocId("tool_result"),
      0,
      0,
      { toolCallId: "call_1", toolName: "read_file", content: "source", toolSummary: "read_file" },
      { isError: false, contextId: "r2" },
    ));

    const msgs = runtime.getMessages();
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      text: "Checking files",
      _context_id: "r2",
    });
    expect(msgs[3]).toMatchObject({
      role: "tool_result",
      tool_call_id: "call_1",
      _context_id: "r2",
    });
  });

  it("uses compact markers and compact_context as the active provider window", () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "old task" },
    ]);

    runtime.appendEntry(createAssistantText(
      runtime.allocId("assistant_text"),
      0,
      0,
      "old reply",
      "old reply",
      "r1",
    ));
    runtime.appendEntry(createCompactMarker(
      runtime.allocId("compact_marker"),
      0,
      0,
      100,
      20,
    ));
    runtime.appendEntry(createCompactContext(
      runtime.allocId("compact_context"),
      0,
      "continuation",
      "cc1",
      0,
    ));
    runtime.appendEntry(createUserMessage(
      runtime.allocId("user_message"),
      0,
      "new task",
      "new task",
      "u2",
    ));

    const msgs = runtime.getMessages();
    expect(msgs).toEqual([
      { role: "system", content: "prompt" },
      { role: "user", content: "continuation", _context_id: "cc1" },
      { role: "user", content: "new task", _context_id: "u2" },
    ]);
  });
});
