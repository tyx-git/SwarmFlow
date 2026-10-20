/**
 * read_file 的 1000 行熔断策略。
 *
 * 期望值来自 1500 行夹具：
 * - 单次最多返回 1000 行（普通读取与 tail_lines 都适用）；
 * - 普通读取被截断时，末尾给出下一步的 start_line；
 * - tail_lines 被截断时只保留最新 1000 行，并提示改用更小的 tail_lines；
 * - 恰好 1000 行（含末尾换行）不能误判为超过 1000 行。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeTool } from "../src/tools/basic.js";
import type { ToolResult } from "../src/providers/base.js";

function text(result: string | ToolResult): string {
  return typeof result === "string" ? result : result.content;
}

function numbered(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `line-${String(from + index).padStart(4, "0")}`);
}

function parseHeader(content: string): { start: number; end: number; total: number } {
  const match = /^\[Lines (\d+)-(\d+) of (\d+) \| mtime_ms=\d+ \| size_bytes=\d+\]/.exec(content);
  if (!match) throw new Error(`Missing header in: ${content.slice(0, 100)}`);
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function body(content: string): string[] {
  const firstNewline = content.indexOf("\n");
  const afterHeader = firstNewline < 0 ? "" : content.slice(firstNewline + 1);
  const notice = afterHeader.search(/\n\n<---/);
  const selected = notice >= 0 ? afterHeader.slice(0, notice) : afterHeader;
  return selected === "" ? [] : selected.split("\n");
}

const NORMAL_FUSE =
  "<--- This file has more than 1000 lines. " +
  "Continue with `start_line=1001` if you need the following lines. --->";
const TAIL_FUSE =
  "<--- This file has more than 1000 lines; showing the latest 1000 lines. " +
  "Request a smaller `tail_lines`, or omit it and page with `start_line` if needed. --->";

describe("read_file 1000-line fuse", () => {
  let root: string;
  let bigFile: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-read-fuse-"));
    bigFile = join(root, "big.log");
    writeFileSync(bigFile, `${numbered(1, 1500).join("\n")}\n`, "utf8");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (args: Record<string, unknown> = {}): Promise<string> =>
    text(await executeTool("read_file", { path: bigFile, ...args }, { projectRoot: root } as never));

  it("caps a default read at 1000 lines and points at the next start_line", async () => {
    const out = await run();
    expect(parseHeader(out)).toEqual({ start: 1, end: 1000, total: 1500 });
    expect(body(out)).toEqual(numbered(1, 1000));
    expect(out.endsWith(NORMAL_FUSE)).toBe(true);
  });

  it("allows explicit pagination past the fuse", async () => {
    const out = await run({ start_line: 1001 });
    expect(parseHeader(out)).toEqual({ start: 1001, end: 1500, total: 1500 });
    expect(body(out)).toEqual(numbered(1001, 1500));
    expect(out).not.toContain("<---");
  });

  it("caps an explicit window at 1000 lines", async () => {
    const out = await run({ start_line: 1, end_line: 1500 });
    expect(parseHeader(out)).toEqual({ start: 1, end: 1000, total: 1500 });
    expect(body(out)).toEqual(numbered(1, 1000));
    expect(out.endsWith(NORMAL_FUSE)).toBe(true);
  });

  it("keeps only the latest 1000 lines for an oversized tail window", async () => {
    const out = await run({ tail_lines: 1500 });
    expect(parseHeader(out)).toEqual({ start: 501, end: 1500, total: 1500 });
    expect(body(out)).toEqual(numbered(501, 1500));
    expect(out.endsWith(TAIL_FUSE)).toBe(true);
  });

  it("does not trip on a file of exactly 1000 lines with a trailing newline", async () => {
    const exact = join(root, "exact.log");
    const expected = Array.from(
      { length: 1000 },
      (_, index) => `exact-${String(index + 1).padStart(4, "0")}`,
    );
    writeFileSync(exact, `${expected.join("\n")}\n`, "utf8");

    const out = text(
      await executeTool("read_file", { path: exact }, { projectRoot: root } as never),
    );
    expect(parseHeader(out)).toEqual({ start: 1, end: 1000, total: 1000 });
    expect(body(out)).toEqual(expected);
    expect(out).not.toContain("<---");
  });
});
