/**
 * 新 `edit` 的 50MB 保护；用稀疏文件构造，避免真的分配 50MB。
 */

import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeTool } from "../../src/tools/dispatch.js";
import type { ToolResult } from "../../src/providers/response.js";

const OVERSIZED_BYTES = 51 * 1024 * 1024;

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

function wrap(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

describe("edit 50MB guard", () => {
  let root: string;
  let oversized: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-edit-size-"));
    oversized = join(root, "oversized.txt");
    makeSparseFile(oversized, OVERSIZED_BYTES);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects an Update File hunk on an existing file over 50MB", async () => {
    const result = text(await executeTool("edit", {}, {
      projectRoot: root,
      toolPayload: wrap("*** Update File: oversized.txt\n@@\n-x\n+y"),
    } as never));
    expect(result).toContain("File too large");
    expect(statSync(oversized).size).toBe(OVERSIZED_BYTES);
  });

  it("rejects an Add File overwrite of an existing file over 50MB", async () => {
    const result = text(await executeTool("edit", {}, {
      projectRoot: root,
      toolPayload: wrap("*** Add File: oversized.txt\n+should-not-be-written"),
    } as never));
    expect(result).toContain("File too large");
    expect(statSync(oversized).size).toBe(OVERSIZED_BYTES);
  });

  it("uses the same 50MB message for read_file", async () => {
    const result = text(await executeTool("read_file", { path: "oversized.txt" }, {
      projectRoot: root,
    } as never));
    expect(result).toBe("ERROR: File too large (51.0 MB, limit 50 MB).");
  });

  it("still creates a small new file", async () => {
    const result = text(await executeTool("edit", {}, {
      projectRoot: root,
      toolPayload: wrap("*** Add File: new-small.txt\n+hello"),
    } as never));
    expect(result).toContain("Success. Updated the following files");
    expect(readFileSync(join(root, "new-small.txt"), "utf8")).toBe("hello\n");
  });
});
