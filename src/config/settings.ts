/**
 * Context management thresholds and hysteresis computation.
 *
 * Compact thresholds are fixed defaults. The summarize-hint levels are
 * configurable via settings.json (`summarize_hint`) and the /summarize_hint
 * command. The user controls effective context size via
 * context_budget_percent.
 */

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface ContextThresholds {
  /** Context hint level 1 trigger (percentage of effective context budget). */
  context_hint_level1: number;
  /** Context hint level 2 trigger (percentage, must be >= level1). */
  context_hint_level2: number;
  /** Auto-compact trigger at user-input boundary (percentage). */
  compact_before_turn: number;
  /** Auto-compact trigger mid-turn after tool calls (percentage, must be >= compact_before_turn). */
  compact_mid_turn: number;
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

export const DEFAULT_THRESHOLDS: ContextThresholds = {
  context_hint_level1: 50,
  context_hint_level2: 75,
  compact_before_turn: 85,
  compact_mid_turn: 90,
};

/**
 * Validate summarize-hint trigger levels. Returns an error message, or null
 * when valid. Levels must be integers with 0 < level1 < level2 < 85.
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
 * Compute hysteresis reset thresholds from trigger thresholds.
 * These are not user-configurable; they are auto-derived.
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
