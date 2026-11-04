import { describe, expect, it } from "vitest";

import { asyncRunToolLoop } from "../../src/agents/tool-loop/run.js";
import { createEphemeralLogState } from "../../src/context/ephemeral-log.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { BaseProvider } from "../../src/providers/base.js";
import { ProviderResponse, Usage } from "../../src/providers/response.js";
import type { ToolCall, ToolDef } from "../../src/providers/types.js";

const WRITE_PLAN_TOOL = {
  name: "write_plan",
  description: "test plan writer",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      intent: { type: "string" },
    },
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

describe("tool-loop per-call lifecycle", () => {
  it("does not execute closed tool calls whose final JSON is invalid", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);
    const executedArgs: Array<Record<string, unknown>> = [];

    class RepairedWriteProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: any[],
        _tools?: any[],
        options?: {
          onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
          onToolCallClosed?: (call: ToolCall) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          const partial = "{\"path\":\"demo.txt\",\"content\":\"hello";
          options?.onToolCallPartial?.("write_1", "write_plan", partial);
          options?.onToolCallClosed?.({
            id: "write_1",
            name: "write_plan",
            rawArguments: partial,
            arguments: {},
            parseError: "Failed to parse write_plan stream tool arguments as JSON (37 chars).",
          });
          return new ProviderResponse({
            usage: new Usage(1, 1),
          });
        }
        return new ProviderResponse({
          text: "done",
          usage: new Usage(1, 1),
        });
      }
    }

    const result = await asyncRunToolLoop({
      provider: new RepairedWriteProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      toolExecutors: {
        write_plan: async (args) => {
          executedArgs.push(args);
          return "OK";
        },
      },
      maxRounds: 2,
      onToolCallPartial: () => {},
      updateEntry: createUpdateEntry(runtime.entries),
    });

    expect(executedArgs).toEqual([]);
    const toolResult = runtime.entries.find((entry) => entry.type === "tool_result");
    expect((toolResult?.content as { content?: string } | undefined)?.content).toContain("Failed to parse");
    expect(result.text).toBe("done");
  });

  it("continues to the next round when streamed tool calls are missing from the provider final response", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);
    const events: string[] = [];

    class MissingFinalToolCallsProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: any[],
        _tools?: any[],
        options?: {
          onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
          onToolCallClosed?: (call: ToolCall) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          options?.onToolCallPartial?.("call_missing", "read_file", "{\"path\":\"late.txt\"}");
          options?.onToolCallClosed?.({
            id: "call_missing",
            name: "read_file",
            rawArguments: "{\"path\":\"late.txt\"}",
            arguments: { path: "late.txt" },
            parseError: null,
          });
          events.push("provider:return-no-toolcalls");
          return new ProviderResponse({
            toolCalls: [],
            usage: new Usage(1, 1),
          });
        }

        events.push("provider:second-round");
        return new ProviderResponse({
          text: "done",
          usage: new Usage(1, 1),
        });
      }
    }

    const result = await asyncRunToolLoop({
      provider: new MissingFinalToolCallsProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      toolExecutors: {
        read_file: async (args) => {
          events.push(`tool:${String(args["path"] ?? "")}`);
          return "OK";
        },
      },
      maxRounds: 2,
      onToolCallPartial: () => {},
      updateEntry: createUpdateEntry(runtime.entries),
    });

    expect(events).toContain("tool:late.txt");
    expect(events).toContain("provider:return-no-toolcalls");
    expect(events).toContain("provider:second-round");
    expect(events.indexOf("provider:return-no-toolcalls")).toBeLessThan(events.indexOf("tool:late.txt"));
    expect(events.indexOf("tool:late.txt")).toBeLessThan(events.indexOf("provider:second-round"));
    expect(result.text).toBe("done");
  });

  it("keeps hidden plan-style writes out of the TUI transcript", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);

    class HiddenWriteProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: any[],
        _tools?: any[],
        options?: {
          onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
          onToolCallClosed?: (call: ToolCall) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          options?.onToolCallPartial?.("write_1", "write_plan", "{\"path\":\"/tmp/plan.md\",\"content\":\"- [ ] test\"}");
          options?.onToolCallClosed?.({
            id: "write_1",
            name: "write_plan",
            rawArguments: "{\"path\":\"/tmp/plan.md\",\"content\":\"- [ ] test\"}",
            arguments: { path: "/tmp/plan.md", content: "- [ ] test" },
            parseError: null,
          });
          return new ProviderResponse({
            usage: new Usage(1, 1),
          });
        }
        return new ProviderResponse({
          text: "done",
          usage: new Usage(1, 1),
        });
      }
    }

    await asyncRunToolLoop({
      provider: new HiddenWriteProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      tools: [WRITE_PLAN_TOOL],
      toolExecutors: {
        write_plan: async () => "OK",
      },
      maxRounds: 2,
      onToolCallPartial: () => {},
      resolveToolCallVisibility: ({ toolName, toolArgs, defaultDecision }) => {
        if (toolName === "write_plan" && toolArgs.path === "/tmp/plan.md") {
          return "hide";
        }
        return defaultDecision;
      },
      updateEntry: createUpdateEntry(runtime.entries),
    });

    const toolCall = runtime.entries.find((entry) => entry.type === "tool_call");
    const toolResult = runtime.entries.find((entry) => entry.type === "tool_result");
    expect(toolCall?.tuiVisible).toBe(false);
    expect(toolCall?.displayKind).toBeNull();
    expect(toolResult?.tuiVisible).toBe(false);
    expect(toolResult?.displayKind).toBeNull();
  });

  it("keeps spawn-intent file writes out of the TUI transcript", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);

    class HiddenSpawnIntentProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: any[],
        _tools?: any[],
        options?: {
          onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
          onToolCallClosed?: (call: ToolCall) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          options?.onToolCallPartial?.(
            "write_1",
            "write_plan",
            "{\"path\":\"/tmp/spawn.yaml\",\"content\":\"agents: []\",\"intent\":\"spawn\"}",
          );
          options?.onToolCallClosed?.({
            id: "write_1",
            name: "write_plan",
            rawArguments: "{\"path\":\"/tmp/spawn.yaml\",\"content\":\"agents: []\",\"intent\":\"spawn\"}",
            arguments: { path: "/tmp/spawn.yaml", content: "agents: []", intent: "spawn" },
            parseError: null,
          });
          return new ProviderResponse({
            usage: new Usage(1, 1),
          });
        }
        return new ProviderResponse({
          text: "done",
          usage: new Usage(1, 1),
        });
      }
    }

    await asyncRunToolLoop({
      provider: new HiddenSpawnIntentProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      tools: [WRITE_PLAN_TOOL],
      toolExecutors: {
        write_plan: async () => "OK",
      },
      maxRounds: 2,
      onToolCallPartial: () => {},
      resolveToolCallVisibility: ({ toolName, toolArgs, defaultDecision }) => {
        if (toolName === "write_plan" && toolArgs.intent === "spawn") {
          return "hide";
        }
        return defaultDecision;
      },
      updateEntry: createUpdateEntry(runtime.entries),
    });

    const toolCall = runtime.entries.find((entry) => entry.type === "tool_call");
    const toolResult = runtime.entries.find((entry) => entry.type === "tool_result");
    expect(toolCall?.tuiVisible).toBe(false);
    expect(toolCall?.displayKind).toBeNull();
    expect(toolResult?.tuiVisible).toBe(false);
    expect(toolResult?.displayKind).toBeNull();
  });

  it("promotes hidden tool calls back to visible entries when execution fails", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);

    class HiddenWriteProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: any[],
        _tools?: any[],
        options?: {
          onToolCallPartial?: (callId: string, name: string, rawArguments: string) => void;
          onToolCallClosed?: (call: ToolCall) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          options?.onToolCallPartial?.("write_1", "write_plan", "{\"path\":\"/tmp/plan.md\",\"content\":\"- [ ] fail\"}");
          options?.onToolCallClosed?.({
            id: "write_1",
            name: "write_plan",
            rawArguments: "{\"path\":\"/tmp/plan.md\",\"content\":\"- [ ] fail\"}",
            arguments: { path: "/tmp/plan.md", content: "- [ ] fail" },
            parseError: null,
          });
          return new ProviderResponse({
            usage: new Usage(1, 1),
          });
        }
        return new ProviderResponse({
          text: "done",
          usage: new Usage(1, 1),
        });
      }
    }

    await asyncRunToolLoop({
      provider: new HiddenWriteProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      tools: [WRITE_PLAN_TOOL],
      toolExecutors: {
        write_plan: async () => "ERROR: failed to update plan",
      },
      maxRounds: 2,
      onToolCallPartial: () => {},
      resolveToolCallVisibility: ({ toolName, toolArgs, defaultDecision }) => {
        if (toolName === "write_plan" && toolArgs.path === "/tmp/plan.md") {
          return "hide";
        }
        return defaultDecision;
      },
      updateEntry: createUpdateEntry(runtime.entries),
    });

    const toolCall = runtime.entries.find((entry) => entry.type === "tool_call");
    const toolResult = runtime.entries.find((entry) => entry.type === "tool_result");
    expect(toolCall?.tuiVisible).toBe(true);
    expect(toolCall?.displayKind).toBe("tool_call");
    expect(toolResult?.tuiVisible).toBe(true);
    expect(toolResult?.displayKind).toBe("tool_result");
    expect(String((toolResult?.content as { content?: string } | undefined)?.content)).toContain("failed to update plan");
  });
});
