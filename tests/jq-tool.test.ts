/**
 * jq 工具行为测试。
 *
 * 重点覆盖两类历史故障：
 *   1. 模型把 schema 里每个可选参数都填满，`content` 填空字符串，被
 *      `!== undefined` 误判成「同时提供了 path 和 content」，导致 136/142 次调用必然失败。
 *   2. 二进制定位失败时静默降级到受限 JS 实现，完整 jq 语法返回空结果而非报错。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeTool } from "../src/tools/basic.js";
import { bundledJqPath, toolJq } from "../src/tools/json-query.js";
import type { ToolResult } from "../src/providers/base.js";

const jqAvailable = bundledJqPath() !== null;

function text(result: string | ToolResult): string {
  return typeof result === "string" ? result : result.content;
}

describe.skipIf(!jqAvailable)("jq tool", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-jq-"));
    writeFileSync(
      join(root, "data.json"),
      JSON.stringify({
        scripts: { build: "tsc", test: "vitest" },
        items: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }],
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (args: Record<string, unknown>): Promise<string> =>
    text(await executeTool("jq", args, { projectRoot: root } as never));

  it("treats an empty content string as not provided", async () => {
    // 真实故障形态：content 填空字符串，同时给出 path。
    const out = await run({
      query: ".scripts.build",
      path: "data.json",
      content: "",
      raw: true,
      compact: true,
      max_chars: 10_000,
    });
    expect(out).not.toContain("provide either");
    expect(out).toContain("tsc");
  });

  it("still rejects a non-empty content alongside path", async () => {
    const out = await run({ query: ".", path: "data.json", content: '{"a":1}' });
    expect(out).toContain("provide either");
  });

  it("requires one of path or content", async () => {
    const out = await run({ query: ".", content: "   " });
    expect(out).toContain("one of 'path' or 'content' is required");
  });

  it("supports full jq syntax rather than a restricted subset", async () => {
    // 对象构造是旧 JS 回退不支持的语法；能通过说明走的是真二进制。
    const out = await run({ query: ".items[] | {id, name}", path: "data.json", compact: true });
    expect(out).toContain('"id":1');
    expect(out).toContain('"name":"alpha"');
    expect(out).toContain('"id":2');
  });

  it("reads JSON text from content", async () => {
    const out = await toolJq({
      query: ".a.b",
      content: '{"a":{"b":"ok"}}',
      raw: true,
      compact: true,
      slurp: false,
      maxChars: 1000,
    });
    expect(out).toBe("ok");
  });

  it("does not let a filter starting with -- change jq options", async () => {
    // 没有 `--` 时，--args 会被 jq 当成选项并原样输出输入；加了分隔符后
    // 它必须作为 filter 编译，因而报 args/0 未定义。
    await expect(toolJq({
      query: "--args",
      content: "{}",
      raw: false,
      compact: true,
      slurp: false,
      maxChars: 1000,
    })).rejects.toThrow(/args\/0 is not defined/);
  });

  it("kills a runaway filter at the configured budget", async () => {
    await expect(toolJq({
      query: "range(1; 1e18) | empty",
      content: "{}",
      raw: false,
      compact: true,
      slurp: false,
      maxChars: 1000,
      timeoutMs: 100,
    })).rejects.toThrow(/timed out after 100ms/);
  }, 10_000);
});

describe.skipIf(jqAvailable)("jq tool without a bundled binary", () => {
  it("fails loudly instead of silently degrading", async () => {
    const out = await toolJq({
      query: ".",
      content: "{}",
      raw: false,
      compact: true,
      slurp: false,
      maxChars: 1000,
    });
    expect(out).toContain("bundled jq binary not found");
  });
});
