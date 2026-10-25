/**
 * ContextManager —— 上下文压力状态与决策（P2.3）。
 *
 * 拥有自动压缩阈值和上下文预算算法、
 * 以及中途压缩触发器。纯决策逻辑：
 * 消息传递、压缩执行、token 记账留在 Session，通过 deps 接口传入。
 *
 * 阈值层次：
 *   - 80%：回合前 compact
 *   - 80%：回合中 compact
 */

import type { ModelConfig } from "../config/types.js";
import {
  type ContextThresholds,
  DEFAULT_THRESHOLDS,
} from "../config/compact-thresholds.js";

export interface ContextManagerDeps {
  getModelConfig(): ModelConfig;
  getBudgetCalcMode(): string | undefined;
  isCompactInProgress(): boolean;
  /** 根会话自动压缩；子会话不自动压缩。 */
  canAutoCompact(): boolean;
  /** provider 没有返回 usage 时，用本地估算的活动窗口 + 静态前缀 token 数。 */
  estimateContextTokens(): number;
}

export class ContextManager {
  private _thresholds: ContextThresholds = { ...DEFAULT_THRESHOLDS };
  private _budgetPercent = 100;

  constructor(private readonly deps: ContextManagerDeps) {}

  /** 实时阈值对象。 */
  get thresholds(): ContextThresholds {
    return this._thresholds;
  }

  get budgetPercent(): number {
    return this._budgetPercent;
  }

  setBudgetPercent(value: number): void {
    this._budgetPercent = Math.max(1, Math.min(100, value));
  }

  /** 根据 ModelConfig 和预算百分比计算有效上下文长度。 */
  effectiveContextLength(mc: ModelConfig): number {
    return Math.round(mc.contextLength * this._budgetPercent / 100);
  }

  /**
   * 压力决策用的上下文预算（提示与自动压缩触发）。
   * 根据 provider 的记账模式：
   * - fullContext：预算整个窗口，只检查输入 token
   * - 其他：保留输出 headroom，从窗口中扣除
   */
  budgetInfo(): { budget: number; fullContext: boolean } {
    const mc = this.deps.getModelConfig();
    const fullContext = this.deps.getBudgetCalcMode() === "full_context";
    const effective = this.effectiveContextLength(mc);
    return { budget: fullContext ? effective : effective - mc.maxTokens, fullContext };
  }

  /**
   * 为 tool loop 构建中途压缩触发器。
   * 当压缩进行中或为子会话时返回 undefined。
   */
  buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
    if (this.deps.isCompactInProgress()) return undefined;

    // 子会话不自动压缩。
    if (!this.deps.canAutoCompact()) return undefined;

    const { budget, fullContext } = this.budgetInfo();

    if (budget <= 0) return undefined;

    const midTurnRatio = this._thresholds.compact_mid_turn / 100;

    return (inputTokens: number, outputTokens: number, hasToolCalls: boolean) => {
      // 仅在 tool-call 路径触发中途压缩。纯文本响应意味着回合即将结束；
      // 在下一个回合开始时压缩。
      if (!hasToolCalls) return { compactNeeded: false };

      const tokensToCheck = fullContext
        ? (inputTokens > 0 ? inputTokens : this.deps.estimateContextTokens())
        : (inputTokens > 0 ? inputTokens : this.deps.estimateContextTokens()) + outputTokens;

      if (tokensToCheck > midTurnRatio * budget) {
        return { compactNeeded: true, scenario: "mid_turn" };
      }
      return { compactNeeded: false };
    };
  }
}
