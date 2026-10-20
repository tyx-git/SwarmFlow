/**
 * 流式行窗口 helper 的行为测试。
 *
 * 期望值来自独立规格：
 * - 夹具内容在测试里显式构造；
 * - 小文件用硬编码行数组，大文件用夹具公式推导目标区间；
 * - 不复制 selectLineWindow 的窗口算法。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LineWindowError,
  readLineWindowFromFile,
  readLineWindowFromText,
} from "../src/lib/line-window.js";

function numberedLines(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `line-${from + index}`);
}

async function expectWindowError(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LineWindowError);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`Expected rejection with: ${message}`);
}

describe("line window", () => {
  let root: string;
  let bigFile: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-line-window-"));
    bigFile = join(root, "big.txt");
    writeFileSync(bigFile, `${numberedLines(1, 5000).join("\n")}\n`, "utf8");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an explicit line range with exact boundaries and total count", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      startLine: 100,
      endLine: 120,
      maxLines: 1000,
    });
    expect(window).toEqual({
      totalLines: 5000,
      start: 100,
      end: 120,
      lines: numberedLines(100, 120),
      lineCapApplied: false,
      tailCapped: false,
    });
  });

  it("fuses an unbounded range at exactly maxLines", async () => {
    const window = await readLineWindowFromFile(bigFile, { maxLines: 1000 });
    expect(window).toEqual({
      totalLines: 5000,
      start: 1,
      end: 1000,
      lines: numberedLines(1, 1000),
      lineCapApplied: true,
      tailCapped: false,
    });
  });

  it("does not report a fuse at exactly maxLines", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      startLine: 1,
      endLine: 1000,
      maxLines: 1000,
    });
    expect(window).toEqual({
      totalLines: 5000,
      start: 1,
      end: 1000,
      lines: numberedLines(1, 1000),
      lineCapApplied: false,
      tailCapped: false,
    });
  });

  it("fuses a range that starts after line 1", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      startLine: 2,
      endLine: 1002,
      maxLines: 1000,
    });
    expect(window).toEqual({
      totalLines: 5000,
      start: 2,
      end: 1001,
      lines: numberedLines(2, 1001),
      lineCapApplied: true,
      tailCapped: false,
    });
  });

  it("clamps an explicit end beyond EOF without a fuse", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      startLine: 4501,
      endLine: 6000,
      maxLines: 1000,
    });
    expect(window).toEqual({
      totalLines: 5000,
      start: 4501,
      end: 5000,
      lines: numberedLines(4501, 5000),
      lineCapApplied: false,
      tailCapped: false,
    });
  });

  it("treats endLine -1 as EOF", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      startLine: 4998,
      endLine: -1,
      maxLines: 1000,
    });
    expect(window.lines).toEqual(numberedLines(4998, 5000));
    expect(window.end).toBe(5000);
  });

  it("returns the exact latest tail window", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      tailLines: 200,
      maxLines: 1000,
    });
    expect(window).toEqual({
      totalLines: 5000,
      start: 4801,
      end: 5000,
      lines: numberedLines(4801, 5000),
      lineCapApplied: false,
      tailCapped: false,
    });
  });

  it("caps an oversized tail at maxLines and flags it", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      tailLines: 2000,
      maxLines: 1000,
    });
    expect(window).toEqual({
      totalLines: 5000,
      start: 4001,
      end: 5000,
      lines: numberedLines(4001, 5000),
      lineCapApplied: false,
      tailCapped: true,
    });
  });

  it("lets tailLines override startLine/endLine", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      startLine: 1,
      endLine: 10,
      tailLines: 3,
      maxLines: 1000,
    });
    expect(window.lines).toEqual(numberedLines(4998, 5000));
    expect(window.start).toBe(4998);
    expect(window.end).toBe(5000);
  });

  it("handles maxLines=1 for both range and tail", async () => {
    const range = await readLineWindowFromFile(bigFile, { maxLines: 1 });
    expect(range.lines).toEqual(["line-1"]);
    expect(range.lineCapApplied).toBe(true);

    const tail = await readLineWindowFromFile(bigFile, { tailLines: 5, maxLines: 1 });
    expect(tail.lines).toEqual(["line-5000"]);
    expect(tail.tailCapped).toBe(true);
  });

  it("keeps trailing-newline semantics and real blank lines", async () => {
    const cases: Array<{ name: string; content: string; expected: string[] }> = [
      { name: "one-trailing-newline.txt", content: "a\nb\n", expected: ["a", "b"] },
      { name: "no-trailing-newline.txt", content: "a\nb", expected: ["a", "b"] },
      { name: "one-blank-tail.txt", content: "a\n\n", expected: ["a", ""] },
      { name: "two-blank-tails.txt", content: "a\n\n\n", expected: ["a", "", ""] },
      { name: "only-newline.txt", content: "\n", expected: [""] },
      { name: "empty.txt", content: "", expected: [] },
    ];

    for (const item of cases) {
      const file = join(root, item.name);
      writeFileSync(file, item.content, "utf8");
      const window = await readLineWindowFromFile(file, { maxLines: 1000 });
      expect(window.lines, item.name).toEqual(item.expected);
      expect(window.totalLines, item.name).toBe(Math.max(1, item.expected.length));
    }
  });

  it("normalizes CRLF line endings", async () => {
    const file = join(root, "crlf.txt");
    writeFileSync(file, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    const window = await readLineWindowFromFile(file, { maxLines: 1000 });
    expect(window.totalLines).toBe(3);
    expect(window.lines).toEqual(["alpha", "beta", "gamma"]);
  });

  it("includes the final line when the file has no trailing newline", async () => {
    const file = join(root, "no-final-newline.txt");
    writeFileSync(file, "alpha\nbeta\ngamma", "utf8");
    const window = await readLineWindowFromFile(file, { tailLines: 2, maxLines: 1000 });
    expect(window.totalLines).toBe(3);
    expect(window.start).toBe(2);
    expect(window.end).toBe(3);
    expect(window.lines).toEqual(["beta", "gamma"]);
  });

  it("returns the exact single last line", async () => {
    const window = await readLineWindowFromFile(bigFile, {
      startLine: 5000,
      endLine: 5000,
      maxLines: 1000,
    });
    expect(window).toEqual({
      totalLines: 5000,
      start: 5000,
      end: 5000,
      lines: ["line-5000"],
      lineCapApplied: false,
      tailCapped: false,
    });
  });

  it("rejects invalid ranges with exact messages", async () => {
    await expectWindowError(
      readLineWindowFromFile(bigFile, { startLine: 5001, maxLines: 1000 }),
      "start_line 5001 exceeds total lines (5000).",
    );
    await expectWindowError(
      readLineWindowFromFile(bigFile, { startLine: 10, endLine: 5, maxLines: 1000 }),
      "end_line (5) < start_line (10).",
    );
    await expectWindowError(
      readLineWindowFromFile(bigFile, { startLine: 0, maxLines: 1000 }),
      "start_line must be >= 1, got 0.",
    );
  });

  it("selects the same explicit window from in-memory text", async () => {
    const text = `${numberedLines(1, 5000).join("\n")}\n`;
    const window = await readLineWindowFromText(text, {
      startLine: 4801,
      endLine: 5000,
      maxLines: 1000,
    });
    // 期望值直接来自夹具，而不是拿另一条实现路径做唯一对照。
    expect(window).toEqual({
      totalLines: 5000,
      start: 4801,
      end: 5000,
      lines: numberedLines(4801, 5000),
      lineCapApplied: false,
      tailCapped: false,
    });
  });
});
