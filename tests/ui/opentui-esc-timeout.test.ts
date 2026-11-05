/**
 * 裸 ESC 必达：终端上报（焦点/鼠标/能力回复）抢进同一协议单元时，
 * 用户按下的 ESC 不得被并入上报序列而丢失。断言取自解析器真实产出的事件，
 * 期望值来自独立规格（裸 ESC 必达 + 已收完序列语义不变），不抄当前实现。
 */

import { describe, expect, it } from "vitest";

import {
  StdinParser,
  type Clock,
  type StdinEvent,
  type TimerHandle,
} from "../../external/opentui/forked/core/lib/stdin-parser.js";

const ESC = 0x1b;
const TIMEOUT_MS = 20;

/** 假时钟：不排真定时器，由测试自行推进窗口并显式触发超时冲刷。 */
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

/** 推入一个分片；分片之间可以推进时间以模拟事件循环被阻塞后的迟到字节。 */
function feed(parser: StdinParser, bytes: number[]): void {
  parser.push(Uint8Array.from(bytes));
}

/** 推进时间并触发超时冲刷，然后取出全部已产出事件。 */
function settle(parser: StdinParser, clock: FakeClock, advanceMs = TIMEOUT_MS): StdinEvent[] {
  clock.nowMs += advanceMs;
  parser.flushTimeout(clock.now());
  const events: StdinEvent[] = [];
  parser.drain((event) => events.push(event));
  return events;
}

function keyNames(events: StdinEvent[]): string[] {
  return events.filter((event) => event.type === "key").map((event) => event.key.name ?? "");
}

function firstKey(events: StdinEvent[]): StdinEvent | undefined {
  return events.find((event) => event.type === "key");
}

describe("裸 ESC 必达", () => {
  it("单独的 ESC 在窗口到期后产出 escape 键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC]);
    const events = settle(parser, clock);

    expect(keyNames(events)).toEqual(["escape"]);
  });

  it("ESC 之后迟到的焦点上报不得吞掉 escape 键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    // 用户按下 ESC；事件循环被子代理刷屏阻塞，窗口到期后焦点报告才到达。
    feed(parser, [ESC]);
    clock.nowMs += TIMEOUT_MS + 5;
    feed(parser, [ESC, 0x5b, 0x49]); // ESC [ I = FocusIn 上报
    const events = settle(parser, clock);

    expect(keyNames(events)).toContain("escape");
  });

  it("ESC 之后迟到的鼠标上报不得吞掉 escape 键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC]);
    clock.nowMs += TIMEOUT_MS + 5;
    feed(parser, [ESC, 0x5b, 0x3c, 0x30, 0x3b, 0x31, 0x30, 0x3b, 0x31, 0x30, 0x4d]); // ESC [ < 0;10;10M
    const events = settle(parser, clock);

    expect(keyNames(events)).toContain("escape");
  });

  it("被截断成 ESC 加左方括号的单元不得整段丢弃", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, 0x5b]);
    const events = settle(parser, clock);

    expect(keyNames(events)).toContain("escape");
  });

  it("未收完的 CSI 被新的 ESC 打断时，此前的 ESC 仍是按键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, 0x5b]);
    feed(parser, [ESC, 0x5b, 0x49]);
    const events = settle(parser, clock);

    expect(keyNames(events)).toContain("escape");
  });
});

describe("已收完序列语义不变", () => {
  it("原子方向键仍是一个 up 键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, 0x5b, 0x41]);
    const events = settle(parser, clock);

    expect(keyNames(events)).toEqual(["up"]);
  });

  it("原子 Alt+方向键仍合并为一个带 meta 的 up 键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC]);
    feed(parser, [ESC, 0x5b, 0x41]);
    const events = settle(parser, clock);

    // 合并单元必须仍是一个键，且不得多出 escape 键——否则 Alt+Up 会散架。
    expect(events).toHaveLength(1);
    expect(firstKey(events)?.type).toBe("key");
    expect(keyNames(events)).toEqual(["up"]);
  });

  it("原子 Alt+ESC 仍是一个带 meta 的 escape 键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, ESC]);
    const events = settle(parser, clock);

    expect(events).toHaveLength(1);
    expect(keyNames(events)).toEqual(["escape"]);
  });

  it("原子 Alt+字母键不拆成两个键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, 0x78]);
    const events = settle(parser, clock);

    expect(events).toHaveLength(1);
    expect(keyNames(events)).toEqual(["x"]);
  });

  it("原子 SS3 方向键仍是一个 up 键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, 0x4f, 0x41]);
    const events = settle(parser, clock);

    expect(keyNames(events)).toEqual(["up"]);
  });

  it("原子 SGR 鼠标上报仍是一个 mouse 事件", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, 0x5b, 0x3c, 0x30, 0x3b, 0x31, 0x30, 0x3b, 0x31, 0x30, 0x4d]);
    const events = settle(parser, clock);

    expect(events.filter((event) => event.type === "mouse")).toHaveLength(1);
    expect(keyNames(events)).not.toContain("escape");
  });

  it("已进入参数阶段的截断 CSI 不被当作按键", () => {
    const clock = new FakeClock();
    const parser = makeParser(clock);
    feed(parser, [ESC, 0x5b, 0x31, 0x32]); // ESC [ 12 —— 参数未收完
    const events = settle(parser, clock);

    // 这类单元没有确定终点，只能继续按回复处理，不能凭空产出 escape 键。
    expect(keyNames(events)).not.toContain("escape");
  });
});
