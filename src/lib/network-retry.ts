/**
 * 网络错误重试工具。
 *
 * 提供瞬态网络/上游错误检测、指数退避延迟计算，以及可感知 abort 的等待助手。
 * 被会话回合循环用于在 LLM API 调用失败时自动重试。
 *
 * 设计要点（都是踩过的坑）：
 * 1. **不能只看最外层的 status 就下结论。** 中转/网关经常把上游故障包在
 *    4xx 里（外层 400，body 说 upstream 503）。所以要把整棵错误树（自身 +
 *    error/cause + message 文本）里的状态码全部收集起来，只要有一个可重试
 *    就重试。
 * 2. **消息匹配必须读 err.message，不能用 String(err)。**
 *    `String({message:"..."})` 得到的是 "[object Object]"，纯对象错误
 *    （很多中转直接抛对象）会被完全漏掉。
 * 3. **不能因为看到 4xx 就放弃。** 只有在"没有任何可重试证据"时才停摆。
 */

// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------

/** 每个回合的最大网络错误重试次数。 */
export const MAX_NETWORK_RETRIES = 5;

/** 退避基数：第一次重试等待 5 秒，之后每次翻倍。 */
export const RETRY_BASE_DELAY_MS = 5_000;

/**
 * "回合未完成"（空响应 / 输出被 max_tokens 截断）的最大重掷次数。
 *
 * 与网络故障分开计数：上游是响应了的，只是产出不可用。这类故障靠退避等待
 * 解决不了，靠重新采样（temperature>0 时输出不同）才可能解决，所以次数少、
 * 等待短，避免把 5 次网络预算和 80 秒等待烧在一次毫无意义的停顿上。
 */
export const MAX_INCOMPLETE_TURN_RETRIES = 2;

/** 未完成回合重掷的退避基数：0.5 秒起，每次翻倍。 */
const INCOMPLETE_RETRY_BASE_DELAY_MS = 500;

/**
 * TurnIncompleteError 携带的标记码。
 *
 * 放进 RETRYABLE_CODES 是为了让这类错误复用现成的退避环：tool-loop 给错误
 * 对象打上 `.code`，isRetryableNetworkError 通过 `.code` 路径认出它，无需
 * 让 lib 反向依赖 agents/providers（那会造成循环引用）。
 */
export const TURN_INCOMPLETE_ERROR_CODE = "TURN_INCOMPLETE";

/** 单次退避上限（防止抖动把等待时间放大到不可接受）。 */
const RETRY_MAX_DELAY_MS = 120_000;

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
    // "upstream returned 503" / "relay: 502" / "provider responded 500"
    /\b(?:upstream|relay|provider|gateway|backend|origin)\b[^0-9\n]{0,40}?\b([1-5]\d{2})\b/i,
];

/**
 * 上游限流 / 过载 / 连接问题的常见措辞（小写匹配）。
 * 这些只认"明确的瞬态故障"措辞，避免把永久性错误也拖去重试。
 */
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
    "upstream error",
    "disable connect reset",
    "connection reset",
    "connection error",
    "connection failure",
    "timed out",
    "timeout",
    "socket hang up",
    "premature close",
    "econnreset",
    "etimedout",
    "econnrefused",
    "enotfound",
    "eai_again",
    // 流式响应被截断 / SSE 解析失败：绝大多数是瞬态的
    "unterminated string",
    "unexpected end of json",
    "unexpected end of input",
    "unexpected token",
    "invalid json",
    "malformed json",
    "json parse",
    "failed to parse",
    "stream ended",
    "stream closed",
    "incomplete chunked",
];

/** 表明瞬态网络问题的 Node.js / undici 错误码。 */
const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
  TURN_INCOMPLETE_ERROR_CODE,
]);

/** 表明连接级失败的 SDK 包装类名。 */
const CONNECTION_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
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
// 错误信息收集
// ------------------------------------------------------------------

const MAX_TRAVERSE_DEPTH = 6;

/**
 * 递归收集错误对象里所有"可能带状态码"的来源。
 *
 * 重要：不要在看到第一个 status 字段时就返回。外层 400 里裹着上游 503
 * 是常见形态，早退会把上游的真实状态码漏掉。
 */
