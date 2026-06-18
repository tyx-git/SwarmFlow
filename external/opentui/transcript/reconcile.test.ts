import { describe, expect, it } from "bun:test";

import type { ConversationEntry } from "../../src/ui/contracts.js";

import { reconcileEntries } from "./reconcile.js";

describe("reconcileEntries", () => {
  it("reuses unchanged entry objects", () => {
    const entries: ConversationEntry[] = [
      { id: "a", kind: "assistant", text: "hello" },
      { id: "b", kind: "reasoning", text: "thinking" },
    ];

    const first = reconcileEntries([], entries);
    const second = reconcileEntries(first, [
      { id: "a", kind: "assistant", text: "hello" },
      { id: "b", kind: "reasoning", text: "thinking" },
    ]);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[0]?.contentVersion).toBe(1);
    expect(second[1]?.contentVersion).toBe(1);
  });

  it("bumps contentVersion only for changed entries", () => {
    const first = reconcileEntries([], [
      { id: "a", kind: "assistant", text: "hello" },
      { id: "b", kind: "tool_result", text: "before" },
    ]);

    const second = reconcileEntries(first, [
      { id: "a", kind: "assistant", text: "hello" },
      { id: "b", kind: "tool_result", text: "after" },
    ]);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[0]?.contentVersion).toBe(1);
    expect(second[1]?.contentVersion).toBe(2);
  });
});
