/**
 * read_file 窗口语义的规格测试。
 *
 * 期望值来自测试夹具本身：
 * - 行内容由测试显式生成；
 * - 头部、熔断标记、warning 文案按产品规格逐字断言；
 * - 字符预算测试用“已用 ≤ 160k 且再加入下一行必超”的不变量，
 *   不复制实现里的截断循环。
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

function numbered(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `line-${String(from + index).padStart(4, "0")}`);
}

interface Header {
  start: number;
  end: number;
  total: number;
}

function parseHeader(content: string): Header {
  const match = /^\[Lines (\d+)-(\d+) of (\d+) \| mtime_ms=\d+ \| size_bytes=\d+\]/.exec(content);
  if (!match) throw new Error(`Missing read_file header in: ${content.slice(0, 120)}`);
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

/** Header 之后、任何 [!] 截断提示之前的内容行。 */
function bodyLines(content: string): string[] {
  const firstNewline = content.indexOf("\n");
  if (firstNewline < 0) return [];
  const afterHeader = content.slice(firstNewline + 1);
  const notice = afterHeader.search(/\n\n\[!\]/);
  const body = notice >= 0 ? afterHeader.slice(0, notice) : afterHeader;
  return body === "" ? [] : body.split("\n");
}

describe("read_file window semantics", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-read-file-window-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (file: string, args: Record<string, unknown> = {}): Promise<string> =>
    text(await executeTool(
      "read_file",
      { path: file, ...args },
      { projectRoot: root } as never,
    ));

  it("caps a 2001-line default read at 2000 and emits the exact fuse", async () => {
    const file = join(root, "2001.txt");
    writeFileSync(file, `${numbered(1, 2001).join("\n")}\n`, "utf8");

    const content = await run(file);
    expect(parseHeader(content)).toEqual({ start: 1, end: 2000, total: 2001 });
    expect(bodyLines(content)).toEqual(numbered(1, 2000));
    expect(content.endsWith(
      "[!] READ TRUNCATED — showing lines 1-2000 of 2001 (1 line not shown).\n" +
      "[!] Continue with start_line=2001.",
    )).toBe(true);
  });

  it("reads the explicit line beyond the fuse without inheriting the marker", async () => {
    const file = join(root, "2001-explicit.txt");
    writeFileSync(file, `${numbered(1, 2001).join("\n")}\n`, "utf8");

    const content = await run(file, { start_line: 2001 });
    expect(parseHeader(content)).toEqual({ start: 2001, end: 2001, total: 2001 });
    expect(bodyLines(content)).toEqual(["line-2001"]);
    expect(content).not.toContain("[!]");
  });

  it("returns exactly the latest 2000 lines for an oversized tail window", async () => {
    const file = join(root, "2500.txt");
    writeFileSync(file, `${numbered(1, 2500).join("\n")}\n`, "utf8");

    const content = await run(file, { tail_lines: 2500 });
    expect(parseHeader(content)).toEqual({ start: 501, end: 2500, total: 2500 });
    expect(bodyLines(content)).toEqual(numbered(501, 2500));
    expect(content.endsWith(
      "[!] READ TRUNCATED — showing the latest 2000 of 2500 lines.\n" +
      "[!] Re-request with a smaller tail_lines, or page with start_line.",
    )).toBe(true);
  });

  it("honours a smaller tail window without a fuse", async () => {
    const file = join(root, "1500-tail-200.txt");
    writeFileSync(file, `${numbered(1, 1500).join("\n")}\n`, "utf8");

    const content = await run(file, { tail_lines: 200 });
    expect(parseHeader(content)).toEqual({ start: 1301, end: 1500, total: 1500 });
    expect(bodyLines(content)).toEqual(numbered(1301, 1500));
    expect(content).not.toContain("[!]");
  });

  it("lets tail_lines override an explicit start/end range", async () => {
    const file = join(root, "1500-tail-override.txt");
    writeFileSync(file, `${numbered(1, 1500).join("\n")}\n`, "utf8");

    const content = await run(file, { start_line: 1, end_line: 10, tail_lines: 3 });
    expect(parseHeader(content)).toEqual({ start: 1498, end: 1500, total: 1500 });
    expect(bodyLines(content)).toEqual(numbered(1498, 1500));
  });

  it("does not trip the fuse on exactly 2000 lines with a trailing newline", async () => {
    const file = join(root, "exact-2000.txt");
    writeFileSync(file, `${numbered(1, 2000).join("\n")}\n`, "utf8");

    const content = await run(file);
    expect(parseHeader(content)).toEqual({ start: 1, end: 2000, total: 2000 });
    expect(bodyLines(content)).toEqual(numbered(1, 2000));
    expect(content).not.toContain("[!]");
  });

  it("normalizes CRLF and preserves the total line count", async () => {
    const file = join(root, "crlf.txt");
    writeFileSync(file, "alpha\r\nbeta\r\ngamma\r\n", "utf8");

    const content = await run(file);
    expect(parseHeader(content)).toEqual({ start: 1, end: 3, total: 3 });
    expect(bodyLines(content)).toEqual(["alpha", "beta", "gamma"]);
    expect(content).not.toContain("\r");
  });

  it("keeps empty-file semantics", async () => {
    const file = join(root, "empty.txt");
    writeFileSync(file, "", "utf8");

    const content = await run(file);
    expect(parseHeader(content)).toEqual({ start: 1, end: 1, total: 1 });
    expect(bodyLines(content)).toEqual([]);
    expect(content).not.toContain("<---");
  });

  it("counts files with and without a trailing newline identically", async () => {
    const withNewline = join(root, "with-newline.txt");
    const withoutNewline = join(root, "without-newline.txt");
    writeFileSync(withNewline, "a\nb\nc\n", "utf8");
    writeFileSync(withoutNewline, "a\nb\nc", "utf8");

    const first = await run(withNewline);
    const second = await run(withoutNewline);
    expect(parseHeader(first)).toEqual({ start: 1, end: 3, total: 3 });
    expect(parseHeader(second)).toEqual({ start: 1, end: 3, total: 3 });
    expect(bodyLines(first)).toEqual(["a", "b", "c"]);
    expect(bodyLines(second)).toEqual(["a", "b", "c"]);
  });

  it("rejects invalid ranges with exact errors", async () => {
    const file = join(root, "1500-errors.txt");
    writeFileSync(file, `${numbered(1, 1500).join("\n")}\n`, "utf8");

    expect(await run(file, { start_line: 1501 }))
      .toBe("ERROR: start_line 1501 exceeds total lines (1500).");
    expect(await run(file, { start_line: 10, end_line: 5 }))
      .toBe("ERROR: end_line (5) < start_line (10).");
  });

  it("stops at the 160,000-character budget on whole lines", async () => {
    // 每行恰好 100 字符；2000 行 = 200,000+ 字符，必然触发字符预算（行数恰好未超限）。
    const makeLine = (index: number): string => `L${String(index).padStart(4, "0")} ${"x".repeat(94)}`;
    const fixture = Array.from({ length: 2000 }, (_, index) => makeLine(index + 1));
    const file = join(root, "budget.txt");
    writeFileSync(file, `${fixture.join("\n")}\n`, "utf8");

    const content = await run(file);
    const body = bodyLines(content);
    const header = parseHeader(content);
    expect(header.total).toBe(2000);
    expect(header.start).toBe(1);
    expect(header.end).toBe(body.length);
    expect(body).toEqual(fixture.slice(0, body.length));
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(2000);

    const used = body.reduce((sum, line) => sum + line.length + 1, 0);
    const next = fixture[body.length]!;
    expect(used).toBeLessThanOrEqual(160_000);
    expect(used + next.length + 1).toBeGreaterThan(160_000);
    expect(content).toContain(
      `[!] READ TRUNCATED at the 160,000-character budget — showing lines 1-${body.length} of 2000 ` +
      `(${body.length} complete lines).`,
    );
    expect(content).toContain(`[!] Continue with start_line=${body.length + 1}.`);
    expect(content).not.toContain("lines not shown");
  });
});
