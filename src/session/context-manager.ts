/**
 * ContextManager —— 上下文压力状态与决策（P2.3）。
 *
 * 拥有可配置阈值、双层提示状态机、上下文预算算法、
 * 以及中途压缩触发器。纯决策逻辑：
 * 消息传递、压缩执行、token 记账留在 Session，通过 deps 接口传入。
 *
 * 阈值层次：
 *   - 50%：一级提示——建议针对性压缩
 *   - 75%：二级提示——警告即将自动 compact
 *   - 85%：回合前 compact
 *   - 90%：回合中 compact
 */

import type { ModelConfig } from "../config/config.js";
import {
  type ContextThresholds,
  DEFAULT_THRESHOLDS,
  computeHysteresisThresholds,
} from "../config/settings.js";

/** 压缩提示状态机状态。 */
export type HintState = "none" | "level1_sent" | "level2_sent";

// -- 提示文本生成器（两级）--

/** 一级提示文本：当上下文使用达到第一阈值时发送给模型。 */
function HINT_LEVEL1_PROMPT(pct: string, level2Pct: string): string {
  return `[SYSTEM: Context usage has reached ${pct}. This is the first-level reminder — a second will arrive at ${level2Pct}. No immediate action is required:
- If the task is mostly done, you may simply ignore this notice.
- If a large part of the task remains and the user has NOT already stated a summarization policy (in AGENTS.md or earlier in this conversation), consider asking the user (the \`ask\` tool fits well): (1) whether you may summarize older context with \`summarize_context\` as the session grows, and (2) whether you may choose the timing yourself. The user may not be familiar with this mechanism — briefly explain that summarizing turns already-consumed tool outputs and finished exploration into shorter summaries while keeping their own messages intact, and mention they can also do it manually anytime with /summarize.
Never summarize on your own without granted or standing permission. After handling this notice, continue your work.]`;
}

/** 二级提示文本：当上下文使用达到第二阈值时发送。 */
function HINT_LEVEL2_PROMPT(pct: string): string {
  return `[SYSTEM: Context usage has reached ${pct} — second-level reminder. When the window fills up, auto-compact will rewrite the whole conversation into a single summary, which is far more lossy than targeted summarization.
- If the remaining work is small, just finish it — no need to ask anything.
- If substantial work remains: with permission already granted (in this conversation or AGENTS.md), now is a good time to act — inspect with \`show_context\`, then \`summarize_context\` consumed tool results, finished exploration, and completed subtasks. Without permission, you are advised to ask the user for a summarization policy now — but if they previously declined, respect that and do not ask again.]`;
}

export interface ContextManagerDeps {
  getModelConfig(): ModelConfig;
  getBudgetCalcMode(): string | undefined;
  isCompactInProgress(): boolean;
  /** 根会话自动压缩；子会话仅有 90%  wrap-up 警告。 */
  canAutoCompact(): boolean;
  getLastInputTokens(): number;
  /** 将系统通知加入模型输入队列（提示、子会话警告）。 */
  deliverSystemNotice(content: string): void;
}

export class ContextManager {
  private _thresholds: ContextThresholds = { ...DEFAULT_THRESHOLDS };
  private _hintResetNone = computeHysteresisThresholds(DEFAULT_THRESHOLDS).hintResetNone / 100;
  private _hintResetLevel1 = computeHysteresisThresholds(DEFAULT_THRESHOLDS).hintResetLevel1 / 100;
  private _summarizeHintEnabled = true;
  private _budgetPercent = 100;
  private _hintState: HintState = "none";

  constructor(private readonly deps: ContextManagerDeps) {}

  get hintState(): HintState {
    return this._hintState;
  }

  set hintState(value: HintState) {
    this._hintState = value;
  }

  /** 实时阈值对象——summarize-hint 配置会就地修改。 */
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
   * 压力决策用的上下文预算（提示、压缩触发、show_context）。
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

  /** 当前两级 summarize hint 配置。 */
  getSummarizeHintConfig(): { enabled: boolean; level1: number; level2: number } {
    return {
      enabled: this._summarizeHintEnabled,
      level1: this._thresholds.context_hint_level1,
      level2: this._thresholds.context_hint_level2,
    };
  }

