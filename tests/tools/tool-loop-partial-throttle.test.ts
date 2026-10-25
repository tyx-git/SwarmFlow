/**
 * 大参数流式更新的合并契约。
 *
 * write_file/edit_file 的 rawArguments 会随 chunk 增长；每个 chunk 都重建
 * sections/fileModifyData 是 O(n²)。期望：超过 4KB 的参数在 100ms 窗口内
 * 合并更新，close 时无条件补齐最终状态；小参数仍逐 chunk 更新。
 */

import { describe, expect, it } from "vitest";

import { asyncRunToolLoop } from "../../src/agents/tool-loop/run.js";
import { createEphemeralLogState } from "../../src/context/ephemeral-log.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { BaseProvider } from "../../src/providers/base.js";
import { ProviderResponse, Usage } from "../../src/providers/response.js";
import type { ToolCall } from "../../src/providers/types.js";
import { BASIC_TOOLS_MAP } from "../../src/tools/definitions.js";

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

describe("流式参数合并", () => {
  it("大参数在同一 tick 内的后续 chunk 不重复更新，close 时补齐最终值", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);
    const contentA = "line\n".repeat(1000); // > 4KB，进入节流路径
    const contentB = contentA + "tail\n";
    const rawA = JSON.stringify({ path: "big.txt", content: contentA });
    const rawB = JSON.stringify({ path: "big.txt", content: contentB });
    const contentSnapshots: string[] = [];

    class BigWriteProvider extends BaseProvider {
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
          options?.onToolCallPartial?.("big-1", "write_file", rawA);
          contentSnapshots.push(currentContent(runtime.entries));
          // 同一 tick：距上次解析 < 100ms，应被合并掉。
          options?.onToolCallPartial?.("big-1", "write_file", rawB);
          contentSnapshots.push(currentContent(runtime.entries));
          options?.onToolCallClosed?.({
            id: "big-1",
            name: "write_file",
            rawArguments: rawB,
            arguments: { path: "big.txt", content: contentB },
            parseError: null,
          });
          return new ProviderResponse({ usage: new Usage(1, 1) });
        }
        return new ProviderResponse({ text: "done", usage: new Usage(1, 1) });
      }
    }

    const result = await asyncRunToolLoop({
      provider: new BigWriteProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      tools: [BASIC_TOOLS_MAP["write_file"]],
      toolExecutors: {
        write_file: async () => "OK",
      },
      maxRounds: 2,
      onToolCallPartial: () => {},
      updateEntry: createUpdateEntry(runtime.entries),
    });

    expect(contentSnapshots[0]).toBe(contentA);
    // 第二次 partial 被 100ms 窗口合并，快照仍是 A。
    expect(contentSnapshots[1]).toBe(contentA);
    // close 无条件同步最终值。
    expect(currentContent(runtime.entries)).toBe(contentB);
    expect(result.text).toBe("done");
  });
});

function currentContent(entries: LogEntry[]): string {
  const entry = entries.find((candidate) => candidate.type === "tool_call");
  const args = (entry?.content as { arguments?: Record<string, unknown> } | undefined)?.arguments;
  return typeof args?.["content"] === "string" ? args["content"] : "";
}
