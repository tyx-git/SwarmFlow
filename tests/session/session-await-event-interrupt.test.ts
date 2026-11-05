/**
 * await_event 的退出判据顺序：用户中断优先于"事件到达"。
 *
 * 子代理持续投递消息不得掩盖用户的中断——否则 signal 已 aborted 时本调用
 * 仍以 exitReason="event" 正常返回，回合被当成还在跑，UI 的 Working 不回落。
 */

import { describe, expect, it } from "vitest";

import { makeScriptedSession, waitFor, type SessionHarness } from "../helpers/session-harness.js";

/**
 * 伪造「有可等对象」并清空 inbox：本用例只关心三条退出判据的先后，
 * 不依赖真实子代理/后台 shell 的存活判定。
 */
function setupBlockingWaitables(h: SessionHarness): void {
  const internals = h.internals;
  internals._hasWaitables = () => true;
  internals._inbox.length = 0;
}

function pushPeerMessage(h: SessionHarness): void {
  h.internals._inbox.push({
    type: "peer_message",
    sender: "worker-1",
    content: "done",
    timestamp: Date.now(),
    wake: true,
  });
}

describe("await_event 退出判据顺序", () => {
  it("中断与事件同时到期时以 AbortError 退出，不当成事件正常返回", async () => {
    const h = makeScriptedSession();
    try {
      setupBlockingWaitables(h);
      const internals = h.internals;
      const controller = new AbortController();
      const turnState = internals._installCurrentTurnSignal(controller.signal);

      const running = internals._execAwaitEvent();
      // 复现"睡到一半"的时序：先有子代理投递消息，再中断。
      await waitFor(() => internals._agentState === "waiting");
      pushPeerMessage(h);
      controller.abort();

      let error: unknown;
      await running.catch((err: unknown) => { error = err; });
      expect((error as { name?: string })?.name).toBe("AbortError");

      internals._restoreCurrentTurnSignal(turnState);
    } finally {
      h.dispose();
    }
  });

  it("没有中断时事件到期照常返回，不被误判成中断", async () => {
    const h = makeScriptedSession();
    try {
      setupBlockingWaitables(h);
      const internals = h.internals;
      const controller = new AbortController();
      const turnState = internals._installCurrentTurnSignal(controller.signal);

      const running = internals._execAwaitEvent();
      await waitFor(() => internals._agentState === "waiting");
      pushPeerMessage(h);

      const result = await running;
      expect(String(result.content)).toContain("new message arrived");
      expect(internals._agentState).toBe("working");

      internals._restoreCurrentTurnSignal(turnState);
    } finally {
      h.dispose();
    }
  });

  it("进入阻塞前就已中断时立刻抛 AbortError（入口预检不受顺序调整影响）", async () => {
    const h = makeScriptedSession();
    try {
      setupBlockingWaitables(h);
      const internals = h.internals;
      const controller = new AbortController();
      const turnState = internals._installCurrentTurnSignal(controller.signal);
      pushPeerMessage(h);
      controller.abort();

      let error: unknown;
      await internals._execAwaitEvent().catch((err: unknown) => { error = err; });
      expect((error as { name?: string })?.name).toBe("AbortError");

      internals._restoreCurrentTurnSignal(turnState);
    } finally {
      h.dispose();
    }
  });
});
