/**
 * 网络错误重试工具。
 *
 * 提供瞬态网络错误检测、指数退避延迟计算，以及可感知 abort 的 sleep 助手。
 * 被会话回合循环用于在网络问题（ETIMEDOUT、ECONNRESET、5xx、429 等）
 * 导致 LLM API 调用失败时自动重试。
 */

// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------

/** 每个回合的最大网络错误重试次数。 */
export const MAX_NETWORK_RETRIES = 10;

/** 表明瞬态网络问题的 Node.js / undici 错误码。 */
const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/** 表明连接级失败的 SDK 包装类名。 */
const CONNECTION_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);

/** 提示瞬态网络失败的消息子串（小写）。 */
const RETRYABLE_MESSAGE_PATTERNS = [
  "etimedout",
  "econnreset",
  "econnrefused",
  "socket hang up",
  "fetch failed",
  "network",
  "premature close",
  "uND_ERR_SOCKET".toLowerCase(),
];

// ------------------------------------------------------------------
// isRetryableNetworkError
// ------------------------------------------------------------------

/**
 * 判断 `err` 是否为值得重试的瞬态网络错误。
 *
 * 处理三类错误：
 * 1. SDK 包装的错误（Anthropic / OpenAI 的 `APIConnectionError`）
 * 2. 带有 `.code` 的原生 Node.js 错误（ETIMEDOUT、ECONNRESET、⋯）
 * 3. HTTP 状态码（429 限流、5xx 服务器错误）
 *
 * 使用鸭子类型（构造函数名）而非 `instanceof`，避免引入两个 SDK 包。
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const e = err as Record<string, unknown>;

  // -- 显式排除 --
  if (e["name"] === "AbortError") return false;

  const status = e["status"];
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false; // 400、401、403、404、422 等不可重试
  }

  // -- SDK 连接错误（鸭子类型） --
  const ctorName = (err as any)?.constructor?.name as string | undefined;
  if (ctorName && CONNECTION_ERROR_NAMES.has(ctorName)) return true;

  // -- Node.js / undici 错误码 --
  const code = e["code"];
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;

  // -- 基于 HTTP 状态码的重试 --
  if (typeof status === "number") {
    if (status === 408 || status === 429) return true;
    if (status >= 500) return true;
  }

  // -- 基于消息的兜底判断 --
  const msg = String(err).toLowerCase();
  for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }

  // 还要检查 .cause（包装错误的情况）
  const cause = e["cause"];
  if (cause && typeof cause === "object") {
    const causeCode = (cause as Record<string, unknown>)["code"];
    if (typeof causeCode === "string" && RETRYABLE_CODES.has(causeCode)) return true;
  }

  return false;
}

// ------------------------------------------------------------------
// computeRetryDelay
// ------------------------------------------------------------------

/**
 * 计算给定重试尝试（从 0 开始）的退避延迟。
 *
 * 使用指数退避（基数 1 秒、倍数 2）并以 30 秒为上限，
 * 再叠加 0–25% 的随机抖动以避免雷暴效应。
 *
 * 进度：约 1 秒、约 2 秒、约 4 秒、约 8 秒、约 16 秒、约 30 秒、约 30 秒、⋯
 */
export function computeRetryDelay(attempt: number): number {
  const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30_000);
  const jitter = baseDelay * 0.25 * Math.random();
  return Math.round(baseDelay + jitter);
}

// ------------------------------------------------------------------
// retrySleep
// ------------------------------------------------------------------

/**
 * 睡眠 `ms` 毫秒，如果 `signal` 触发则立即中止。
 *
 * 若调用时 signal 已经处于已中止状态，会立即拒绝。
 */
export function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
