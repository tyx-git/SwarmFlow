import { describe, expect, it } from "vitest";
import {
  computeRetryDelay,
  isRetryableNetworkError,
  MAX_NETWORK_RETRIES,
} from "../src/lib/network-retry.js";

// ------------------------------------------------------------------
// 上游报错后的重试判定：状态码常常只出现在错误文本里
// ------------------------------------------------------------------

describe("isRetryableNetworkError — status embedded in message text", () => {
  it("retries when a provider formats the status as `HTTP 503 ...`", () => {
    expect(isRetryableNetworkError(new Error("HTTP 503 for https://api.example.com/v1"))).toBe(true);
  });

  it("retries when a provider formats the status as `(502)`", () => {
    expect(isRetryableNetworkError(new Error("Gemini generateContent failed (502): upstream"))).toBe(true);
  });

  it("retries when the status is spelled `status 429`", () => {
    expect(isRetryableNetworkError(new Error("status 429 from relay"))).toBe(true);
  });

  it("retries when the status precedes a standard reason phrase", () => {
    expect(isRetryableNetworkError(new Error("500 Internal Server Error"))).toBe(true);
    expect(isRetryableNetworkError(new Error("504 Gateway Time-out"))).toBe(true);
  });

  it("does NOT retry a 4xx status embedded in text", () => {
    expect(isRetryableNetworkError(new Error("HTTP 400 for https://api.example.com/v1"))).toBe(false);
    expect(isRetryableNetworkError(new Error("HTTP 401 Unauthorized"))).toBe(false);
    expect(isRetryableNetworkError(new Error("HTTP 403 Forbidden"))).toBe(false);
    expect(isRetryableNetworkError(new Error("HTTP 404 Not Found"))).toBe(false);
  });

  it("still honours an explicit non-retryable status field", () => {
    expect(isRetryableNetworkError({ status: 400, message: "bad request" })).toBe(false);
    expect(isRetryableNetworkError({ status: 401 })).toBe(false);
    expect(isRetryableNetworkError({ status: 503 })).toBe(true);
    expect(isRetryableNetworkError({ status: 429 })).toBe(true);
  });

  it("reads a status from a nested error object", () => {
    expect(isRetryableNetworkError({ error: { status: 502 } })).toBe(true);
    expect(isRetryableNetworkError({ error: { status: 422 } })).toBe(false);
  });
});

describe("isRetryableNetworkError — transient upstream wording", () => {
  for (const message of [
    "upstream rate limit reached",
    "model overloaded",
    "Too Many Requests",
    "service temporarily unavailable",
    "connection reset by peer",
    "the operation timed out",
    "gateway timeout",
    "bad gateway",
    "internal server error",
  ]) {
    it(`retries on ${JSON.stringify(message)}`, () => {
      expect(isRetryableNetworkError(new Error(message))).toBe(true);
    });
  }

  it("does not retry a plain unknown error", () => {
    expect(isRetryableNetworkError(new Error("something odd happened"))).toBe(false);
  });

  it("never retries a user abort", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isRetryableNetworkError(err)).toBe(false);
  });
});

// ------------------------------------------------------------------
// 回归保护：中转把上游故障包在 4xx 里、以及纯对象错误
//
// 曾经的三个 bug：
//  1. extractHttpStatus 看到第一个 status 字段就 return，导致外层 400 里裹着
//     的上游 503 永远看不到 —— 错误被判定为不可重试，一次报错就停摆。
//  2. 消息匹配用 String(err)，纯对象错误得到的是 "[object Object]"，
//     中转直接抛对象时重试从不触发。
//  3. SDK 内置重试在流式路径上完全不生效，把退避策略交给它等于没有策略。
// ------------------------------------------------------------------

describe("isRetryableNetworkError - upstream failure wrapped in a 4xx", () => {
  it("retries when the outer status is 400 but the message carries an upstream 5xx", () => {
    expect(
      isRetryableNetworkError({
        status: 400,
        message: "400 Bad Request: upstream returned 503 Service Unavailable",
      }),
    ).toBe(true);
  });

  it("retries when a nested cause carries the upstream status", () => {
    expect(
      isRetryableNetworkError({ status: 400, message: "bad request", cause: { status: 503 } }),
    ).toBe(true);
  });

  it("retries when the response body mentions a 502 gateway", () => {
    expect(
      isRetryableNetworkError({
        status: 400,
        response: { body: "upstream 502 bad gateway" },
      }),
    ).toBe(true);
  });

  it("retries on a non-standard overload status like 529", () => {
    expect(isRetryableNetworkError({ status: 529, message: "site overloaded" })).toBe(true);
  });
});

describe("isRetryableNetworkError - plain object errors", () => {
  it("reads .message instead of String(err) (which is [object Object])", () => {
    expect(
      isRetryableNetworkError({ message: "upstream connect error or disconnect/reset" }),
    ).toBe(true);
    expect(isRetryableNetworkError({ message: "model overloaded" })).toBe(true);
    expect(isRetryableNetworkError({ message: "something odd happened" })).toBe(false);
  });

  it("reads a status from a plain object", () => {
    expect(isRetryableNetworkError({ status: 503 })).toBe(true);
    expect(isRetryableNetworkError({ status: 400 })).toBe(false);
  });
});

describe("isRetryableNetworkError - stream truncation", () => {
  for (const message of [
    "Unterminated string in JSON at position 42",
    "Unexpected end of JSON input",
    "Unexpected token < in JSON at position 0",
  ]) {
    it(`retries on ${JSON.stringify(message)}`, () => {
      expect(isRetryableNetworkError(new Error(message))).toBe(true);
    });
  }
});

describe("isRetryableNetworkError - genuine client errors stay fatal", () => {
  for (const message of [
    "HTTP 400 for https://api.example.com/v1",
    "HTTP 401 Unauthorized",
    "HTTP 403 Forbidden",
    "HTTP 404 Not Found",
  ]) {
    it(`does not retry ${JSON.stringify(message)}`, () => {
      expect(isRetryableNetworkError(new Error(message))).toBe(false);
    });
  }

  it("does not retry a 400 with a non-transient message", () => {
    expect(isRetryableNetworkError({ status: 400, message: "invalid request body" })).toBe(false);
  });

  it("never retries a user abort", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isRetryableNetworkError(err)).toBe(false);
  });
});

describe("computeRetryDelay - 5s/10s/20s/40s/80s doubling", () => {
  it("retries exactly five times", () => {
    expect(MAX_NETWORK_RETRIES).toBe(5);
  });

  it("doubles from a 5s base with at most 25% jitter", () => {
    for (const [attempt, expectedSec] of [[0, 5], [1, 10], [2, 20], [3, 40], [4, 80]] as const) {
      const delaySec = computeRetryDelay(attempt) / 1000;
      expect(delaySec).toBeGreaterThanOrEqual(expectedSec * 0.75);
      expect(delaySec).toBeLessThanOrEqual(expectedSec * 1.25);
    }
  });
});
