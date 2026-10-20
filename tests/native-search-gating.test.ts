/**
 * grep / glob 的二进制优先行为测试。
 *
 * 背景：这两个工具此前只在模型传入 rg/fd 特有参数时才启用二进制，
 * 普通调用完全走 JS 实现。改为恒启用后，必须确认 native 路径仍然遵守
 * head_limit 与 limit_per_file —— rg 的 --max-count 是每文件上限，
 * 漏传会让模型一次拿到远超预期的匹配量。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeTool } from "../src/tools/basic.js";
import { resolveBundledSearchExecutable } from "../src/tools/native-search.js";
import type { ToolResult } from "../src/providers/base.js";

const hasRg = resolveBundledSearchExecutable("rg") !== null;
const hasFd = resolveBundledSearchExecutable("fd") !== null;

function text(result: string | ToolResult): string {
  return typeof result === "string" ? result : result.content;
}

describe("grep with the bundled binary", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-native-grep-"));
    // 两个文件各 30 行匹配，用于验证每文件上限
    for (const name of ["a.ts", "b.ts"]) {
      writeFileSync(
        join(root, name),
        Array.from({ length: 30 }, (_, i) => `const MATCH_${i} = 1;`).join("\n"),
        "utf8",
      );
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (args: Record<string, unknown>): Promise<string> =>
    text(await executeTool("grep", { path: root, ...args }, { projectRoot: root } as never));

  it("caps matches per file at the default limit_per_file", async () => {
    const out = await run({ pattern: "MATCH", output_mode: "content" });
    const perFile = new Map<string, number>();
    for (const line of out.split("\n")) {
      // rg 输出 path:line:content；Windows 盘符含冒号，用贪婪匹配取最后一个 :数字: 前的前缀
      const match = /^(.*):\d+:/.exec(line);
      if (!match) continue;
      const file = match[1]!;
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    expect(perFile.size).toBeGreaterThan(0);
    for (const [file, count] of perFile) {
      expect(count, `${file} returned ${count} lines`).toBeLessThanOrEqual(15);
    }
  }, 20_000);

  it("honours an explicit limit_per_file", async () => {
    const out = await run({ pattern: "MATCH", output_mode: "content", limit_per_file: 3 });
    const perFile = new Map<string, number>();
    for (const line of out.split("\n")) {
      const match = /^(.*):\d+:/.exec(line);
      if (!match) continue;
      perFile.set(match[1]!, (perFile.get(match[1]!) ?? 0) + 1);
    }
    for (const [file, count] of perFile) {
      expect(count, `${file} returned ${count} lines`).toBeLessThanOrEqual(3);
    }
  }, 20_000);

  it("honours head_limit as an overall cap", async () => {
    const out = await run({ pattern: "MATCH", output_mode: "content", head_limit: 5 });
    const resultLines = out.split("\n").filter((line) => /:\d+:/.test(line));
    expect(resultLines.length).toBeLessThanOrEqual(5);
  }, 20_000);
});

describe("glob with the bundled binary", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "swarmflow-native-glob-"));
    mkdirSync(join(root, "nested"), { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(root, `file-${i}.ts`), "", "utf8");
      writeFileSync(join(root, "nested", `deep-${i}.ts`), "", "utf8");
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("honours limit", async () => {
    const out = text(await executeTool("glob", { pattern: "*.ts", path: root, limit: 4 }, { projectRoot: root } as never));
    const files = out.split("\n").filter((line) => line.trim() && !line.startsWith("["));
    expect(files.length).toBeLessThanOrEqual(4);
  }, 20_000);

  it("finds nested matches with a bare pattern", async () => {
    const out = text(await executeTool("glob", { pattern: "*.ts", path: root }, { projectRoot: root } as never));
    expect(out).toContain("file-0.ts");
    expect(out).toContain("deep-0.ts");
  }, 20_000);
});

describe("binary availability guards", () => {
  it("matches the Windows-only intools layout", () => {
    // 当前发布包只在 Windows 提供 intools；非 Windows 必须走 JS 回退。
    // 这是平台规格，不是“typeof 是 boolean”的空断言。
    if (process.platform === "win32") {
      expect(hasRg).toBe(true);
      expect(hasFd).toBe(true);
    } else {
      expect(hasRg).toBe(false);
      expect(hasFd).toBe(false);
    }
  });
});
