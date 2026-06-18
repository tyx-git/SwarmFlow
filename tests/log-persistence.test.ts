/**
 * Tests for log-native persistence (v2): saveLog, loadLog, validateAndRepairLog, archive.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  saveLog,
  loadLog,
  validateAndRepairLog,
  archiveWindow,
  loadArchive,
  restoreArchiveToEntries,
  createLogSessionMeta,
  type LogSessionMeta,
} from "../src/persistence.js";
import {
  createSystemPrompt,
  createUserMessage,
  createAssistantText,
  createReasoning,
  createToolCall,
  createToolResult,
  createCompactMarker,
  createCompactContext,
  createAskRequest,
  createAskResolution,
  type LogEntry,
} from "../src/log-entry.js";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `log-persist-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function sampleLog(): LogEntry[] {
  return [
    createSystemPrompt("sys-001", "You are helpful"),
    createUserMessage("user-001", 1, "Hello", "Hello", "c1"),
    createAssistantText("asst-001", 1, 0, "Hi!", "Hi!"),
  ];
}

function sampleMeta(): LogSessionMeta {
  return createLogSessionMeta({
    projectPath: "/test/project",
    modelConfigName: "test-model",
    modelProvider: "openai",
    modelSelectionKey: "gpt-5.2",
    modelId: "gpt-5.2",
    summary: "Test session",
    turnCount: 1,
    thinkingLevel: "default",
  });
}

// ------------------------------------------------------------------
// saveLog + loadLog round-trip
// ------------------------------------------------------------------

describe("saveLog + loadLog", () => {
  it("round-trips entries correctly", () => {
    const entries = sampleLog();
    const meta = sampleMeta();
    saveLog(testDir, meta, entries);

    const loaded = loadLog(testDir);
    expect(loaded.entries).toHaveLength(3);
    expect(loaded.entries[0].id).toBe("sys-001");
    expect(loaded.entries[0].type).toBe("system_prompt");
    expect(loaded.entries[0].content).toBe("You are helpful");
    expect(loaded.entries[1].id).toBe("user-001");
    expect(loaded.entries[1].tuiVisible).toBe(true);
    expect(loaded.entries[1].displayKind).toBe("user");
    expect(loaded.entries[2].apiRole).toBe("assistant");
  });

  it("round-trips meta correctly", () => {
    const meta = sampleMeta();
    saveLog(testDir, meta, sampleLog());

    const loaded = loadLog(testDir);
    expect(loaded.meta.version).toBe(2);
    expect(loaded.meta.projectPath).toBe("/test/project");
    expect(loaded.meta.modelConfigName).toBe("test-model");
    expect(loaded.meta.modelProvider).toBe("openai");
    expect(loaded.meta.modelSelectionKey).toBe("gpt-5.2");
    expect(loaded.meta.modelId).toBe("gpt-5.2");
    expect(loaded.meta.summary).toBe("Test session");
    expect(loaded.meta.turnCount).toBe(1);
    expect(loaded.meta.thinkingLevel).toBe("default");
    expect(loaded.meta.createdAt).toBeTruthy();
    expect(loaded.meta.updatedAt).toBeTruthy();
  });

  it("preserves roundIndex", () => {
    const entries = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 3, "text", "text"),
    ];
    saveLog(testDir, sampleMeta(), entries);
    const loaded = loadLog(testDir);
    expect(loaded.entries[1].roundIndex).toBe(3);
  });

  it("preserves discarded flag", () => {
    // NOTE: per-entry `summarized` / `summarizedBy` flags were removed in the
    // append-only summary refactor — visibility is now computed dynamically by
    // the projection layer (backward-scan + coveredContextIds). Only the
    // `discarded` flag survives on the entry and must round-trip.
    const entries = sampleLog();
    entries[2].discarded = true;

    saveLog(testDir, sampleMeta(), entries);
    const loaded = loadLog(testDir);
    expect(loaded.entries[2].discarded).toBe(true);
  });

  it("restores LogIdAllocator correctly", () => {
    const entries = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-005", 1, "hi", "hi", "c1"),
      createToolCall("tc-012", 1, 0, "summary", { id: "1", name: "t", arguments: {} }, { toolCallId: "1", toolName: "t", agentName: "a" }),
    ];
    saveLog(testDir, sampleMeta(), entries);
    const loaded = loadLog(testDir);

    expect(loaded.idAllocator.next("user_message")).toBe("user-006");
    expect(loaded.idAllocator.next("tool_call")).toBe("tc-013");
    expect(loaded.idAllocator.next("system_prompt")).toBe("sys-002");
  });

  it("detects duplicate entry IDs", () => {
    const entries = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("sys-001", 1, "dup", "dup", "c1"), // duplicate!
    ];
    saveLog(testDir, sampleMeta(), entries);
    expect(() => loadLog(testDir)).toThrow("Duplicate entry ID");
  });
});

// ------------------------------------------------------------------
// validateAndRepairLog
// ------------------------------------------------------------------

describe("validateAndRepairLog", () => {
  it("handles empty entries", () => {
    const result = validateAndRepairLog([]);
    expect(result.repaired).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("discards orphaned compactPhase entries", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hi", "hi", "c1"),
      // Compact phase entries without a following compact_marker
      createUserMessage("user-002", 1, "compact prompt", "compact prompt", "c2"),
      createAssistantText("asst-001", 1, 0, "compact reply", "compact reply"),
    ];
    entries[2].meta.compactPhase = true;
    entries[3].meta.compactPhase = true;

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(true);
    expect(entries[2].discarded).toBe(true);
    expect(entries[3].discarded).toBe(true);
  });

  it("does not discard compactPhase entries before a compact_marker", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "compact prompt", "compact prompt", "c1"),
      createAssistantText("asst-001", 1, 0, "compact reply", "compact reply"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
    ];
    entries[1].meta.compactPhase = true;
    entries[2].meta.compactPhase = true;

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(false);
    expect(entries[1].discarded).toBeUndefined();
  });

  it("adds recovered tool_result for orphaned tool_call at end", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createToolCall("tc-001", 1, 0, "reading", { id: "call_1", name: "read_file", arguments: {} }, { toolCallId: "call_1", toolName: "read_file", agentName: "a" }),
    ];

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(true);
    expect(entries).toHaveLength(4);
    expect(entries[3].type).toBe("tool_result");
    expect(entries[3].meta.recovered).toBe(true);
    expect(entries[3].meta.toolCallId).toBe("call_1");
  });

  it("ignores display-only partial tool_call drafts during repair", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createToolCall(
        "tc-001",
        1,
        0,
        "write_file hello.py",
        {
          id: "call_1",
          name: "write_file",
          rawArguments: "{\"path\":\"hello.py\",\"content\":\"print('hel",
          arguments: { path: "hello.py", content: "print('hel" },
          parseError: null,
        },
        { toolCallId: "call_1", toolName: "write_file", agentName: "a" },
        null,
      ),
    ];
    entries[2].meta.toolStreamState = "partial";

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(false);
    expect(entries).toHaveLength(3);
  });

  it("recovers running orphaned tool_call as effect unknown", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createToolCall("tc-001", 1, 0, "bash rm -rf tmp", { id: "call_1", name: "bash", arguments: { command: "rm -rf tmp" } }, { toolCallId: "call_1", toolName: "bash", agentName: "a" }),
    ];
    entries[2].meta.toolExecState = "running";

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(true);
    expect(entries[3].type).toBe("tool_result");
    expect(String((entries[3].content as any).content)).toContain("unknown real-world effects");
  });

  it("re-stamps reasoning split from its round by a stale turnIndex", () => {
    // Bug signature: round 4's reasoning got turnIndex 6 (queued message drained
    // mid-activation) while its tool_call/result stayed at turnIndex 5.
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 5, "do it", "do it", "c1"),
      createReasoning("rsn-001", 6, 4, "thinking…", "thinking…"),
      createToolCall("tc-001", 5, 4, "bash ls", { id: "call_1", name: "bash", arguments: { command: "ls" } }, { toolCallId: "call_1", toolName: "bash", agentName: "a" }),
      createToolResult("tr-001", 5, 4, { toolCallId: "call_1", toolName: "bash", content: "ok", toolSummary: "ls" }, { isError: false }),
    ];

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(true);
    expect(entries.find((e) => e.id === "rsn-001")!.turnIndex).toBe(5);
    expect(result.warnings.some((w) => w.includes("rsn-001"))).toBe(true);
  });

  it("leaves a legitimate reasoning-only round untouched", () => {
    // No action sibling under ANY turn (e.g. interrupted before tool calls) →
    // ambiguous, must not be re-stamped.
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 5, "do it", "do it", "c1"),
      createReasoning("rsn-001", 6, 4, "thinking…", "thinking…"),
    ];

    const result = validateAndRepairLog(entries);
    expect(entries.find((e) => e.id === "rsn-001")!.turnIndex).toBe(6);
  });

  it("does not touch reasoning that already has its own round's action", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 5, "do it", "do it", "c1"),
      createReasoning("rsn-001", 5, 4, "thinking…", "thinking…"),
      createToolCall("tc-001", 5, 4, "bash ls", { id: "call_1", name: "bash", arguments: { command: "ls" } }, { toolCallId: "call_1", toolName: "bash", agentName: "a" }),
      createToolResult("tr-001", 5, 4, { toolCallId: "call_1", toolName: "bash", content: "ok", toolSummary: "ls" }, { isError: false }),
    ];

    const result = validateAndRepairLog(entries);
    expect(entries.find((e) => e.id === "rsn-001")!.turnIndex).toBe(5);
  });

  it("discards orphan ask_resolution", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAskResolution("askr-001", 1, {}, "nonexistent-ask", "agent_question"),
    ];

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(true);
    expect(entries[1].discarded).toBe(true);
  });

  it("keeps unclosed ask_request (for resume)", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAskRequest("askq-001", 1, { questions: [] }, "ask-1", "agent_question", "tc-1", 0),
    ];

    const result = validateAndRepairLog(entries);
    // Should NOT mark ask_request as discarded — it's used for resume
    expect(entries[1].discarded).toBeUndefined();
  });

  it("adds recovered tool_result when ask_resolution exists but tool_result missing", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createToolCall("tc-001", 1, 0, "asking", { id: "tc-1", name: "ask", arguments: {} }, { toolCallId: "tc-1", toolName: "ask", agentName: "a", contextId: "ask-ctx-1" }),
      createAskRequest("askq-001", 1, {}, "ask-1", "agent_question", "tc-1", 0, "ask-ctx-1"),
      createAskResolution("askr-001", 1, { answers: [] }, "ask-1", "agent_question"),
    ];

    const result = validateAndRepairLog(entries);
    expect(result.repaired).toBe(true);
    // Should have added a recovered tool_result after ask_resolution
    const recovered = entries.find((e) => e.meta.recovered === true && e.type === "tool_result");
    expect(recovered).toBeTruthy();
    expect(recovered!.meta.toolCallId).toBe("tc-1");
    expect(recovered!.meta.contextId).toBe("ask-ctx-1");
  });
});

// ------------------------------------------------------------------
// Archive
// ------------------------------------------------------------------

describe("archiveWindow / loadArchive", () => {
  it("archives and restores window content", () => {
    const entries = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hi", "hi", "c1"),
      createAssistantText("asst-001", 1, 0, "reply", "reply"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createUserMessage("user-002", 2, "next", "next", "c2"),
    ];

    // Archive window 0 (entries 0-2, before the compact marker)
    archiveWindow(testDir, 0, entries, 0, 2);

    // Entries should have content nulled
    expect(entries[0].content).toBeNull();
    expect(entries[0].archived).toBe(true);
    expect(entries[1].content).toBeNull();
    expect(entries[1].archived).toBe(true);
    expect(entries[2].content).toBeNull();
    expect(entries[2].archived).toBe(true);

    // Non-archived entries untouched
    expect(entries[4].content).toBe("next");
    expect(entries[4].archived).toBe(false);

    // Load archive
    const archived = loadArchive(testDir, 0);
    expect(archived).toHaveLength(3);
    expect(archived[0].id).toBe("sys-001");
    expect(archived[0].content).toBe("prompt");

    // Restore to entries
    restoreArchiveToEntries(entries, archived);
    expect(entries[0].content).toBe("prompt");
    expect(entries[1].content).toBe("hi");
    expect(entries[2].content).toBe("reply");
  });

  it("archive directory is created if missing", () => {
    const entries = [createSystemPrompt("sys-001", "prompt")];
    archiveWindow(testDir, 0, entries, 0, 0);
    expect(existsSync(join(testDir, "archive"))).toBe(true);
  });
});
