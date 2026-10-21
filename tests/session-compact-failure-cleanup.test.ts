/**
 * 压缩失败清理回归测试：非 abort 失败后，隐藏压缩提示与半截工具调用
 * 不得留在日志的 API 投影中（与 restore 的 validateAndRepairLog 规则一致）。
 */
import { describe, expect, it } from "vitest";

import { projectToApiMessages } from "../src/context/log-projection.js";
import { Usage } from "../src/providers/base.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

type Harness = ReturnType<typeof makeScriptedSession>;

function liveCompactPhaseEntries(h: Harness) {
  return h.session.log.filter(
    (e) => !e.discarded && Boolean((e.meta as Record<string, unknown>)["compactPhase"]),
  );
}

function projectionText(h: Harness): string {
  return JSON.stringify(projectToApiMessages(h.session.log));
}

describe("compact failure cleanup", () => {
  it("manual compact failure discards the compact prompt and half tool call", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      h.provider.sendMessage = async (_messages, _tools, options) => {
        options?.onToolCallClosed?.({
          id: "probe-1",
          name: "probe_tool",
          rawArguments: "{}",
          arguments: {},
          parseError: null,
        });
        throw new Error("stream broke");
      };

      await expect(h.session.runManualCompact()).rejects.toThrow("stream broke");

      expect(liveCompactPhaseEntries(h)).toHaveLength(0);
      expect(projectionText(h)).not.toContain("Condense this conversation");

      const hasResult = h.session.log.some(
        (e) =>
          !e.discarded &&
          e.type === "tool_result" &&
          (e.meta as Record<string, unknown>)["toolCallId"] === "probe-1",
      );
      const orphanCall = h.session.log.some(
        (e) =>
          !e.discarded &&
          e.type === "tool_call" &&
          (e.meta as Record<string, unknown>)["toolCallId"] === "probe-1",
      );
      expect(orphanCall && !hasResult).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("before-turn compact failure discards the compact prompt", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      h.internals._lastInputTokens = 7000;
      h.internals._lastTotalTokens = 7500;
      h.provider.sendMessage = async () => {
        throw new Error("provider down");
      };

      await expect(h.session.turn("trigger compact")).rejects.toThrow("provider down");

      expect(liveCompactPhaseEntries(h)).toHaveLength(0);
      expect(projectionText(h)).not.toContain("Condense this conversation");
    } finally {
      h.dispose();
    }
  });

  it("mid-turn compact failure discards the compact prompt", async () => {
    const h = makeScriptedSession({
      rounds: [
        {
          toolCalls: [{ id: "probe-1", name: "probe_tool", arguments: {} }],
          usage: new Usage(7000, 5),
        },
      ],
      toolExecutorOverrides: { probe_tool: () => "ok" },
    });
    try {
      h.session.permissionMode = "yolo";
      h.internals._thresholds.compact_mid_turn = 1;
      const original = h.provider.sendMessage.bind(h.provider);
      let calls = 0;
      h.provider.sendMessage = async (...args: Parameters<typeof original>) => {
        calls += 1;
        if (calls === 1) return original(...args);
        throw new Error("compact provider down");
      };

      await expect(h.session.turn("trigger mid-turn")).rejects.toThrow("compact provider down");

      expect(liveCompactPhaseEntries(h)).toHaveLength(0);
      expect(projectionText(h)).not.toContain("Condense this conversation");
    } finally {
      h.dispose();
    }
  });
});
