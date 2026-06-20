/**
 * swarm 任务失败的恢复策略。
 *
 * 提供重试逻辑（带退避）、回退 agent、
 * 部分结果处理和终止协调。
 *
 * @packageDocumentation
 */

import { RecoveryStrategy } from "./types.js";
import type { RecoveryConfig, TaskResult } from "./types.js";

/** 每个策略的默认恢复配置。 */
export const DEFAULT_RECOVERY_CONFIGS: Record<RecoveryStrategy, RecoveryConfig> = {
  [RecoveryStrategy.Retry]: { strategy: RecoveryStrategy.Retry, maxRetries: 3, useFallbackModel: false },
  [RecoveryStrategy.RetryWithBackoff]: { strategy: RecoveryStrategy.RetryWithBackoff, maxRetries: 3, useFallbackModel: false },
  [RecoveryStrategy.Fallback]: { strategy: RecoveryStrategy.Fallback, maxRetries: 1, useFallbackModel: true },
  [RecoveryStrategy.Partial]: { strategy: RecoveryStrategy.Partial, maxRetries: 0, useFallbackModel: false },
  [RecoveryStrategy.Abort]: { strategy: RecoveryStrategy.Abort, maxRetries: 0, useFallbackModel: false },
};

/** 恢复尝试的结果。 */
export interface RecoveryOutcome {
  /** 恢复是否成功。 */
  recovered: boolean;
  /** 尝试的重试次数。 */
  retriesAttempted: number;
  /** 如果未恢复则为最终错误。 */
  finalError?: string;
  /** 是否使用了回退模型。 */
  usedFallback: boolean;
  /** 恢复花费的总时间（毫秒）。 */
  recoveryTimeMs: number;
}

/** 重新执行任务的回调类型。 */
export type RetryFn = () => Promise<TaskResult>;

/**
 * 使用指定策略尝试从任务失败中恢复。
 *
 * @param config - 恢复配置
 * @param retryFn - 重新执行任务的函数
 * @param initialError - 原始错误消息
 * @returns 恢复结果
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
        finalError: `使用了部分结果：${lastError}`,
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
 * 带线性延迟的重试。
 */
async function retryWithLinear(
  config: RecoveryConfig,
  retryFn: RetryFn,
  initialError: string,
  startTime: number,
): Promise<RecoveryOutcome> {
  let lastError = initialError;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    await sleep(1000 * attempt); // 1秒、2秒、3秒...

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
 * 带指数退避的重试：1秒、2秒、4秒、8秒...
 */
async function retryWithBackoff(
  config: RecoveryConfig,
  retryFn: RetryFn,
  initialError: string,
  startTime: number,
): Promise<RecoveryOutcome> {
  let lastError = initialError;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000); // 最多30秒
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
// 工具函数
// ------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 对错误进行分类以确定最佳恢复策略。
 */
export function classifyError(error: string): RecoveryStrategy {
  const lower = error.toLowerCase();

  // 速率限制 → 带退避重试
  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429")) {
    return RecoveryStrategy.RetryWithBackoff;
  }

  // 网络问题 → 重试
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("econnreset")) {
    return RecoveryStrategy.RetryWithBackoff;
  }

  // 服务器错误 → 重试
  if (lower.includes("500") || lower.includes("502") || lower.includes("503") || lower.includes("internal server")) {
    return RecoveryStrategy.Retry;
  }

  // Context/token 限制 → 部分
  if (lower.includes("context length") || lower.includes("token limit") || lower.includes("max tokens")) {
    return RecoveryStrategy.Partial;
  }

  // 认证 → 中止（需要用户干预）
  if (lower.includes("auth") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("401") || lower.includes("403")) {
    return RecoveryStrategy.Abort;
  }

  // 默认：重试一次，然后中止
  return RecoveryStrategy.Retry;
}

/**
 * 为给定错误创建合适的恢复配置。
 */
export function getRecoveryConfig(error: string): RecoveryConfig {
  const strategy = classifyError(error);
  return { ...DEFAULT_RECOVERY_CONFIGS[strategy] };
}