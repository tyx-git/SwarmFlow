/**
 * Recovery strategies for swarm task failures.
 *
 * Provides retry logic (with backoff), fallback agents,
 * partial result handling, and abort coordination.
 *
 * @packageDocumentation
 */

import { RecoveryStrategy } from "./types.js";
import type { RecoveryConfig, TaskResult } from "./types.js";

/** Default recovery configs per strategy. */
export const DEFAULT_RECOVERY_CONFIGS: Record<RecoveryStrategy, RecoveryConfig> = {
  [RecoveryStrategy.Retry]: { strategy: RecoveryStrategy.Retry, maxRetries: 3, useFallbackModel: false },
  [RecoveryStrategy.RetryWithBackoff]: { strategy: RecoveryStrategy.RetryWithBackoff, maxRetries: 3, useFallbackModel: false },
  [RecoveryStrategy.Fallback]: { strategy: RecoveryStrategy.Fallback, maxRetries: 1, useFallbackModel: true },
  [RecoveryStrategy.Partial]: { strategy: RecoveryStrategy.Partial, maxRetries: 0, useFallbackModel: false },
  [RecoveryStrategy.Abort]: { strategy: RecoveryStrategy.Abort, maxRetries: 0, useFallbackModel: false },
};

/** Outcome of a recovery attempt. */
export interface RecoveryOutcome {
  /** Whether recovery was successful. */
  recovered: boolean;
  /** Number of retries attempted. */
  retriesAttempted: number;
  /** Final error if not recovered. */
  finalError?: string;
  /** Whether a fallback model was used. */
  usedFallback: boolean;
  /** Total time spent on recovery (ms). */
  recoveryTimeMs: number;
}

/** Callback type for re-executing a task. */
export type RetryFn = () => Promise<TaskResult>;

/**
 * Attempt to recover from a task failure using the specified strategy.
 *
 * @param config - Recovery configuration
 * @param retryFn - Function that re-executes the task
 * @param initialError - The original error message
 * @returns Recovery outcome
 */
export async function attemptRecovery(
  config: RecoveryConfig,
  retryFn: RetryFn,
  initialError: string,
): Promise<RecoveryOutcome> {
  const startTime = Date.now();
  let lastError = initialError;
  let usedFallback = false;

  switch (config.strategy) {
    case RecoveryStrategy.Retry:
      return retryWithLinear(config, retryFn, lastError, startTime);

    case RecoveryStrategy.RetryWithBackoff:
      return retryWithBackoff(config, retryFn, lastError, startTime);

    case RecoveryStrategy.Fallback:
      usedFallback = true;
      return retryWithLinear(
        { ...config, maxRetries: 1 },
        retryFn,
        lastError,
        startTime,
      );

    case RecoveryStrategy.Partial:
      return {
        recovered: false,
        retriesAttempted: 0,
        finalError: `Partial result used: ${lastError}`,
        usedFallback: false,
        recoveryTimeMs: Date.now() - startTime,
      };

    case RecoveryStrategy.Abort:
      return {
        recovered: false,
        retriesAttempted: 0,
        finalError: lastError,
        usedFallback: false,
        recoveryTimeMs: Date.now() - startTime,
      };
  }
}

/**
 * Retry with linear delay between attempts.
 */
async function retryWithLinear(
  config: RecoveryConfig,
  retryFn: RetryFn,
  initialError: string,
  startTime: number,
): Promise<RecoveryOutcome> {
  let lastError = initialError;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    await sleep(1000 * attempt); // 1s, 2s, 3s...

    try {
      const result = await retryFn();
      if (result.success) {
        return {
          recovered: true,
          retriesAttempted: attempt,
          usedFallback: config.useFallbackModel,
          recoveryTimeMs: Date.now() - startTime,
        };
      }
      lastError = result.error ?? "Unknown error";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    recovered: false,
    retriesAttempted: config.maxRetries,
    finalError: lastError,
    usedFallback: config.useFallbackModel,
    recoveryTimeMs: Date.now() - startTime,
  };
}

/**
 * Retry with exponential backoff: 1s, 2s, 4s, 8s...
 */
async function retryWithBackoff(
  config: RecoveryConfig,
  retryFn: RetryFn,
  initialError: string,
  startTime: number,
): Promise<RecoveryOutcome> {
  let lastError = initialError;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000); // up to 30s
    await sleep(delay);

    try {
      const result = await retryFn();
      if (result.success) {
        return {
          recovered: true,
          retriesAttempted: attempt,
          usedFallback: config.useFallbackModel,
          recoveryTimeMs: Date.now() - startTime,
        };
      }
      lastError = result.error ?? "Unknown error";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    recovered: false,
    retriesAttempted: config.maxRetries,
    finalError: lastError,
    usedFallback: config.useFallbackModel,
    recoveryTimeMs: Date.now() - startTime,
  };
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify error to determine the best recovery strategy.
 */
export function classifyError(error: string): RecoveryStrategy {
  const lower = error.toLowerCase();

  // Rate limiting → retry with backoff
  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429")) {
    return RecoveryStrategy.RetryWithBackoff;
  }

  // Network issues → retry
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("econnreset")) {
    return RecoveryStrategy.RetryWithBackoff;
  }

  // Server errors → retry
  if (lower.includes("500") || lower.includes("502") || lower.includes("503") || lower.includes("internal server")) {
    return RecoveryStrategy.Retry;
  }

  // Context/token limit → partial
  if (lower.includes("context length") || lower.includes("token limit") || lower.includes("max tokens")) {
    return RecoveryStrategy.Partial;
  }

  // Authentication → abort (user intervention needed)
  if (lower.includes("auth") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("401") || lower.includes("403")) {
    return RecoveryStrategy.Abort;
  }

  // Default: retry once, then abort
  return RecoveryStrategy.Retry;
}

/**
 * Create a recovery config appropriate for the given error.
 */
export function getRecoveryConfig(error: string): RecoveryConfig {
  const strategy = classifyError(error);
  return { ...DEFAULT_RECOVERY_CONFIGS[strategy] };
}
