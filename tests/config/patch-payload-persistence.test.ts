import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { capPersistedEntry } from "../../src/config/log-write-policy.js";
import { createToolCall } from "../../src/context/entry/factories.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("edit executionPayload persistence", () => {
  it("strips the in-memory patch from the persisted tool_call content", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "swarmflow-payload-persist-"));
    cleanup.push(sessionDir);
    const patch = "*** Begin Patch\n*** Add File: a.txt\n+alpha\n*** End Patch";
    const entry = createToolCall(
      "tc-edit",
      1,
      0,
      "edit",
      {
        id: "call_edit",
        name: "edit",
        arguments: {},
        executionPayload: patch,
      } as never,
      { toolCallId: "call_edit", toolName: "edit", agentName: "Primary", contextId: "ctx" },
      "assistant",
    );

    const capped = capPersistedEntry(entry, { sessionDir });

    expect((capped.content as Record<string, unknown>)["executionPayload"]).toBeUndefined();
    expect((entry.content as Record<string, unknown>)["executionPayload"]).toBe(patch);
  });

  it("strips a memory body the same way (剥离按载荷字段判定，不认工具名)", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "swarmflow-payload-persist-"));
    cleanup.push(sessionDir);
    const body = "*** Begin Memory\n- git提交信息需单行中文，无空格，精简概括\n*** End Memory";
    const entry = createToolCall(
      "tc-memory",
      1,
      0,
      "memory",
      {
        id: "call_memory",
        name: "memory",
        arguments: {},
        executionPayload: body,
      } as never,
      { toolCallId: "call_memory", toolName: "memory", agentName: "Primary", contextId: "ctx" },
      "assistant",
    );

    const capped = capPersistedEntry(entry, { sessionDir });

    expect((capped.content as Record<string, unknown>)["executionPayload"]).toBeUndefined();
    expect((entry.content as Record<string, unknown>)["executionPayload"]).toBe(body);
  });
});
