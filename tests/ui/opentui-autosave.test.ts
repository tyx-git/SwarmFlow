/**
 * D10：TUI 检查点保存的布尔契约。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  persistSessionLog,
  SessionSaveController,
} from "../../external/opentui/autosave.js";

afterEach(() => {
  vi.useRealTimers();
});

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

  it("未安排保存时 flush 视为成功，不把干净会话标成 dirty", () => {
    let persisted = 0;
    let before = 0;
    const controller = new SessionSaveController(
      {
        getLogForPersistence: () => ({ meta: { turnCount: 0 } }),
        persistToDisk: () => {
          persisted += 1;
          return false;
        },
      },
      () => true,
      undefined,
      () => { before += 1; },
    );

    expect(controller.flush()).toBe(true);
    expect(controller.isDirty()).toBe(false);
    expect(persisted).toBe(0);
    expect(before).toBe(1);
    controller.dispose();
  });

  it("保存失败保留dirty并按退避重试，成功后清除状态", () => {
    vi.useFakeTimers();
    let attempts = 0;
    const statuses: string[] = [];
    const controller = new SessionSaveController(
      {
        getLogForPersistence: () => ({ meta: { turnCount: 1 } }),
        persistToDisk: () => ++attempts >= 2,
      },
      () => true,
      (status) => statuses.push(status.state),
    );

    expect(controller.schedule()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(attempts).toBe(1);
    expect(controller.isDirty()).toBe(true);
    expect(statuses).toContain("retrying");

    vi.advanceTimersByTime(1_000);
    expect(attempts).toBe(2);
    expect(controller.isDirty()).toBe(false);
    expect(statuses.at(-1)).toBe("saved");
    controller.dispose();
  });
});