function collectStatusCandidates(err: unknown, depth = 0, out: number[] = []): number[] {
  if (depth > MAX_TRAVERSE_DEPTH || err === null || typeof err !== "object") return out;
  const record = err as Record<string, unknown>;

  for (const key of ["status", "statusCode", "httpStatus", "code"]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 100 && raw < 600) {
      out.push(raw);
    } else if (typeof raw === "string" && /^[1-5]\d{2}$/.test(raw)) {
      out.push(Number(raw));
    }
  }

  const message = record["message"];
  if (typeof message === "string") {
    for (const pattern of STATUS_TEXT_PATTERNS) {
      const match = pattern.exec(message);
      if (match?.[1]) out.push(Number(match[1]));
    }
  }

  for (const key of ["error", "cause", "originalError", "response", "data", "body"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      collectStatusCandidates(nested, depth + 1, out);
    }
  }
  return out;
}

/**
 * 递归收集错误对象里所有可用于关键词匹配的文本。
 *
 * 必须读 `.message`：`String({message:"..."})` 得到 "[object Object]"，
 * 纯对象错误会被完全漏掉（真实踩过：中转抛裸对象时重试从不触发）。
 */
function collectMessages(err: unknown, depth = 0, out: string[] = []): string[] {
  if (err === null || err === undefined) return out;
  if (depth > MAX_TRAVERSE_DEPTH) return out;
  if (typeof err === "string") {
    out.push(err);
    return out;
  }
  if (typeof err !== "object") return out;

  const record = err as Record<string, unknown>;
  const message = record["message"];
  if (typeof message === "string") out.push(message);
  const detail = record["detail"];
  if (typeof detail === "string") out.push(detail);
  const name = record["name"];
  if (typeof name === "string") out.push(name);
  const code = record["code"];
  if (typeof code === "string") out.push(code);

  for (const key of ["error", "cause", "originalError", "response", "data", "body", "text"]) {
    const nested = record[key];
    if (nested && (typeof nested === "string" || typeof nested === "object")) {
      collectMessages(nested, depth + 1, out);
    }
  }
  return out;
}

/** HTTP 状态码 → 是否值得重试（408 超时、429 限流、5xx 服务端错误）。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

const ALL_RETRYABLE_MESSAGE_PATTERNS: readonly string[] = [
  ...RETRYABLE_MESSAGE_PATTERNS,
  ...RETRYABLE_MESSAGE_PATTERNS_EXTRA,
];

const NON_RETRYABLE_QUOTA_ERROR_PATTERNS: readonly RegExp[] = [
  /\binsufficient[_\s-]+(?:quota|credits?|balance)\b/i,
  /\b(?:quota|credits?|balance)\b.{0,40}\b(?:exceeded|exhausted|depleted|insufficient|too low)\b/i,
  /\b(?:exceeded|exhausted|depleted|ran out of)\b.{0,40}\b(?:current )?(?:quota|credits?|balance)\b/i,
  /\b(?:billing|payment) (?:hard )?limit (?:has been )?(?:reached|exceeded)\b/i,
];

// ------------------------------------------------------------------
// isRetryableNetworkError
// ------------------------------------------------------------------

/**
 * 判断 `err` 是否为值得重试的瞬态网络/上游错误。
 *
 * 处理四类错误：
 * 1. HTTP 状态码（429 限流、5xx 服务端错误、408 超时）—— 包括藏在 message
 *    文本和 error/cause 里的
 * 2. SDK 包装的连接错误（Anthropic / OpenAI 的 `APIConnectionError`）
 * 3. 带有 `.code` 的原生 Node.js 错误（ETIMEDOUT、ECONNRESET、⋯）
 * 4. 命中瞬态措辞的错误信息（含嵌套 error/cause，纯对象错误也算）
 *
 * 判定是"或"关系：只要有任何一条可重试证据就重试；只有在完全找不到证据时
 * 才停摆。这样中转把上游 5xx 包在 4xx 里也能正确重试。
 *
 * 使用鸭子类型（构造函数名）而非 `instanceof`，避免引入两个 SDK 包。
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // -- 显式排除：用户主动中止 --
  if ((err as Record<string, unknown>)["name"] === "AbortError") return false;

  // 429 既可能是短暂限流，也可能是账户额度耗尽。后者不会因等待而恢复，
  // 必须优先于状态码判定，否则 TUI 会在退避重试期间一直显示 Working。
  const errorText = collectMessages(err).join("\n");
  if (NON_RETRYABLE_QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) {
    return false;
  }

  const statuses = collectStatusCandidates(err);

  // 明确带 HTTP 状态码：只要有一个可重试就重试。
  if (statuses.some(isRetryableStatus)) return true;

  // -- SDK 连接错误（鸭子类型） --
  const ctorName = (err as any)?.constructor?.name as string | undefined;
  if (ctorName && CONNECTION_ERROR_NAMES.has(ctorName)) return true;

  // -- Node.js / undici 错误码（含 .cause / .error 内嵌） --
  const codes = collectMessages(err).filter((text) => text === text.toUpperCase());
  if (codes.some((code) => RETRYABLE_CODES.has(code))) return true;

  // 直接读 .code 字段（上面 collectMessages 只收字符串，这里补一条路径）
  const collectCodes = (value: unknown, depth = 0): string[] => {
    const found: string[] = [];
    if (depth > MAX_TRAVERSE_DEPTH || !value || typeof value !== "object") return found;
    const record = value as Record<string, unknown>;
    if (typeof record["code"] === "string") found.push(record["code"] as string);
    for (const key of ["error", "cause", "originalError", "response"]) {
      const nested = record[key];
      if (nested && typeof nested === "object") found.push(...collectCodes(nested, depth + 1));
    }
    return found;
  };
  if (collectCodes(err).some((code) => RETRYABLE_CODES.has(code))) return true;

  // -- 基于消息的兜底判断（覆盖所有嵌套层与纯对象错误） --
  const haystack = errorText.toLowerCase();
  for (const pattern of ALL_RETRYABLE_MESSAGE_PATTERNS) {
    if (haystack.includes(pattern)) return true;
  }

  return false;
}

// ------------------------------------------------------------------
// 回合未完成 / 凭据失效判定
// ------------------------------------------------------------------

/**
 * "上游响应了、但这一轮没跑完"。
 *
 * 空响应、max_tokens 截断、断流都归到这里。带上 `.code` 是为了让
 * `isRetryableNetworkError` 认出它，从而复用 tool-loop 现成的退避环
 * （次数与延迟由 `MAX_INCOMPLETE_TURN_RETRIES` 单独控制）。
 */
