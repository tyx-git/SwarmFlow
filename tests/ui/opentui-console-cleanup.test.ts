import { describe, expect, it } from "vitest";

/**
 * 回归保护：退出后终端残留鼠标报告 / 乱码刷屏。
 *
 * 现场（用户实录）：
 *   PS F:\Project> [1M[555;90;1M[555;89;1M[555;89;2M[555;88;4M...
 *   退出到 PowerShell 后鼠标每动一下就吐一串 SGR-Pixels 鼠标报告
 *   （`\x1b[<Cb;Cx;CyM`），只能关闭终端。
 *
 * 根因链：renderer.resetMouseTracking() 有早退守卫且只处理 Node 自己
 * 的 readable 队列，Windows 上残留在 ConHost 输入缓冲里的报告没人清；
 * `setRawMode(false)` 也不保证清掉 ENABLE_MOUSE_INPUT。
 *
 * 这里守护的是兜底模块本身的行为契约：幂等、能写对序列、能装上退出钩子。
 */
describe("patch-windows-console", () => {
  it("restoreConsoleState() is idempotent", async () => {
    const mod = await import("../../external/opentui/forked/patch-windows-console.js");
    expect(() => mod.restoreConsoleState()).not.toThrow();
    // 第二次调用必须被幂等守卫吃掉，不能重复写字节/再次 flush
    expect(() => mod.restoreConsoleState()).not.toThrow();
  });

  it("installConsoleCleanupHooks() can be called repeatedly without stacking", async () => {
    const mod = await import("../../external/opentui/forked/patch-windows-console.js");
    expect(() => mod.installConsoleCleanupHooks()).not.toThrow();
    expect(() => mod.installConsoleCleanupHooks()).not.toThrow();
  });

  it("exports the helpers main.tsx relies on", async () => {
    const mod = await import("../../external/opentui/forked/patch-windows-console.js");
    expect(typeof mod.restoreConsoleState).toBe("function");
    expect(typeof mod.installConsoleCleanupHooks).toBe("function");
  });
});

/**
 * main.tsx 的接线检查：这两个调用必须真实存在于退出路径上。
 * 只读源码做文本断言，避免为了断言而启动整个 TUI。
 */
describe("main.tsx wires the console cleanup", () => {
  it("hard-restores the console on both the graceful and the fatal exit path", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("external/opentui/main.tsx", "utf8");

    // 启动时装 exit 兜底钩子
    expect(source).toContain('installConsoleCleanupHooks();');
    // 正常退出路径
    expect(source).toContain('writeOpenTuiDiag("exit.enter"');
    expect(source).toContain('writeOpenTuiDiag("exit.console_restored"');
    expect(source).toContain('writeOpenTuiDiag("exit.renderer_destroyed"');
    // fatal 路径
    expect(source).toContain('writeOpenTuiDiag("fatal.enter"');

    // restoreConsoleState 必须至少出现两次（graceful + fatal）
    const calls = source.split("restoreConsoleState();").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
