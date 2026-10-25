/**
 * D10：TUI 检查点保存的布尔契约。
 */

import { describe, expect, it } from "vitest";

import { persistSessionLog } from "../../external/opentui/autosave.js";

describe("persistSessionLog", () => {
  it("成功落盘返回 true", () => {
    expect(persistSessionLog({
      getLogForPersistence: () => ({ meta: { turnCount: 1 } }),
      persistToDisk: () => true,
    }, true)).toBe(true);
  });

  it("无会话目录、0 轮、缺少实现或保存失败都返回 false", () => {
    const target = {
      getLogForPersistence: () => ({ meta: { turnCount: 1 } }),
      persistToDisk: () => true,
    };
    expect(persistSessionLog(target, false)).toBe(false);
    expect(persistSessionLog({
      getLogForPersistence: () => ({ meta: { turnCount: 0 } }),
      persistToDisk: () => true,
    }, true)).toBe(false);
    expect(persistSessionLog({}, true)).toBe(false);
    expect(persistSessionLog({ ...target, persistToDisk: () => false }, true)).toBe(false);
    expect(persistSessionLog({
      ...target,
      persistToDisk: (() => undefined) as unknown as () => boolean,
    }, true)).toBe(false);
  });

  it("读取或保存抛错时吞掉并返回 false", () => {
    expect(persistSessionLog({
      getLogForPersistence: () => { throw new Error("boom"); },
      persistToDisk: () => true,
    }, true)).toBe(false);
    expect(persistSessionLog({
      getLogForPersistence: () => ({ meta: { turnCount: 1 } }),
      persistToDisk: () => { throw new Error("boom"); },
    }, true)).toBe(false);
  });
});
