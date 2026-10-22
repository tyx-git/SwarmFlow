/**
 * 压缩阶段工具审批回归测试：
 * - 需要审批的工具调用在压缩期被就地降级为 ERROR tool_result，压缩正常完成；
 * - 若仍有挂起源绕过降级，压缩阶段快速失败且不写 marker。
 */
import { describe, expect, it } from "vitest";

import { Usage } from "../../src/providers/response.js";
import { makeScriptedSession, stageApprovalGate, testToolDef } from "../helpers/session-harness.js";

describe("compact phase tool approvals", () => {
  it("denies approval-needing tools during compact and completes", async () => {
    const h = makeScriptedSession({
      tools: [testToolDef("probe_tool")],
      toolExecutorOverrides: { probe_tool: () => "executed" },
      rounds: [
        {
          toolCalls: [{ id: "tc-ask", name: "probe_tool", arguments: {} }],
          usage: new Usage(6000, 20),
        },
        { text: "CONT", usage: new Usage(6500, 100) },
      ],
    });
    try {
      const holder = stageApprovalGate(h, "probe_tool");
      await h.session.runManualCompact();

      expect(h.session.compactCount).toBe(1);
      expect(h.internals._activeAsk).toBeFalsy();
      expect(holder.ask).toBeTruthy(); // 预检产生了审批请求，被压缩期降级
      // 压缩成功后该 tool_result 已随窗口归档（content 剥离），只断言存在。
      const denyResult = h.session.log.find(
        (e) =>
          e.type === "tool_result" &&
          (e.meta as Record<string, unknown>)["toolCallId"] === "tc-ask",
      );
      expect(denyResult).toBeTruthy();
      expect(
        h.session.log.some((e) => !e.discarded && e.type === "compact_marker"),
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("fails fast if the compact phase still suspends on an ask", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      (h.internals as Record<string, unknown>)["_runActivation"] = async () => ({
        text: "",
        suspendedAsk: { ask: { id: "a1" }, toolCallId: "tc-ask", roundIndex: 0 },
      });
      await expect(h.session.runManualCompact()).rejects.toThrow(/cannot suspend/);
      expect(
        h.session.log.filter((e) => !e.discarded && e.type === "compact_marker"),
      ).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });
});