export class TurnIncompleteError extends Error {
  override readonly name = "TurnIncompleteError";
  readonly code = TURN_INCOMPLETE_ERROR_CODE;

  constructor(message: string) {
    super(message);
  }
}

/**
 * 是否为"上游响应了但这一轮没跑完"的错误（空响应、max_tokens 截断）。
 * 这类错误走本文件的退避环，但用独立的次数预算。
 */
export function isTurnIncompleteError(err: unknown): boolean {
  return Boolean(err)
    && typeof err === "object"
    && (err as Record<string, unknown>)["code"] === TURN_INCOMPLETE_ERROR_CODE;
}

/**
 * 是否为 401/403 —— 凭据缺失或已过期。
 *
 * 它**不**是可重试的网络故障（`isRetryableNetworkError` 排除 4xx），只有
 * "刷新凭据后重发一次"这一种处置方式，所以判定单独成函数。
 *
 * 用 `collectStatusCandidates` 而非只看 `err.status`：很多中转/SDK 只把
 * 状态码写进 message 文本，或裹在 `error`/`cause` 里。
 */
export function isUnauthorizedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as Record<string, unknown>)["name"] === "AbortError") return false;
  return collectStatusCandidates(err).some((status) => status === 401 || status === 403);
}

// ------------------------------------------------------------------
// computeRetryDelay
// ------------------------------------------------------------------

/**
 * 计算给定重试尝试（从 0 开始）的退避延迟。
 *
 * 5 秒基数、每次翻倍，上限 120 秒，再叠加 0–25% 的随机抖动以避免雷暴效应。
 *
 * 进度：约 5 秒、约 10 秒、约 20 秒、约 40 秒、约 80 秒。
 */
export function computeRetryDelay(attempt: number): number {
  const baseDelay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt)), RETRY_MAX_DELAY_MS);
  const jitter = baseDelay * 0.25 * Math.random();
  return Math.round(baseDelay + jitter);
}

/**
 * 未完成回合重掷的退避：0.5 秒、1 秒，叠加 0–25% 抖动。
 *
 * 刻意比网络退避短：上游没有故障，只是这一轮的产出被截断或为空。等待改变
 * 不了结果，重掷才可能；停顿久了只会让用户以为卡死。
 */
export function computeIncompleteRetryDelay(attempt: number): number {
  const baseDelay = INCOMPLETE_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt));
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
