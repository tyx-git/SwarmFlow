/**
 * ContextManager 鈥?context-pressure state and decisions (P2.3).
 *
 * Owns the configurable thresholds, the two-tier hint state machine with
 * hysteresis, the context budget arithmetic, and the mid-turn compact
 * trigger. Pure decision logic: message delivery, compact execution, and
 * token accounting stay with Session and arrive through the deps interface.
 */

import type { ModelConfig } from "../config/config.js";
import {
  type ContextThresholds,
  DEFAULT_THRESHOLDS,
  computeHysteresisThresholds,
} from "../config/settings.js";

export type HintState = "none" | "level1_sent" | "level2_sent";

// -- Hint prompt generators (two-tier) --
function HINT_LEVEL1_PROMPT(pct: string, level2Pct: string): string {
  return `[SYSTEM: Context usage has reached ${pct}. This is the first-level reminder 鈥?a second will arrive at ${level2Pct}. No immediate action is required:
- If the task is mostly done, you may simply ignore this notice.
- If a large part of the task remains and the user has NOT already stated a summarization policy (in AGENTS.md or earlier in this conversation), consider asking the user (the \`ask\` tool fits well): (1) whether you may summarize older context with \`summarize_context\` as the session grows, and (2) whether you may choose the timing yourself. The user may not be familiar with this mechanism 鈥?briefly explain that summarizing turns already-consumed tool outputs and finished exploration into shorter summaries while keeping their own messages intact, and mention they can also do it manually anytime with /summarize.
Never summarize on your own without granted or standing permission. After handling this notice, continue your work.]`;
}

function HINT_LEVEL2_PROMPT(pct: string): string {
  return `[SYSTEM: Context usage has reached ${pct} 鈥?second-level reminder. When the window fills up, auto-compact will rewrite the whole conversation into a single summary, which is far more lossy than targeted summarization.
- If the remaining work is small, just finish it 鈥?no need to ask anything.
- If substantial work remains: with permission already granted (in this conversation or AGENTS.md), now is a good time to act 鈥?inspect with \`show_context\`, then \`summarize_context\` consumed tool results, finished exploration, and completed subtasks. Without permission, you are advised to ask the user for a summarization policy now 鈥?but if they previously declined, respect that and do not ask again.]`;
}

export interface ContextManagerDeps {
  getModelConfig(): ModelConfig;
  getBudgetCalcMode(): string | undefined;
  isCompactInProgress(): boolean;
  /** Root sessions auto-compact; children only get the 90% wrap-up warning. */
  canAutoCompact(): boolean;
  getLastInputTokens(): number;
  /** Queue a system notice for the model (hint prompts, child warning). */
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

  /** Live threshold object 鈥?summarize-hint config mutates it in place. */
  get thresholds(): ContextThresholds {
    return this._thresholds;
  }

  get budgetPercent(): number {
    return this._budgetPercent;
  }

  setBudgetPercent(value: number): void {
    this._budgetPercent = Math.max(1, Math.min(100, value));
  }

  /** Effective context length for a ModelConfig, scaled by budget percent. */
  effectiveContextLength(mc: ModelConfig): number {
    return Math.round(mc.contextLength * this._budgetPercent / 100);
  }

  /**
   * Context budget for pressure decisions (hints, compact triggers,
   * show_context), per the provider's accounting mode: fullContext budgets
   * the whole window and checks input tokens only; otherwise output headroom
   * is reserved out of the window.
   */
  budgetInfo(): { budget: number; fullContext: boolean } {
    const mc = this.deps.getModelConfig();
    const fullContext = this.deps.getBudgetCalcMode() === "full_context";
    const effective = this.effectiveContextLength(mc);
    return { budget: fullContext ? effective : effective - mc.maxTokens, fullContext };
  }

  /** Current two-tier summarize hint configuration. */
  getSummarizeHintConfig(): { enabled: boolean; level1: number; level2: number } {
    return {
      enabled: this._summarizeHintEnabled,
      level1: this._thresholds.context_hint_level1,
      level2: this._thresholds.context_hint_level2,
    };
  }

  /**
   * Update the two-tier summarize hint configuration (takes effect live).
   * Levels must be pre-validated by the caller (validateSummarizeHintLevels).
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
   * Check and inject summarize-hint prompts if thresholds are met.
   * Two-tier: level 1 and level 2, configurable via settings.json
   * (`summarize_hint`) and the /summarize_hint command.
   */
  checkAndInjectHint(): void {
    if (this.deps.isCompactInProgress()) return;

    const { budget } = this.budgetInfo();
    if (budget <= 0) return;

    const ratio = this.deps.getLastInputTokens() / budget;
    const pct = `${Math.round(ratio * 100)}%`;

    // Child sessions: single warning at 90%, no summarize_context guidance
    if (!this.deps.canAutoCompact()) {
      if (ratio >= 0.90 && this._hintState === "none") {
        this.deps.deliverSystemNotice(
          `[SYSTEM: Context usage has reached ${pct}. You are approaching the context limit and do NOT have context management tools. Finish your current work as quickly as possible 鈥?avoid reading large files, reduce tool calls, and focus only on producing your final output. If work progress is not promising, stop now and output what you have so far.]`,
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
   * Update hint state based on actual inputTokens from the latest API call.
   * Implements hysteresis to prevent oscillation.
   * Reset thresholds are auto-derived from trigger thresholds.
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
    // ratio >= hintResetLevel1: keep current state (don't downgrade)
  }

  /**
   * Build the mid-turn compact trigger for the tool loop, or undefined when
   * compact checking is off (compact already running, or a child session).
   */
  buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
    if (this.deps.isCompactInProgress()) return undefined;

    // Child sessions do not auto-compact; they receive a 90% warning instead
    // (see checkAndInjectHint) and are expected to finish or stop.
    if (!this.deps.canAutoCompact()) return undefined;

    const { budget, fullContext } = this.budgetInfo();

    if (budget <= 0) return undefined;

    const midTurnRatio = this._thresholds.compact_mid_turn / 100;

    return (inputTokens: number, outputTokens: number, hasToolCalls: boolean) => {
      // Only trigger mid-turn compact on tool-call path. Text-only responses
      // mean the turn is ending; compact at the start of the NEXT turn instead.
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
