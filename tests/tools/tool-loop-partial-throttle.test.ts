/**
 * 大参数流式更新的合并契约。
 *
 * rawArguments 会随 chunk 增长；每个 chunk 都重建参数视图是 O(n²)。期望：
 * 超过 4KB 的参数在 100ms 窗口内合并更新，close 时无条件补齐最终状态；
 * 小参数仍逐 chunk 更新。
 */

import { describe, expect, it } from "vitest";

import { asyncRunToolLoop } from "../../src/agents/tool-loop/run.js";
import { createEphemeralLogState } from "../../src/context/ephemeral-log.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { BaseProvider } from "../../src/providers/base.js";
import { ProviderResponse, Usage } from "../../src/providers/response.js";
import type { ToolCall, ToolDef } from "../../src/providers/types.js";

const BIG_TOOL = {
  name: "big_tool",
  description: "test tool with a large payload",
  parameters: {
    type: "object",
    properties: { payload: { type: "string" } },
  },
} as ToolDef;

function createUpdateEntry(entries: LogEntry[]) {
  return (entryId: string, patch: {
    apiRole?: LogEntry["apiRole"];
    content?: unknown;
    display?: string;
    tuiVisible?: boolean;
    displayKind?: LogEntry["displayKind"];
    meta?: Record<string, unknown>;
  }): void => {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    if (patch.apiRole !== undefined) entry.apiRole = patch.apiRole;
    if (patch.content !== undefined) entry.content = patch.content;
    if (patch.display !== undefined) entry.display = patch.display;
    if (patch.tuiVisible !== undefined) entry.tuiVisible = patch.tuiVisible;
    if (patch.displayKind !== undefined) entry.displayKind = patch.displayKind;
    if (patch.meta !== undefined) entry.meta = patch.meta;
  };
}

function currentPayload(entries: LogEntry[]): string {
  const entry = entries.find((candidate) => candidate.type === "tool_call");
  const args = (entry?.content as { arguments?: Record<string, unknown> } | undefined)?.arguments;
  return typeof args?.["payload"] === "string" ? args["payload"] : "";
}

describe("流式参数合并", () => {
  it("大参数在同一 tick 内的后续 chunk 不重复更新，close 时补齐最终值", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);
    const payloadA = "line\n".repeat(1000); // > 4KB，进入节流路径
    const payloadB = payloadA + "tail\n";
    const rawA = JSON.stringify({ payload: payloadA });
    const rawB = JSON.stringify({ payload: payloadB });
    const payloadSnapshots: string[] = [];

    class BigPayloadProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: unknown[],
        _tools?: unknown,
        options?: {
          onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
          onToolCallClosed?: (call: ToolCall) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          options?.onToolCallPartial?.("big-1", "big_tool", rawA);
          payloadSnapshots.push(currentPayload(runtime.entries));
          // 同一 tick：距上次解析 < 100ms，应被合并掉。
          options?.onToolCallPartial?.("big-1", "big_tool", rawB);
          payloadSnapshots.push(currentPayload(runtime.entries));
          options?.onToolCallClosed?.({
            id: "big-1",
            name: "big_tool",
            rawArguments: rawB,
            arguments: { payload: payloadB },
            parseError: null,
          });
          return new ProviderResponse({ usage: new Usage(1, 1) });
        }
        return new ProviderResponse({ text: "done", usage: new Usage(1, 1) });
      }
    }

    const result = await asyncRunToolLoop({
      provider: new BigPayloadProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      tools: [BIG_TOOL],
      toolExecutors: {
        big_tool: async () => "OK",
      },
      maxRounds: 2,
      onToolCallPartial: () => {},
      updateEntry: createUpdateEntry(runtime.entries),
    });

    expect(payloadSnapshots[0]).toBe(payloadA);
    // 第二次 partial 被 100ms 窗口合并，快照仍是 A。
    expect(payloadSnapshots[1]).toBe(payloadA);
    // close 无条件同步最终值。
    expect(currentPayload(runtime.entries)).toBe(payloadB);
    expect(result.text).toBe("done");
  });
});
