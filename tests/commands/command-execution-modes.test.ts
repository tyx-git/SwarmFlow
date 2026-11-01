import { describe, expect, it } from "vitest";
import { buildDefaultRegistry } from "../../src/commands/registration.js";

/**
 * 命令与运行中回合的关系决定 TUI 是否放行：
 * - always：任何状态下直达；
 * - whenBusy：回合运行中直达；
 * - queued：回合结束后执行；
 * - 未声明：回合运行中拒绝并提示「请等助手完成当前工作」。
 *
 * 这张表按命令的真实副作用冻结，新增或调整命令时必须同步。
 */
const EXPECTED_MODES: Record<string, "always" | "whenBusy" | "queued" | undefined> = {
  "/help": "whenBusy",
  "/usage": "always",
  "/new": "always",
  "/rename": "whenBusy",
  "/status": "always",
  "/history": "always",
  "/compact": "queued",
  "/clear": "always",
  "/fork": "whenBusy",
  "/ps": "always",
  "/ask": undefined,
  "/init": undefined,
  "/plan": "queued",
  "/goal": undefined,
  "/fix": undefined,
  "/reviewer": undefined,
  "/diff": "whenBusy",
  "/provider": "queued",
  "/model": undefined,
  "/agents": "whenBusy",
  "/permission": "whenBusy",
  "/skills": "queued",
  "/skills-creater": undefined,
  "/mcp": "queued",
  "/hooks": "whenBusy",
  "/memory": "always",
  "/reload": "queued",
  "/theme": "whenBusy",
  "/language": "whenBusy",
  "/rewind": undefined,
};

describe("slash command execution modes", () => {
  it("registers exactly the commands covered by the contract table", () => {
    const registry = buildDefaultRegistry();
    const names = registry.getAll().map((command) => command.name).sort();
    expect(names).toEqual(Object.keys(EXPECTED_MODES).sort());
  });

  it.each(Object.entries(EXPECTED_MODES))("%s uses its declared execution mode", (name, mode) => {
    const registry = buildDefaultRegistry();
    expect(registry.lookup(name)?.executionMode).toBe(mode);
  });

  it("keeps every runnable command in a known bucket", () => {
    const registry = buildDefaultRegistry();
    for (const command of registry.getAll()) {
      if (command.executionMode === undefined) continue;
      expect(["always", "whenBusy", "queued"]).toContain(command.executionMode);
    }
  });
});
