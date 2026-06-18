import { describe, it, expect } from "bun:test";
import {
  isCompactMarker,
  injectContextIdTag,
  mergeConsecutiveSameRole,
} from "../src/context-rendering.js";

// ------------------------------------------------------------------
// isCompactMarker
// ------------------------------------------------------------------

describe("isCompactMarker", () => {
  it("returns true for a compact marker", () => {
    const marker = { role: "__compact_marker", marker_type: "auto_compact", timestamp: 1000 };
    expect(isCompactMarker(marker)).toBe(true);
  });

  it("returns false for a regular message", () => {
    expect(isCompactMarker({ role: "user", content: "hello" })).toBe(false);
    expect(isCompactMarker({ role: "assistant", content: "hi" })).toBe(false);
    expect(isCompactMarker({ role: "system", content: "prompt" })).toBe(false);
  });
});

// ------------------------------------------------------------------
// injectContextIdTag
// ------------------------------------------------------------------

describe("injectContextIdTag", () => {
  it("prepends tag to string content", () => {
    const result = injectContextIdTag("Hello world", 5);
    expect(result).toBe("§{5}§\nHello world");
  });

  it("prepends tag to first text block in array content", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "image", data: "abc" },
    ];
    const result = injectContextIdTag(content, 3) as Array<Record<string, unknown>>;
    expect(result[0]["text"]).toBe("§{3}§\nHello");
    // Original should not be mutated
    expect(content[0]["text"]).toBe("Hello");
  });

  it("inserts new text block if array has no text block", () => {
    const content = [
      { type: "image", data: "abc" },
    ];
    const result = injectContextIdTag(content, 7) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "§{7}§" });
    expect(result[1]).toEqual({ type: "image", data: "abc" });
  });

  it("handles sub-context IDs (string)", () => {
    const result = injectContextIdTag("Hello", "5.2");
    expect(result).toBe("§{5.2}§\nHello");
  });
});

// ------------------------------------------------------------------
// mergeConsecutiveSameRole
// ------------------------------------------------------------------

describe("mergeConsecutiveSameRole", () => {
  it("merges consecutive user string messages with \\n\\n", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "user", content: "third" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    expect(result[0]["content"]).toBe("first\n\nsecond\n\nthird");
  });

  it("merges consecutive user array messages by concatenating blocks", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "world" }] },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    const content = result[0]["content"] as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]["text"]).toBe("hello");
    expect(content[1]["text"]).toBe("world");
  });

  it("merges mixed string and array user messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "text", text: "world" }] },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    const content = result[0]["content"] as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "hello" });
    expect(content[1]).toEqual({ type: "text", text: "world" });
  });

  it("does NOT merge assistant(tool_calls) INTO a following assistant", () => {
    const messages = [
      { role: "assistant", content: "thinking", tool_calls: [{ id: "1", name: "read" }] },
      { role: "assistant", content: "more" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(2);
  });

  it("merges pure-text assistant into following assistant(tool_calls) to avoid consecutive model turns", () => {
    // This scenario occurs after summarize_context inserts a summary (assistant)
    // followed by the next non-summarized assistant with tool_calls.
    const messages = [
      { role: "assistant", content: "[Summary of 1,2,3]" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc1", name: "write_file", arguments: { path: "a.txt" } }] },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    expect(result[0]["tool_calls"]).toBeDefined();
    expect(result[0]["text"]).toBe("[Summary of 1,2,3]");
  });

  it("merges summary text into tool_calls assistant preserving existing text", () => {
    const messages = [
      { role: "assistant", content: "Summary here" },
      { role: "assistant", text: "Existing text", tool_calls: [{ id: "tc1", name: "bash" }] },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    expect(result[0]["text"]).toBe("Summary here\n\nExisting text");
    expect(result[0]["tool_calls"]).toBeDefined();
  });

  it("removes empty preceding assistant when followed by tool_calls assistant", () => {
    const messages = [
      { role: "assistant", content: "" },
      { role: "assistant", tool_calls: [{ id: "tc1", name: "bash" }] },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    expect(result[0]["tool_calls"]).toBeDefined();
  });

  it("does NOT merge tool_result messages", () => {
    const messages = [
      { role: "tool_result", tool_call_id: "1", content: "result1" },
      { role: "tool_result", tool_call_id: "2", content: "result2" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(2);
  });

  it("does NOT merge system messages", () => {
    const messages = [
      { role: "system", content: "prompt1" },
      { role: "system", content: "prompt2" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(2);
  });

  it("merges consecutive pure-text assistant messages", () => {
    const messages = [
      { role: "assistant", content: "part1" },
      { role: "assistant", content: "part2" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(1);
    expect(result[0]["content"]).toBe("part1\n\npart2");
  });

  it("handles alternating roles correctly", () => {
    const messages = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    expect(result).toHaveLength(4);
  });

  it("returns empty array for empty input", () => {
    expect(mergeConsecutiveSameRole([])).toEqual([]);
  });

  it("does not merge user after tool_calls assistant", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "1", name: "read" }] },
      { role: "tool_result", tool_call_id: "1", content: "result" },
      { role: "user", content: "user message" },
      { role: "user", content: "user message 2" },
    ];
    const result = mergeConsecutiveSameRole(messages);
    // assistant(tool_calls), tool_result, user(merged)
    expect(result).toHaveLength(3);
    expect(result[2]["content"]).toBe("user message\n\nuser message 2");
  });
});
