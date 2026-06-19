/**
 * 上下文管理阈值与迟滞计算。
 *
 * 压缩阈值（compact_before_turn / compact_mid_turn）是固定默认值。
 * summarize-hint 级别可通过 settings.json（summarize_hint 字段）和
 * /summarize_hint 命令配置。有效上下文大小由 context_budget_percent 控制。
 */

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** 上下文管理阈值的配置接口。 */
export interface ContextThresholds {
  /** 一级提示触发百分比（有效上下文预算的占比）。 */
  context_hint_level1: number;
  /** 二级提示触发百分比，必须 >= level1。 */
  context_hint_level2: number;
  /** 用户输入边界的自动压缩触发百分比。 */
  compact_before_turn: number;
  /** 工具调用后中途自动压缩触发百分比，必须 >= compact_before_turn。 */
  compact_mid_turn: number;
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

/** 默认阈值常量：50% / 75% 提示，85% 回合前压缩，90% 回合中压缩。 */
export const DEFAULT_THRESHOLDS: ContextThresholds = {
  context_hint_level1: 50,
  context_hint_level2: 75,
  compact_before_turn: 85,
  compact_mid_turn: 90,
};

/**
 * 验证 summarize-hint 触发级别。
 * 返回错误信息或 null（有效时）。
 * 级别必须为整数，满足 0 < level1 < level2 < 85。
 */
export function validateSummarizeHintLevels(level1: number, level2: number): string | null {
  if (!Number.isInteger(level1) || !Number.isInteger(level2)) {
    return "Levels must be integers.";
  }
  if (level1 <= 0 || level1 >= level2 || level2 >= 85) {
    return "Levels must satisfy 0 < level1 < level2 < 85.";
  }
  return null;
}

// ------------------------------------------------------------------
// Derived hysteresis thresholds
// ------------------------------------------------------------------

/**
 * 从触发阈值推导迟滞重置阈值。
 * 这些阈值不可由用户配置，由触发阈值自动推导：
 *   - hintResetNone = level1 - 20（迟滞窗口下限）
 *   - hintResetLevel1 = (level1 + level2) / 2（两个级别中间值）
 */
export function computeHysteresisThresholds(t: ContextThresholds): {
  hintResetNone: number;
  hintResetLevel1: number;
} {
  return {
    hintResetNone: t.context_hint_level1 - 20,
    hintResetLevel1: (t.context_hint_level1 + t.context_hint_level2) / 2,
  };
}
