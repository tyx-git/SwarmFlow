/**
 * R-3 滚动自动加载的边沿判定（纯函数）。
 */

import { describe, expect, it } from "vitest";

import {
  HISTORY_AUTOLOAD_TOP_THRESHOLD,
  shouldLoadEarlierHistory,
  shouldLoadOnPageUp,
} from "../../external/opentui/transcript/history-autoload.js";

describe("滚动到顶自动加载", () => {
  it("只在从非顶部到达顶部时触发一次", () => {
    expect(shouldLoadEarlierHistory(8, 0, true)).toBe(true);
    expect(shouldLoadEarlierHistory(8, HISTORY_AUTOLOAD_TOP_THRESHOLD, true)).toBe(true);
  });

  it("已经在顶部、向下滚动、没有更早历史时不触发", () => {
    expect(shouldLoadEarlierHistory(0, 0, true)).toBe(false);
    expect(shouldLoadEarlierHistory(8, 3, true)).toBe(false);
    expect(shouldLoadEarlierHistory(8, 0, false)).toBe(false);
    expect(shouldLoadEarlierHistory(8, 0, true, true)).toBe(false);
    expect(shouldLoadEarlierHistory(Number.NaN, 0, true)).toBe(false);
  });

  it("PageUp 在顶部时每次按键加载一页", () => {
    expect(shouldLoadOnPageUp(true, true)).toBe(true);
    expect(shouldLoadOnPageUp(false, true)).toBe(false);
    expect(shouldLoadOnPageUp(true, false)).toBe(false);
  });
});
