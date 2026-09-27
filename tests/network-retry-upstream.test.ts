import { describe, expect, it } from "vitest";
import {
  isRetryableNetworkError,
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
