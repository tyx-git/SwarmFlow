/**
 * R-5/D7：第 4 步索引化的复杂度与确定性读取计数。
 *
 * 计时只做粗上界（CI 抖动）；确定性计数才是防回退的主断言。
 */

import { describe, expect, it } from "vitest";

import { validateAndRepairLog } from "../../src/config/log-repair.js";
import {
  createAssistantText,
  createReasoning,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

/**
 * 10% action + 10% 需要重戳的 reasoning + 80% 填充：
 * 旧实现会为每条 reasoning 扫完整份日志（无 early-break 路径）。
 */
function makeEntries(total: number): LogEntry[] {
  const actionCount = Math.floor(total / 10);
  const reasoningCount = Math.floor(total / 10);
  const entries: LogEntry[] = [];
  for (let index = 0; index < actionCount; index += 1) {
    entries.push(createAssistantText(`a-${index}`, 1, 1, "a", "a"));
  }
  for (let index = 0; index < reasoningCount; index += 1) {
    entries.push(createReasoning(`r-${index}`, 9, 1, "r", "r"));
  }
  let filler = 0;
  while (entries.length < total) {
    entries.push(createUserMessage(`u-${filler}`, 2, "m", "m", "ctx"));
    filler += 1;
  }
  return entries;
}

function timeMinOfThree(entries: LogEntry[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const input = structuredClone(entries);
    const started = performance.now();
    validateAndRepairLog(input);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("validateAndRepairLog 复杂度", () => {
  it(
    "条目 ×4 的时间增长受线性上界约束",
    () => {
      const t20 = timeMinOfThree(makeEntries(20_000));
      const t40 = timeMinOfThree(makeEntries(40_000));
      const t80 = timeMinOfThree(makeEntries(80_000));
      // ×2 期望 ≈2×、×4 期望 ≈4×。旧实现 16.96×；新实现 ×4 实测 2.4–4.8×
      // （小基数抖动）。计时只做粗上界，确定性读取计数才是主断言。
      expect(t40 / Math.max(t20, 0.01)).toBeLessThan(3.5);
      expect(t80 / Math.max(t20, 0.01)).toBeLessThan(8);
    },
    180_000,
  );

  it("确定性计数：第 4 步不再触发内层全表扫描", () => {
    const entries = makeEntries(2_000);
    let reads = 0;
    const countedProps = new Set(["type", "roundIndex", "turnIndex", "discarded"]);
    const tracked = entries.map((entry) => new Proxy(entry, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && countedProps.has(prop)) reads += 1;
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value, receiver) {
        return Reflect.set(target, prop, value, receiver);
      },
    }));

    validateAndRepairLog(tracked);

    // 新实现约 10–15×N；旧实现为 R×N 量级（本夹具约 200×N）。
    expect(reads).toBeLessThanOrEqual(40 * entries.length);
  });
});