  /**
   * 更新两级 summarize hint 配置（实时生效）。
   * 层级必须预先验证（validateSummarizeHintLevels）。
   */
  setSummarizeHintConfig(config: { enabled?: boolean; level1?: number; level2?: number }): void {
    if (config.enabled !== undefined) this._summarizeHintEnabled = config.enabled;
    if (config.level1 !== undefined) this._thresholds.context_hint_level1 = config.level1;
    if (config.level2 !== undefined) this._thresholds.context_hint_level2 = config.level2;
    const hysteresis = computeHysteresisThresholds(this._thresholds);
    this._hintResetNone = hysteresis.hintResetNone / 100;
    this._hintResetLevel1 = hysteresis.hintResetLevel1 / 100;
  }

  /**
   * 检查并在需要时注入 summarize-hint 提示。
   * 两级：level 1 和 level 2，通过 settings.json（summarize_hint）和 /summarize_hint 命令配置。
   *
   * 子会话：仅在 90% 警告，无 summarize_context 指导。
   */
  checkAndInjectHint(): void {
    if (this.deps.isCompactInProgress()) return;

    const { budget } = this.budgetInfo();
    if (budget <= 0) return;

    const ratio = this.deps.getLastInputTokens() / budget;
    const pct = `${Math.round(ratio * 100)}%`;

    // 子会话：90% 单次警告
    if (!this.deps.canAutoCompact()) {
      if (ratio >= 0.90 && this._hintState === "none") {
        this.deps.deliverSystemNotice(
          `[SYSTEM: Context usage has reached ${pct}. You are approaching the context limit and do NOT have context management tools. Finish your current work as quickly as possible — avoid reading large files, reduce tool calls, and focus only on producing your final output. If work progress is not promising, stop now and output what you have so far.]`,
        );
        this._hintState = "level2_sent";
      }
      return;
    }

    if (!this._summarizeHintEnabled) return;

    const level2Ratio = this._thresholds.context_hint_level2 / 100;
    const level1Ratio = this._thresholds.context_hint_level1 / 100;

    if (ratio >= level2Ratio && this._hintState !== "level2_sent") {
      this.deps.deliverSystemNotice(HINT_LEVEL2_PROMPT(pct));
      this._hintState = "level2_sent";
    } else if (ratio >= level1Ratio && this._hintState === "none") {
      const level2Pct = `${Math.round(this._thresholds.context_hint_level2)}%`;
      this.deps.deliverSystemNotice(HINT_LEVEL1_PROMPT(pct, level2Pct));
      this._hintState = "level1_sent";
    }
  }

  /**
   * 根据最新 API 调用的实际 inputTokens 更新提示状态。
   * 实现迟滞以防止振荡；重置阈值从触发阈值自动推导。
   */
  updateHintStateAfterApiCall(): void {
    const { budget } = this.budgetInfo();
    if (budget <= 0) return;

    const ratio = this.deps.getLastInputTokens() / budget;

    if (ratio < this._hintResetNone) {
      this._hintState = "none";
    } else if (ratio < this._hintResetLevel1) {
      this._hintState = "level1_sent";
    }
    // ratio >= hintResetLevel1：保持当前状态（不降级）
  }

  /**
   * 为 tool loop 构建中途压缩触发器。
   * 当压缩进行中或为子会话时返回 undefined。
   */
  buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
    if (this.deps.isCompactInProgress()) return undefined;

    // 子会话不自动压缩；收到 90% 警告后自行结束（见 checkAndInjectHint）
    if (!this.deps.canAutoCompact()) return undefined;

    const { budget, fullContext } = this.budgetInfo();

    if (budget <= 0) return undefined;

    const midTurnRatio = this._thresholds.compact_mid_turn / 100;

    return (inputTokens: number, outputTokens: number, hasToolCalls: boolean) => {
      // 仅在 tool-call 路径触发中途压缩。纯文本响应意味着回合即将结束；
      // 在下一个回合开始时压缩。
      if (!hasToolCalls) return { compactNeeded: false };

      const tokensToCheck = fullContext
        ? inputTokens
        : inputTokens + outputTokens;

      if (tokensToCheck > midTurnRatio * budget) {
        return { compactNeeded: true, scenario: "mid_turn" };
      }
      return { compactNeeded: false };
    };
  }
}
