import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LOG_JSONL_FILENAME } from "../../src/config/log-jsonl.js";
import { makeScriptedSession, stageApprovalGate, testToolDef } from "../helpers/session-harness.js";

/**
 * 批量 tool_call 的上下文契约：同一轮里模型发起的每个调用，
 * 其结果都必须出现在下一次 provider 请求里（UI 展示只是投影，不是唯一出口）。
 */

function toolResultsOf(call: Array<Record<string, unknown>>) {
  return call
    .filter((m) => m["role"] === "tool_result")
    .map((m) => ({ id: String(m["tool_call_id"]), content: String(m["content"]) }));
}

function assistantToolCallIds(call: Array<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  for (const m of call) {
    if (m["role"] !== "assistant" || !Array.isArray(m["tool_calls"])) continue;
    for (const tc of m["tool_calls"] as Array<Record<string, unknown>>) ids.push(String(tc["id"]));
  }
  return ids;
}

describe("batch tool results reach the model context", () => {
  it("delivers every result of a three-call round, in call order", async () => {
    const h = makeScriptedSession({
      rounds: [
        {
          toolCalls: [
            { id: "call-a", name: "bash", arguments: { command: "echo ALPHA" } },
            { id: "call-b", name: "bash", arguments: { command: "echo BETA" } },
            { id: "call-c", name: "bash", arguments: { command: "echo GAMMA" } },
          ],
        },
        { text: "done" },
      ],
      tools: [testToolDef("bash")],
      toolExecutorOverrides: {
        bash: (args) => {
          if (String(args["command"]).includes("GAMMA")) throw new Error("boom");
          return `OUTPUT-OF:${String(args["command"])}`;
        },
      },
    });
    try {
      await h.session.turn("run three commands");

      const secondRequest = h.provider.calls[1] ?? [];
      expect(assistantToolCallIds(secondRequest)).toEqual(["call-a", "call-b", "call-c"]);
      const results = toolResultsOf(secondRequest);
      expect(results.map((r) => r.id)).toEqual(["call-a", "call-b", "call-c"]);
      expect(results[0]).toEqual({ id: "call-a", content: "OUTPUT-OF:echo ALPHA" });
      expect(results[1]).toEqual({ id: "call-b", content: "OUTPUT-OF:echo BETA" });
      expect(results[2]?.content.startsWith("ERROR:")).toBe(true);
      expect(results[2]?.content).toContain("boom");
    } finally {
      h.dispose();
    }
  });

  it("keeps the whole batch after a mid-batch approval suspends the round", async () => {
    const executed: string[] = [];
    const h = makeScriptedSession({
      rounds: [
        {
          toolCalls: [
            { id: "call-1", name: "plain_tool", arguments: { step: 1 } },
            { id: "call-2", name: "gated_tool", arguments: { step: 2 } },
            { id: "call-3", name: "plain_tool", arguments: { step: 3 } },
          ],
        },
        { text: "finished after approval" },
      ],
      tools: [testToolDef("plain_tool"), testToolDef("gated_tool")],
      toolExecutorOverrides: {
        plain_tool: (args) => {
          executed.push(`plain-${String(args["step"])}`);
          return `PLAIN-${String(args["step"])}`;
        },
        gated_tool: (args) => {
          executed.push(`gated-${String(args["step"])}`);
          return `GATED-${String(args["step"])}`;
        },
      },
    });
    try {
      const gate = stageApprovalGate(h, "gated_tool");

      await h.session.turn("run the batch");
      expect(h.session.getPendingAsk()?.kind).toBe("approval");
      // 挂起前只有第一个调用跑完，后面的调用必须等审批后再排空。
      expect(executed).toEqual(["plain-1"]);

      h.session.resolveApprovalAsk(gate.ask!.id, 0);
      await h.session.resumePendingTurn();

      expect(executed).toEqual(["plain-1", "gated-2", "plain-3"]);
      const secondRequest = h.provider.calls[1] ?? [];
      expect(assistantToolCallIds(secondRequest)).toEqual(["call-1", "call-2", "call-3"]);
      expect(toolResultsOf(secondRequest)).toEqual([
        { id: "call-1", content: "PLAIN-1" },
        { id: "call-2", content: "GATED-2" },
        { id: "call-3", content: "PLAIN-3" },
      ]);
    } finally {
      h.dispose();
    }
  });

  it("caps oversized output only on disk; the live context keeps the full text", async () => {
    const big = "X".repeat(70_000);
    const h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-big", name: "bash", arguments: { command: "cat big" } }] },
        { text: "done" },
      ],
      tools: [testToolDef("bash")],
      toolExecutorOverrides: { bash: () => big },
    });
    try {
      await h.session.turn("read the big file");

      expect(toolResultsOf(h.provider.calls[1] ?? [])).toEqual([{ id: "call-big", content: big }]);

      h.session.persistToDisk();
      const dir = h.internals._resolvePersistDir() as string;
      const entries = readFileSync(join(dir, LOG_JSONL_FILENAME), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record["op"] === "upsert") return record["entries"] as Array<Record<string, unknown>>;
          if (record["op"] === "compact_checkpoint") {
            return [record["marker"], record["context"]] as Array<Record<string, unknown>>;
          }
          return [];
        });
      const persistedResult = entries.find((e) => e["type"] === "tool_result");
      const persistedText = String((persistedResult?.["content"] as Record<string, unknown> | undefined)?.["content"] ?? "");
      expect(persistedText).toContain("[full output:");
      expect(persistedText.length).toBeLessThan(big.length);
    } finally {
      h.dispose();
    }
  });
});
