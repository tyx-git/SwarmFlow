import { describe, expect, it } from "vitest";

import {
  createAssistantText,
  createToolCall,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import {
  resolvePayloadFromToolCallLog,
  resolveRoundPayloads,
} from "../../src/blocks/payload-blocks.js";

const BLOCK_A = "*** Begin Patch\n*** Add File: a.txt\n+alpha\n*** End Patch";
const BLOCK_B = "*** Begin Patch\n*** Add File: b.txt\n+beta\n*** End Patch";

describe("resolveRoundPayloads", () => {
  it("assigns complete blocks to edit calls in order", () => {
    const payloads = resolveRoundPayloads(
      [
        { id: "call-1", name: "edit" },
        { id: "call-2", name: "read_file" },
        { id: "call-3", name: "edit" },
      ],
      `intro\n${BLOCK_A}\nmiddle\n${BLOCK_B}\noutro`,
    );
    expect(payloads.get("call-1")).toBe(BLOCK_A);
    expect(payloads.get("call-3")).toBe(BLOCK_B);
    expect(payloads.has("call-2")).toBe(false);
  });

  it("leaves extra edit calls without a payload when blocks are missing", () => {
    const payloads = resolveRoundPayloads(
      [
        { id: "call-1", name: "edit" },
        { id: "call-2", name: "edit" },
      ],
      BLOCK_A,
    );
    expect(payloads.get("call-1")).toBe(BLOCK_A);
    expect(payloads.has("call-2")).toBe(false);
  });

  it("ignores an incomplete streaming block", () => {
    const payloads = resolveRoundPayloads(
      [{ id: "call-1", name: "edit" }],
      "*** Begin Patch\n*** Add File: a.txt\n+alpha",
    );
    expect(payloads.size).toBe(0);
  });
});

function editCall(id: string, callId: string, roundIndex = 0): LogEntry {
  return createToolCall(
    id,
    1,
    roundIndex,
    "edit",
    { id: callId, name: "edit", arguments: {} },
    { toolCallId: callId, toolName: "edit", agentName: "Primary", contextId: "ctx" },
    "assistant",
  );
}

describe("resolvePayloadFromToolCallLog", () => {
  it("joins same-round assistant text and picks the matching edit ordinal", () => {
    const log: LogEntry[] = [
      createUserMessage("user-1", 1, "apply", "apply", "ctx"),
      createAssistantText("text-1", 1, 0, `intro\n${BLOCK_A}\n`, `intro\n${BLOCK_A}\n`, "ctx"),
      createAssistantText("text-2", 1, 0, `${BLOCK_B}`, `${BLOCK_B}`, "ctx"),
      editCall("tc-1", "call-1"),
      editCall("tc-2", "call-2"),
    ];
    expect(resolvePayloadFromToolCallLog(log, log[3]!)).toBe(BLOCK_A);
    expect(resolvePayloadFromToolCallLog(log, log[4]!)).toBe(BLOCK_B);
  });

  it("returns null when there is no complete patch block", () => {
    const call = editCall("tc-1", "call-1");
    const log: LogEntry[] = [
      createAssistantText("text-1", 1, 0, "no patch here", "no patch here", "ctx"),
      call,
    ];
    expect(resolvePayloadFromToolCallLog(log, call)).toBeNull();
  });

  it("ignores discarded assistant text from a failed retry attempt", () => {
    const call = editCall("tc-1", "call-1");
    const stale = createAssistantText(
      "text-stale",
      1,
      0,
      "*** Begin Patch\n*** Add File: stale.txt\n+stale",
      "",
      "ctx",
    );
    stale.discarded = true;
    const log: LogEntry[] = [
      stale,
      createAssistantText("text-ok", 1, 0, BLOCK_A, BLOCK_A, "ctx"),
      call,
    ];
    expect(resolvePayloadFromToolCallLog(log, call)).toBe(BLOCK_A);
  });

  it("only uses text from the same round", () => {
    const call = editCall("tc-1", "call-1", 1);
    const log: LogEntry[] = [
      createAssistantText("text-1", 1, 0, BLOCK_A, BLOCK_A, "ctx"),
      call,
    ];
    expect(resolvePayloadFromToolCallLog(log, call)).toBeNull();
  });
});
