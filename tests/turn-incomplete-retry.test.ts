/**
 * "上游响应了、但这一轮没跑完"的处置：截断 / 断流 / 空响应重掷，
 * 以及 401 后刷新凭据重发一次。
 */

import { describe, expect, it } from "vitest";

import {
  MAX_INCOMPLETE_TURN_RETRIES,
  TURN_INCOMPLETE_ERROR_CODE,
  TurnIncompleteError,
  computeIncompleteRetryDelay,
  isRetryableNetworkError,
  isTurnIncompleteError,
  isUnauthorizedError,
} from "../src/lib/network-retry.js";
import {
  BaseProvider,
  ProviderResponse,
  Usage,
  normalizeStopReason,
  type Message,
  type StopReason,
  type ToolDef,
} from "../src/providers/base.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

describe("normalizeStopReason", () => {
  it("maps each provider vocabulary onto the shared semantics", () => {
    const cases: Array<[string, StopReason]> = [
      ["end_turn", "end_turn"],
      ["stop", "end_turn"],
      ["stop_sequence", "end_turn"],
      ["completed", "end_turn"],
      ["tool_use", "tool_calls"],
      ["tool_calls", "tool_calls"],
      ["max_tokens", "max_tokens"],
      ["max_output_tokens", "max_tokens"],
      ["length", "max_tokens"],
      ["incomplete", "max_tokens"],
      ["content_filter", "refusal"],
      ["refusal", "refusal"],
      ["safety", "refusal"],
      ["pause_turn", "paused"],
      ["MODEL_GONE_WRONG", "unknown"],
    ];
    for (const [raw, expected] of cases) {
      expect(normalizeStopReason(raw)).toBe(expected);
    }
  });

  it("keeps 'absent' distinct from 'not finished'", () => {
    // null 是"这个 provider 不暴露终止信息"，不能推断成失败。
    expect(normalizeStopReason(null)).toBeNull();
    expect(normalizeStopReason(undefined)).toBeNull();
    expect(normalizeStopReason("")).toBeNull();
  });
});

describe("TurnIncompleteError", () => {
  it("is recognised by the shared retry classifier", () => {
    const err = new TurnIncompleteError("Provider returned an empty response; the turn did not complete.");
    expect(err.code).toBe(TURN_INCOMPLETE_ERROR_CODE);
    expect(isTurnIncompleteError(err)).toBe(true);
    // 复用现成退避环的前提：isRetryableNetworkError 也认它。
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it("backs off much shorter than the network ladder", () => {
    expect(computeIncompleteRetryDelay(0)).toBeLessThan(1_000);
    expect(computeIncompleteRetryDelay(1)).toBeLessThan(2_000);
  });
});

describe("tool-loop incomplete-turn retries", () => {
  it("rethrows a max_tokens truncation until the budget runs out", async () => {
    const rounds = Array.from(
      { length: MAX_INCOMPLETE_TURN_RETRIES + 1 },
      () => ({ text: "写到一半", stopReason: "max_tokens" as const }),
    );
    const h = makeScriptedSession({ rounds });
    try {
      await expect(h.session.turn("继续")).rejects.toThrow(/max_tokens/);
      expect(h.provider.callCount).toBe(MAX_INCOMPLETE_TURN_RETRIES + 1);
      expect(h.session.lastTurnEndStatus).toBe("error");
    } finally {
      h.dispose();
    }
  });

  it("accepts a truncation-free retry instead of failing the turn", async () => {
    const h = makeScriptedSession({
      rounds: [
        { text: "半句话", stopReason: "max_tokens" },
        { text: "重掷后说完了", stopReason: "end_turn" },
      ],
    });
    try {
      await h.session.turn("继续");
      expect(h.provider.callCount).toBe(2);
      expect(h.session.lastTurnEndStatus).toBe("completed");
    } finally {
      h.dispose();
    }
  });

  it("treats a stream without a terminal status as an incomplete turn", async () => {
    const rounds = Array.from(
      { length: MAX_INCOMPLETE_TURN_RETRIES + 1 },
      () => ({ text: "有文本但没有终止事件", stopReason: "incomplete_stream" as const }),
    );
    const h = makeScriptedSession({ rounds });
    try {
      await expect(h.session.turn("hello")).rejects.toThrow(/terminal status/);
      expect(h.provider.callCount).toBe(MAX_INCOMPLETE_TURN_RETRIES + 1);
    } finally {
      h.dispose();
    }
  });

  it("does not infer failure from a provider that exposes no stop reason", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "普通回答", stopReason: null }] });
    try {
      await h.session.turn("hello");
      expect(h.provider.callCount).toBe(1);
      expect(h.session.lastTurnEndStatus).toBe("completed");
    } finally {
      h.dispose();
    }
  });
});

/** 只实现 sendMessage 的最小 provider，用来验证 401 → 刷新 → 重发一次。 */
class FlakyAuthProbeProvider extends BaseProvider {
  calls = 0;
  refreshes = 0;
  /** 前 failFirst 次调用抛 401，之后成功。 */
  constructor(private readonly failFirst: number, private readonly refreshOk: boolean) {
    super();
  }

  protected override async _reauthenticate(): Promise<boolean> {
    this.refreshes++;
    return this.refreshOk;
  }

  async sendMessage(): Promise<ProviderResponse> {
    this.calls++;
    if (this.calls <= this.failFirst) {
      const err = new Error("401 Unauthorized: token expired") as Error & { status: number };
      err.status = 401;
      throw err;
    }
    return new ProviderResponse({ text: `ok#${this.calls}`, usage: new Usage(1, 1) });
  }
}

describe("401 handling in asyncSendMessage", () => {
  it("refreshes the credential and replays the request once", async () => {
    const p = new FlakyAuthProbeProvider(1, true);
    const resp = await p.asyncSendMessage([] as Message[], [] as ToolDef[]);
    expect(resp.text).toBe("ok#2");
    expect(p.calls).toBe(2);
    expect(p.refreshes).toBe(1);
  });

  it("surfaces the original error when refreshing fails", async () => {
    const p = new FlakyAuthProbeProvider(5, false);
    await expect(p.asyncSendMessage([] as Message[], [] as ToolDef[])).rejects.toThrow("401");
    expect(p.calls).toBe(1);
    expect(p.refreshes).toBe(1);
  });

  it("does not replay a second 401 (no refresh loop)", async () => {
    const p = new FlakyAuthProbeProvider(2, true);
    await expect(p.asyncSendMessage([] as Message[], [] as ToolDef[])).rejects.toThrow("401");
    expect(p.calls).toBe(2);
    expect(p.refreshes).toBe(1);
  });

  it("honours an already-aborted signal instead of refreshing", async () => {
    const p = new FlakyAuthProbeProvider(1, true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      p.asyncSendMessage([] as Message[], [] as ToolDef[], { signal: controller.signal }),
    ).rejects.toThrow("401");
    expect(p.refreshes).toBe(0);
  });

  it("detects credential failures wrapped in nested status fields", () => {
    expect(isUnauthorizedError({ status: 401 })).toBe(true);
    expect(isUnauthorizedError({ message: "HTTP 403 for request" })).toBe(true);
    expect(isUnauthorizedError({ status: 500 })).toBe(false);
    expect(isUnauthorizedError(new DOMException("cancelled", "AbortError"))).toBe(false);
  });
});
