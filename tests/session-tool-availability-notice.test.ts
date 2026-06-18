import { describe, expect, it, mock } from "bun:test";

import { Session } from "../src/session.js";

describe("tool availability system notices", () => {
  it("does not queue notices before the first real user message", () => {
    const session = Object.create(Session.prototype) as any;
    session._conversationStarted = false;
    session._deliverMessage = mock(() => ({ accepted: true }));

    session.notifySkillAvailabilityChanged({ disabled: ["docx"] });
    expect(session._deliverMessage).toHaveBeenCalledTimes(0);
  });

  it("queues separate non-waking notices for separate skill changes after the conversation has started", () => {
    const session = Object.create(Session.prototype) as any;
    session._conversationStarted = true;
    session._deliverMessage = mock(() => ({ accepted: true }));

    session.notifySkillAvailabilityChanged({ disabled: ["docx"] });
    session.notifySkillAvailabilityChanged({ enabled: ["xlsx"] });

    expect(session._deliverMessage).toHaveBeenCalledTimes(2);
    const first = session._deliverMessage.mock.calls[0]?.[0];
    const second = session._deliverMessage.mock.calls[1]?.[0];

    expect(first.wake).toBe(false);
    expect(first.tuiVisible).toBe(false);
    expect(first.content).toContain("Skills disabled:");
    expect(first.content).toContain("- docx");

    expect(second.wake).toBe(false);
    expect(second.content).toContain("Skills enabled:");
    expect(second.content).toContain("- xlsx");
  });

  it("queues MCP reconnect notices with concrete tool names", async () => {
    const session = Object.create(Session.prototype) as any;
    session._conversationStarted = true;
    session._deliverMessage = mock(() => ({ accepted: true }));
    session._mcpConnected = true;
    session._ensureMcp = mock(async () => {});

    let tools = [
      { name: "mcp__docs__search", description: "", parameters: {} },
      { name: "mcp__docs__fetch", description: "", parameters: {} },
    ];
    session._mcpManager = {
      getAllTools: () => tools,
      getServerStatuses: () => [{ name: "docs", state: "connected", toolCount: tools.length }],
      reconnectServer: mock(async () => {
        tools = [
          { name: "mcp__docs__search", description: "", parameters: {} },
          { name: "mcp__docs__lookup", description: "", parameters: {} },
        ];
        return true;
      }),
    };

    const ok = await session.reconnectMcpServer("docs");

    expect(ok).toBe(true);
    expect(session._ensureMcp).toHaveBeenCalledTimes(1);
    expect(session._deliverMessage).toHaveBeenCalledTimes(1);
    const notice = session._deliverMessage.mock.calls[0]?.[0];
    expect(notice.wake).toBe(false);
    expect(notice.content).toContain("MCP tools now available:");
    expect(notice.content).toContain("- mcp__docs__lookup");
    expect(notice.content).toContain("MCP tools no longer available:");
    expect(notice.content).toContain("- mcp__docs__fetch");
    expect(notice.content).toContain("do not infer from this change alone");
  });

  it("seeds _conversationStarted from a restored log that holds a real user message", () => {
    const session = Object.create(Session.prototype) as any;

    expect(
      session._entriesHaveRealUserMessage([
        { discarded: false, type: "status", meta: {} },
        { discarded: false, type: "user_message", meta: { inputKind: "summarize" } },
      ]),
    ).toBe(false);

    expect(
      session._entriesHaveRealUserMessage([
        { discarded: false, type: "user_message", meta: { inputKind: "user" } },
      ]),
    ).toBe(true);

    // Discarded user messages do not count.
    expect(
      session._entriesHaveRealUserMessage([
        { discarded: true, type: "user_message", meta: { inputKind: "user" } },
      ]),
    ).toBe(false);
  });
});
