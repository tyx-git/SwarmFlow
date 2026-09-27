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

/**
 * 从错误信息里提取 HTTP 状态码。
 *
 * 很多 provider / 中转只把状态码写进文本（`Gemini generateContent failed
 * (502)`、`HTTP 503 for ...`、`status 429`），并不在 `err.status` 上暴露，
 * 因此这里用保守的匹配把状态码捞出来——只认出明确以 3 位数字出现的形态，
 * 避免把版本号之类误判成状态码。
 */
const STATUS_TEXT_PATTERNS: readonly RegExp[] = [
    /\bHTTP[\s/:-]*([1-5]\d{2})\b/i,
    /\bstatus(?:\s+code)?[\s:=]*([1-5]\d{2})\b/i,
    /\(([1-5]\d{2})\)/,
    /\b([1-5]\d{2})\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-out|Gateway Timeout|Too Many Requests|Unauthorized|Forbidden|Not Found|Bad Request)\b/i,
];

/** 上游限流/过载时的常见措辞（小写匹配）。 */
const RETRYABLE_MESSAGE_PATTERNS_EXTRA: readonly string[] = [
    "rate limit",
    "rate_limit",
    "ratelimit",
    "overloaded",
    "too many requests",
    "temporarily unavailable",
    "temporarily down",
    "service unavailable",
    "internal server error",
    "bad gateway",
    "gateway time-out",
    "gateway timeout",
    "upstream connect error",
    "disable connect reset",
    "connection reset",
    "connection error",
    "connection failure",
    "ssl",
    "tls",
    "timed out",
    "timeout",
];

/** 从任意错误形态里尽力取出 HTTP 状态码。 */
function extractHttpStatus(err: unknown): number | undefined {
    const seen: string[] = [];
    const collect = (value: unknown, depth: number): void => {
        if (depth > 4 || value === null || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        for (const key of ["status", "statusCode", "code"]) {
            const raw = record[key];
            if (typeof raw === "number" && Number.isInteger(raw)) return void seen.push(String(raw));
            if (typeof raw === "string" && /^[1-5]\d{2}$/.test(raw)) seen.push(raw);
        }
        const message = record["message"];
        if (typeof message === "string") {
            for (const pattern of STATUS_TEXT_PATTERNS) {
                const match = pattern.exec(message);
                if (match?.[1]) seen.push(match[1]);
            }
        }
        collect(record["error"], depth + 1);
        collect(record["cause"], depth + 1);
    };
    collect(err, 0);
    for (const candidate of seen) {
        const status = Number(candidate);
        if (Number.isFinite(status) && status >= 100 && status < 600) return status;
    }
    return undefined;
}

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
const ALL_RETRYABLE_MESSAGE_PATTERNS: readonly string[] = [
  ...RETRYABLE_MESSAGE_PATTERNS,
  ...RETRYABLE_MESSAGE_PATTERNS_EXTRA,
];

/** HTTP 状态码 → 是否值得重试（408 超时、429 限流、5xx 服务端错误）。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const e = err as Record<string, unknown>;

  // -- 显式排除：用户主动中止 --
  if (e["name"] === "AbortError") return false;

  const status = extractHttpStatus(err);

  // 明确带 HTTP 状态码：按状态码决定（4xx 参数/鉴权类不重试）。
  if (status !== undefined) return isRetryableStatus(status);

  // -- SDK 连接错误（鸭子类型） --
  const ctorName = (err as any)?.constructor?.name as string | undefined;
  if (ctorName && CONNECTION_ERROR_NAMES.has(ctorName)) return true;

  // -- Node.js / undici 错误码（含 .cause / .error 内嵌） --
  const code = e["code"];
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;

  // -- 基于消息的兜底判断 --
  const msg = String(err).toLowerCase();
  for (const pattern of ALL_RETRYABLE_MESSAGE_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }

  // 还要检查 .cause / .error（包装错误的情况）
  for (const nestedKey of ["cause", "error"] as const) {
    const nested = e[nestedKey];
    if (nested && typeof nested === "object") {
      const nestedCode = (nested as Record<string, unknown>)["code"];
      if (typeof nestedCode === "string" && RETRYABLE_CODES.has(nestedCode)) return true;
    }
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
