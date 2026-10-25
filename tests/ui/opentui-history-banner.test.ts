/**
 * R-3：主会话顶部历史提示的文案与可加载状态。
 */

import { describe, expect, it } from "vitest";

import { buildHistoryBanner } from "../../external/opentui/transcript/history-banner.js";
import { createUiText } from "../../src/ui/text.js";

const text = createUiText("zh");

function session(overrides: { earlier?: boolean; capped?: boolean }): any {
  return {
    hasEarlierHistory: () => overrides.earlier === true,
    isHistoryCacheCapped: () => overrides.capped === true,
  };
}

describe("buildHistoryBanner", () => {
  it("有更早页时显示条数与加载提示", () => {
    expect(buildHistoryBanner(session({ earlier: true }), text, null, 200)).toEqual({
      label: "更早 200 条 · 点击或按 PageUp 加载",
      canLoad: true,
    });
  });

  it("达到缓存上限后只显示上限提示", () => {
    expect(buildHistoryBanner(session({ earlier: true, capped: true }), text, null, 200)).toEqual({
      label: "更早历史已达 8 MiB 缓存上限",
      canLoad: false,
    });
  });

  it("没有更早页或查看子会话时不显示", () => {
    expect(buildHistoryBanner(session({}), text, null, 200)).toBeNull();
    expect(buildHistoryBanner(session({ earlier: true }), text, "child-1", 200)).toBeNull();
  });
});
