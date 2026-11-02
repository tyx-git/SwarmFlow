import { describe, expect, it } from "vitest";
import { makeScriptedSession } from "../helpers/session-harness.js";

/**
 * /reload 的报告是给人看的一行式摘要：技能数量与已加载的 MCP 服务器数量。
 * system prompt 重建、工具可用性变更明细都属内部动作，不占报告行。
 */
describe("/reload report", () => {
  it("lists skill and MCP counts only", async () => {
    const harness = makeScriptedSession();
    try {
      const report = await harness.session.reloadConfigurationFromCommand();
      expect(report.split("\n")).toEqual([
        expect.stringMatching(/^Skills: \d+ loaded/),
        "MCP: 0 loaded",
      ]);
    } finally {
      harness.dispose();
    }
  });

  it("does not report the system prompt rebuild", async () => {
    const harness = makeScriptedSession();
    try {
      const report = await harness.session.reloadConfigurationFromCommand();
      expect(report).not.toContain("System prompt");
    } finally {
      harness.dispose();
    }
  });
});
