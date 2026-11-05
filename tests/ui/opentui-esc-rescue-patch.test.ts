/**
 * 裸 ESC 补齐的运行期补丁：对成品包解析器结构做守卫，并确认补齐只产出
 * 一份 Escape（不与源码镜像的修正重复触发）。
 *
 * 补丁包住的是 node_modules/@opentui/core 里的解析器实例；这里用同源镜像的
 * StdinParser 作为宿主，成员名与成品包一致（成品包未被压缩）。
 */

import { describe, expect, it } from "vitest";

import { StdinParser, type Clock, type StdinEvent, type TimerHandle } from "../../external/opentui/forked/core/lib/stdin-parser.js";
import { installStdinEscapePatch } from "../../external/opentui/forked/patch-stdin-esc.js";

const ESC = 0x1b;
const TIMEOUT_MS = 20;

class FakeClock implements Clock {
  nowMs = 0;
  now(): number {
    return this.nowMs;
  }
  setTimeout(_fn: () => void, _delayMs: number): TimerHandle {
    return 0 as unknown as TimerHandle;
  }
  clearTimeout(_handle: TimerHandle): void {}
  setInterval(_fn: () => void, _delayMs: number): TimerHandle {
    return 0 as unknown as TimerHandle;
  }
  clearInterval(_handle: TimerHandle): void {}
}

function makeParser(clock: FakeClock): StdinParser {
  return new StdinParser({ armTimeouts: false, timeoutMs: TIMEOUT_MS, clock });
}

function drain(parser: StdinParser, clock: FakeClock, advanceMs = TIMEOUT_MS): StdinEvent[] {
  clock.nowMs += advanceMs;
  parser.flushTimeout(clock.now());
  const events: StdinEvent[] = [];
  parser.drain((event) => events.push(event));
  return events;
}

function keyNames(events: StdinEvent[]): string[] {
  return events.filter((event) => event.type === "key").map((event) => event.key.name ?? "");
}

describe("运行期补齐的守卫", () => {
  it("解析器成员齐全时挂上，并且重复挂上不二次包装", () => {
    const parser = makeParser(new FakeClock());
    const renderer = { stdinParser: parser as unknown };

    expect(installStdinEscapePatch(renderer)).toEqual({ patched: true });
    expect(installStdinEscapePatch(renderer)).toEqual({ patched: true });

    // 二次包装会让同一枚 Esc 被冲刷两次；这里必须只有一份 Escape。
    const clock = new FakeClock();
    const wrapped = makeParser(clock);
    installStdinEscapePatch({ stdinParser: wrapped as unknown });
    installStdinEscapePatch({ stdinParser: wrapped as unknown });
    wrapped.push(Uint8Array.from([ESC]));
    clock.nowMs += TIMEOUT_MS + 5;
    wrapped.push(Uint8Array.from([ESC, 0x5b, 0x49]));
    expect(keyNames(drain(wrapped, clock))).toEqual(["escape"]);
  });

  it("成品包结构变化时逐项报告挂不上的原因（不允许静默失效）", () => {
    expect(installStdinEscapePatch({})).toEqual({ patched: false, reason: "stdin_parser_missing" });
    expect(installStdinEscapePatch({ stdinParser: { events: [], timeoutMs: 20 } }))
      .toEqual({ patched: false, reason: "parser_api_missing" });
    expect(installStdinEscapePatch({ stdinParser: { push: () => {}, read: () => null, timeoutMs: 20 } }))
      .toEqual({ patched: false, reason: "event_queue_missing" });
    expect(installStdinEscapePatch({ stdinParser: { push: () => {}, read: () => null, events: [] } }))
      .toEqual({ patched: false, reason: "timeout_member_missing" });
  });
});

describe("补齐后的行为", () => {
  it("迟到的焦点报告吞不掉 Esc", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    installStdinEscapePatch({ stdinParser: parser as unknown });

    parser.push(Uint8Array.from([ESC]));
    clock.nowMs += TIMEOUT_MS + 5;
    parser.push(Uint8Array.from([ESC, 0x5b, 0x49]));

    expect(keyNames(drain(parser, clock))).toEqual(["escape"]);
  });

  it("迟到的鼠标上报吞不掉 Esc", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    installStdinEscapePatch({ stdinParser: parser as unknown });

    parser.push(Uint8Array.from([ESC]));
    clock.nowMs += TIMEOUT_MS + 5;
    parser.push(Uint8Array.from([ESC, 0x5b, 0x3c, 0x30, 0x3b, 0x31, 0x30, 0x3b, 0x31, 0x30, 0x4d]));

    expect(keyNames(drain(parser, clock))).toContain("escape");
  });

  it("窗口内到达的 Alt+方向键仍是一个 up 键（合并语义不变）", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    installStdinEscapePatch({ stdinParser: parser as unknown });

    parser.push(Uint8Array.from([ESC]));
    parser.push(Uint8Array.from([ESC, 0x5b, 0x41]));

    expect(keyNames(drain(parser, clock))).toEqual(["up"]);
  });

  it("原子方向键与原子 Alt+ESC 不受补丁影响", () => {
    const upClock = new FakeClock();
    const up = makeParser(upClock);
    installStdinEscapePatch({ stdinParser: up as unknown });
    up.push(Uint8Array.from([ESC, 0x5b, 0x41]));
    expect(keyNames(drain(up, upClock, 0))).toEqual(["up"]);

    const altEscClock = new FakeClock();
    const altEsc = makeParser(altEscClock);
    installStdinEscapePatch({ stdinParser: altEsc as unknown });
    altEsc.push(Uint8Array.from([ESC, ESC]));
    const events = drain(altEsc, altEscClock);
    // 合并成一枚 Alt+ESC：只有一份按键，不得被拆成两枚 Escape。
    expect(events.filter((event) => event.type === "key")).toHaveLength(1);
    expect(keyNames(events)).toEqual(["escape"]);
  });
});
