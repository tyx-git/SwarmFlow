/**
 * edit_file / write_file 的 50MB 保护。
 *
 * 期望值来自规格：读取、编辑、写入共用同一个 50MB 上限；
 * 大文件用稀疏文件构造，避免测试真的分配 50MB 内存。
 */

import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeTool } from "../../src/tools/dispatch.js";
import type { ToolResult } from "../../src/providers/response.js";

const LIMIT_BYTES = 50 * 1024 * 1024;
const TOO_LARGE = "ERROR: File too large (51.0 MB, limit 50 MB).";

function text(result: string | ToolResult): string {
  return typeof result === "string" ? result : result.content;
}

function makeSparseFile(path: string, sizeBytes: number): void {
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, sizeBytes);
  } finally {
    closeSync(fd);
  }
}

describe("edit/write 50MB guard", () => {
  let root: string;
  let oversized: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-edit-size-"));
    oversized = join(root, "oversized.txt");
    makeSparseFile(oversized, 51 * 1024 * 1024);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (tool: string, args: Record<string, unknown>): Promise<string> =>
    text(await executeTool(tool, args, { projectRoot: root } as never));

  it("rejects append edits on an existing file over 50MB", async () => {
    const result = await run("edit_file", {
      path: oversized,
      append_str: "should-not-be-written",
    });
    expect(result).toBe(TOO_LARGE);
    expect(statSync(oversized).size).toBe(51 * 1024 * 1024);
  });

  it("rejects replacement edits on an existing file over 50MB", async () => {
    const result = await run("edit_file", {
      path: oversized,
      edits: [{ old_str: "x", new_str: "y" }],
    });
    expect(result).toBe(TOO_LARGE);
    expect(statSync(oversized).size).toBe(51 * 1024 * 1024);
  });

  it("rejects write_file overwriting an existing file over 50MB", async () => {
    const result = await run("write_file", {
      path: oversized,
      content: "should-not-be-written",
    });
    expect(result).toBe(TOO_LARGE);
    expect(statSync(oversized).size).toBe(51 * 1024 * 1024);
  });

  it("uses the same 50MB message for read_file", async () => {
    const result = await run("read_file", { path: oversized });
    expect(result).toBe(TOO_LARGE);
  });

  it("still creates a new file below the limit", async () => {
    const target = join(root, "new-small.txt");
    const result = await run("write_file", { path: target, content: "hello\n" });
    expect(result).not.toContain("ERROR:");
    expect(readFileSync(target, "utf8")).toBe("hello\n");
    expect(statSync(target).size).toBeLessThan(LIMIT_BYTES);
  });
});
