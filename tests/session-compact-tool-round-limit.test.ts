/**
 * 压缩阶段达到工具轮数上限的回归测试：
 * 固定哨兵文案不得被当成 continuation，不得写入 marker / compact_context，
 * 也不得归档剥离历史。
 */
import { describe, expect, it } from "vitest";

import { projectToApiMessages } from "../src/context/log-projection.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

describe("compact phase tool-round limit", () => {
  it("fails the compact instead of archiving history with the sentinel text", async () => {
    const h = makeScriptedSession({
      maxToolRounds: 1,
      rounds: [{ toolCalls: [{ id: "probe-1", name: "probe_tool", arguments: {} }] }],
      toolExecutorOverrides: { probe_tool: () => "ok" },
    });
    try {
      h.session.permissionMode = "yolo";

      await expect(h.session.runManualCompact()).rejects.toThrow(/tool-round limit/);

      const markers = h.session.log.filter(
        (e) => !e.discarded && e.type === "compact_marker",
      );
      const contexts = h.session.log.filter(
        (e) => !e.discarded && e.type === "compact_context",
      );
      const archived = h.session.log.filter((e) => e.archived && e.content === null);
      const liveCompactPhase = h.session.log.filter(
        (e) => !e.discarded && Boolean((e.meta as Record<string, unknown>)["compactPhase"]),
      );
      const liveCall = h.session.log.find(
        (e) =>
          !e.discarded &&
          e.type === "tool_call" &&
          (e.meta as Record<string, unknown>)["toolCallId"] === "probe-1",
      );

      expect(markers).toHaveLength(0);
      expect(contexts).toHaveLength(0);
      expect(archived).toHaveLength(0);
      expect(liveCompactPhase).toHaveLength(0);
      // updateEntry 会用新 meta 整体替换，compactPhase 标签会丢失；
      // 清理必须按索引区间覆盖这类被同步更新过的 tool_call。
      expect(liveCall).toBeUndefined();
      expect(() =>
        projectToApiMessages(h.session.log, { enforceToolCallProtocol: true }),
      ).not.toThrow();
    } finally {
      h.dispose();
    }
  });
});
