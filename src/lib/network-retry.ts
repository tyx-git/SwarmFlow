/**
 * Network error retry utilities.
 *
 * Provides detection of transient network errors, exponential backoff
 * delay computation, and an abort-aware sleep helper.  Used by the
 * session turn loop to automatically retry LLM API calls that fail
 * due to network issues (ETIMEDOUT, ECONNRESET, 5xx, 429, etc.).
 */

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Maximum number of network-error retries per turn. */
export const MAX_NETWORK_RETRIES = 10;

/** Node.js / undici error codes that indicate a transient network issue. */
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

/** SDK wrapper class names that indicate a connection-level failure. */
const CONNECTION_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);

/** Message substrings (lowercase) that suggest a transient network failure. */
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
 * Determine whether `err` is a transient network error worth retrying.
 *
 * Handles three layers of errors:
 * 1. SDK-wrapped errors (Anthropic / OpenAI `APIConnectionError`)
 * 2. Raw Node.js errors with `.code` (ETIMEDOUT, ECONNRESET, 鈥?
 * 3. HTTP status codes (429 rate-limit, 5xx server errors)
 *
 * Uses duck-typing (constructor name) instead of `instanceof` to avoid
 * importing both SDK packages.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const e = err as Record<string, unknown>;

  // -- Explicit exclusions --
  if (e["name"] === "AbortError") return false;

  const status = e["status"];
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false; // 400, 401, 403, 404, 422 etc. are not retryable
  }

  // -- SDK connection errors (duck-typed) --
  const ctorName = (err as any)?.constructor?.name as string | undefined;
  if (ctorName && CONNECTION_ERROR_NAMES.has(ctorName)) return true;

  // -- Node.js / undici error codes --
  const code = e["code"];
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;

  // -- HTTP status-based retries --
  if (typeof status === "number") {
    if (status === 408 || status === 429) return true;
    if (status >= 500) return true;
  }

  // -- Message-based fallback --
  const msg = String(err).toLowerCase();
  for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }

  // Also check .cause for wrapped errors
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
 * Compute the backoff delay for a given retry attempt (0-indexed).
 *
 * Uses exponential backoff (base 1 s, factor 2) capped at 30 s,
 * with 0鈥?5 % random jitter to avoid thundering-herd effects.
 *
 * Progression: ~1 s, ~2 s, ~4 s, ~8 s, ~16 s, ~30 s, ~30 s, 鈥? */
export function computeRetryDelay(attempt: number): number {
  const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30_000);
  const jitter = baseDelay * 0.25 * Math.random();
  return Math.round(baseDelay + jitter);
}

// ------------------------------------------------------------------
// retrySleep
// ------------------------------------------------------------------

/**
 * Sleep for `ms` milliseconds, aborting immediately if `signal` fires.
 *
 * If the signal is already aborted when called, rejects immediately.
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
