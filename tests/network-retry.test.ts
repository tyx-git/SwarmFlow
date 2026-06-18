import { describe, it, expect, mock, spyOn } from "bun:test";
import {
  isRetryableNetworkError,
  computeRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
} from "../src/network-retry.js";

// ------------------------------------------------------------------
// isRetryableNetworkError
// ------------------------------------------------------------------

describe("isRetryableNetworkError", () => {
  // -- Falsy / non-object inputs --
  it("returns false for null", () => {
    expect(isRetryableNetworkError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRetryableNetworkError(undefined)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isRetryableNetworkError("some error")).toBe(false);
  });

  // -- AbortError exclusion --
  it("returns false for AbortError", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(isRetryableNetworkError(err)).toBe(false);
  });

  // -- Non-retryable HTTP status codes --
  it("returns false for status 400 (bad request)", () => {
    expect(isRetryableNetworkError({ status: 400, message: "Bad Request" })).toBe(false);
  });

  it("returns false for status 401 (unauthorized)", () => {
    expect(isRetryableNetworkError({ status: 401, message: "Unauthorized" })).toBe(false);
  });

  it("returns false for status 403 (forbidden)", () => {
    expect(isRetryableNetworkError({ status: 403, message: "Forbidden" })).toBe(false);
  });

  it("returns false for status 404 (not found)", () => {
    expect(isRetryableNetworkError({ status: 404, message: "Not Found" })).toBe(false);
  });

  it("returns false for status 422 (unprocessable)", () => {
    expect(isRetryableNetworkError({ status: 422, message: "Unprocessable Entity" })).toBe(false);
  });

  // -- SDK APIConnectionError (duck-typed) --
  it("returns true for APIConnectionError (duck-typed constructor name)", () => {
    class APIConnectionError extends Error {
      status = undefined;
      cause: Error;
      constructor(msg: string) {
        super(msg);
        this.cause = new Error("ECONNRESET");
      }
    }
    expect(isRetryableNetworkError(new APIConnectionError("connection failed"))).toBe(true);
  });

  it("returns true for APIConnectionTimeoutError (duck-typed)", () => {
    class APIConnectionTimeoutError extends Error {
      status = undefined;
      constructor() {
        super("Request timed out.");
      }
    }
    expect(isRetryableNetworkError(new APIConnectionTimeoutError())).toBe(true);
  });

  // -- Node.js error codes --
  it("returns true for ETIMEDOUT", () => {
    const err = Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns true for EAI_AGAIN", () => {
    const err = Object.assign(new Error("temporary failure"), { code: "EAI_AGAIN" });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns true for EPIPE", () => {
    const err = Object.assign(new Error("write after end"), { code: "EPIPE" });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("returns true for UND_ERR_CONNECT_TIMEOUT", () => {
    const err = Object.assign(new Error("Connect Timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  // -- HTTP status-based retries --
  it("returns true for status 408 (request timeout)", () => {
    expect(isRetryableNetworkError({ status: 408, message: "Request Timeout" })).toBe(true);
  });

  it("returns true for status 429 (rate limit)", () => {
    expect(isRetryableNetworkError({ status: 429, message: "Too Many Requests" })).toBe(true);
  });

  it("returns true for status 500 (internal server error)", () => {
    expect(isRetryableNetworkError({ status: 500, message: "Internal Server Error" })).toBe(true);
  });

  it("returns true for status 502 (bad gateway)", () => {
    expect(isRetryableNetworkError({ status: 502, message: "Bad Gateway" })).toBe(true);
  });

  it("returns true for status 503 (service unavailable)", () => {
    expect(isRetryableNetworkError({ status: 503, message: "Service Unavailable" })).toBe(true);
  });

  // -- Message-based fallback --
  it("returns true for 'fetch failed' message", () => {
    expect(isRetryableNetworkError(new Error("TypeError: fetch failed"))).toBe(true);
  });

  it("returns true for 'socket hang up' message", () => {
    expect(isRetryableNetworkError(new Error("socket hang up"))).toBe(true);
  });

  it("returns true for message containing 'ETIMEDOUT'", () => {
    expect(isRetryableNetworkError(new Error("read ETIMEDOUT"))).toBe(true);
  });

  it("returns true for message containing 'ECONNRESET'", () => {
    expect(isRetryableNetworkError(new Error("ECONNRESET"))).toBe(true);
  });

  // -- Wrapped cause --
  it("returns true when .cause has a retryable code", () => {
    const cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const err = { message: "something failed", cause };
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  // -- Non-retryable errors --
  it("returns false for a generic Error", () => {
    expect(isRetryableNetworkError(new Error("something went wrong"))).toBe(false);
  });

  it("returns false for context overflow error", () => {
    expect(isRetryableNetworkError(new Error("context_length_exceeded"))).toBe(false);
  });
});

// ------------------------------------------------------------------
// computeRetryDelay
// ------------------------------------------------------------------

describe("computeRetryDelay", () => {
  it("returns ~1000ms for attempt 0", () => {
    const delay = computeRetryDelay(0);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it("returns ~2000ms for attempt 1", () => {
    const delay = computeRetryDelay(1);
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(2500);
  });

  it("returns ~4000ms for attempt 2", () => {
    const delay = computeRetryDelay(2);
    expect(delay).toBeGreaterThanOrEqual(4000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("caps at ~30000ms for high attempts", () => {
    const delay = computeRetryDelay(9);
    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(37_500);
  });

  it("caps at ~30000ms for very high attempts", () => {
    const delay = computeRetryDelay(20);
    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(37_500);
  });

  it("returns an integer", () => {
    const delay = computeRetryDelay(3);
    expect(Number.isInteger(delay)).toBe(true);
  });
});

// ------------------------------------------------------------------
// retrySleep
// ------------------------------------------------------------------

describe("retrySleep", () => {
  it("resolves after the specified delay", async () => {
    const t0 = performance.now();
    await retrySleep(50);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow some timer jitter
  });

  it("rejects immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(retrySleep(1000, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when signal fires during sleep", async () => {
    const ac = new AbortController();
    const p = retrySleep(5000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ------------------------------------------------------------------
// MAX_NETWORK_RETRIES
// ------------------------------------------------------------------

describe("MAX_NETWORK_RETRIES", () => {
  it("is 10", () => {
    expect(MAX_NETWORK_RETRIES).toBe(10);
  });
});
