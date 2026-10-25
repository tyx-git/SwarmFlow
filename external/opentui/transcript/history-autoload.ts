/**
 * R-3：滚动到顶自动加载下一页历史的边沿判定。
 *
 * 只在“原本不在顶部 → 到达顶部”时触发一次，避免停在顶部时反复加载全部历史。
 * PageUp 在顶部由调用方单独处理（每次按键加载一页）。
 */

export const HISTORY_AUTOLOAD_TOP_THRESHOLD = 1;

export function shouldLoadEarlierHistory(
  previousTop: number,
  currentTop: number,
  hasEarlier: boolean,
  loading = false,
): boolean {
  if (!hasEarlier || loading) return false;
  if (!Number.isFinite(previousTop) || !Number.isFinite(currentTop)) return false;
  return previousTop > HISTORY_AUTOLOAD_TOP_THRESHOLD
    && currentTop <= HISTORY_AUTOLOAD_TOP_THRESHOLD;
}

/** PageUp 处理：已经在顶部时，一次按键加载一页。 */
export function shouldLoadOnPageUp(atTop: boolean, hasEarlier: boolean): boolean {
  return atTop && hasEarlier;
}
