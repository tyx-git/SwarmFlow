/**
 * 自动上下文压缩阈值。
 *
 * 压缩阈值（compact_before_turn / compact_mid_turn）是固定默认值。
 */

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** 上下文管理阈值的配置接口。 */
export interface ContextThresholds {
  /** 用户输入边界的自动压缩触发百分比。 */
  compact_before_turn: number;
  /** 工具调用后中途自动压缩触发百分比，必须 >= compact_before_turn。 */
  compact_mid_turn: number;
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

/** 默认阈值常量：85% 回合前压缩，90% 回合中压缩。 */
export const DEFAULT_THRESHOLDS: ContextThresholds = {
  compact_before_turn: 85,
  compact_mid_turn: 90,
};
