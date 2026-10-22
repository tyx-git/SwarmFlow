/**
 * read_file 的 tail_lines 行为测试。
 *
 * 期望值来自 20 行夹具本身；头部范围与正文逐行精确断言，
 * 不再只检查子串是否出现。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeTool } from "../../src/tools/dispatch.js";
import type { ToolResult } from "../../src/providers/response.js";

function text(result: string | ToolResult): string {
  return typeof result === "string" ? result : result.content;
}

function lines(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `line-${String(from + index).padStart(2, "0")}`);
}

function parseHeader(content: string): { start: number; end: number; total: number } {
  const match = /^\[Lines (\d+)-(\d+) of (\d+) \| mtime_ms=\d+ \| size_bytes=\d+\]/.exec(content);
  if (!match) throw new Error(`Missing header in: ${content.slice(0, 100)}`);
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function body(content: string): string[] {
  const firstNewline = content.indexOf("\n");
  const afterHeader = firstNewline < 0 ? "" : content.slice(firstNewline + 1);
  return afterHeader === "" ? [] : afterHeader.split("\n");
}

describe("read_file tail_lines", () => {
  let root: string;
  let file: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-tail-"));
    file = join(root, "log.txt");
    // 20 行 + 末尾换行，模拟真实日志
    writeFileSync(file, `${lines(1, 20).join("\n")}\n`, "utf8");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (args: Record<string, unknown>): Promise<string> =>
    text(await executeTool("read_file", { path: file, ...args }, { projectRoot: root } as never));

  it("returns the exact last N lines and keeps the total in the header", async () => {
    const out = await run({ tail_lines: 3 });
    expect(parseHeader(out)).toEqual({ start: 18, end: 20, total: 20 });
    expect(body(out)).toEqual(lines(18, 20));
  });

  it("does not count the trailing newline as an extra line", async () => {
    const out = await run({ tail_lines: 1 });
    expect(parseHeader(out)).toEqual({ start: 20, end: 20, total: 20 });
    expect(body(out)).toEqual(["line-20"]);
  });

  it("lets tail_lines override start_line and end_line", async () => {
    const out = await run({ tail_lines: 2, start_line: 1, end_line: 5 });
    expect(parseHeader(out)).toEqual({ start: 19, end: 20, total: 20 });
    expect(body(out)).toEqual(lines(19, 20));
  });

  it("returns the whole file when N exceeds the line count", async () => {
    const out = await run({ tail_lines: 500 });
    expect(parseHeader(out)).toEqual({ start: 1, end: 20, total: 20 });
    expect(body(out)).toEqual(lines(1, 20));
  });
});
