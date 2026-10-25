/**
 * R-3：主会话滚动区顶部的历史提示。
 *
 * 有更早页时显示“更早 N 条 + 加载提示”并允许点击；
 * 达到 8 MiB 页缓存上限后只显示上限提示，不再触发加载。
 */

import type { Session as TuiSession } from "../../../src/ui/contracts.js";
import type { UiText } from "../../../src/ui/text.js";

export interface HistoryBanner {
  label: string;
  canLoad: boolean;
}

export function buildHistoryBanner(
  session: TuiSession,
  text: UiText,
  selectedChildId: string | null,
  pageEntries: number,
): HistoryBanner | null {
  if (selectedChildId) return null;
  if (session.isHistoryCacheCapped?.()) {
    return { label: text.get(["Views", "history", "cacheCapped"]), canLoad: false };
  }
  if (!session.hasEarlierHistory?.()) return null;
  return {
    label: `${text.get(["Views", "history", "earlier"], { count: pageEntries })} · ${text.get(["Views", "history", "loadHint"])}`,
    canLoad: true,
  };
}
