import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BEGIN_MEMORY_MARKER,
  END_MEMORY_MARKER,
} from "../../src/blocks/payload-blocks.js";
import {
  execMemory,
  MEMORY_MAX_BYTES,
  MEMORY_MAX_LINE_CHARS,
  MEMORY_MAX_LINES,
} from "../../src/session/memory-flow.js";

/**
 * `memory` 工具的行为契约：无正文只读、有正文整体复写，
 * 越界一律拒绝且不留半成品，备份只保留一代。
 */
describe("memory 工具", () => {
  const homes: string[] = [];

  function makeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-memory-"));
    homes.push(dir);
    return dir;
  }

  function memoryPath(home: string): string {
    return join(home, "MEMORY.md");
  }

  function withBody(lines: string[]): string {
    return [BEGIN_MEMORY_MARKER, ...lines, END_MEMORY_MARKER].join("\n");
  }

  afterEach(() => {
    for (const dir of homes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("上限本身是契约：40 行 / 120 字符 / 3 KiB，注入时不会被 8 KiB 预算截断", () => {
    // 其余用例按常量取值，这里把常量本身钉住，避免"上限被放宽后测试仍绿"。
    expect(MEMORY_MAX_LINES).toBe(40);
    expect(MEMORY_MAX_LINE_CHARS).toBe(120);
    expect(MEMORY_MAX_BYTES).toBe(3072);
    expect(MEMORY_MAX_BYTES).toBeLessThan(8 * 1024);
  });

  it("拒绝任何工具参数并复述裸块标记", async () => {
    const home = makeHome();
    const result = await execMemory({ path: "/tmp/MEMORY.md" }, undefined, home);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("memory takes no arguments");
    expect(result.content).toContain(BEGIN_MEMORY_MARKER);
    expect(existsSync(memoryPath(home))).toBe(false);
  });

  it("没有文件时查阅只报告路径，不创建也不备份", async () => {
    const home = makeHome();
    const result = await execMemory({}, undefined, home);

    expect(result.isError).toBe(false);
    expect(result.content).toContain(memoryPath(home));
    expect(result.content).toContain("does not exist yet");
    expect(existsSync(memoryPath(home))).toBe(false);
    expect(existsSync(`${memoryPath(home)}.bak`)).toBe(false);
  });

  it("有文件时查阅返回原文与规则条数，且不写盘", async () => {
    const home = makeHome();
    writeFileSync(memoryPath(home), "- 规则甲\n- 规则乙\n", "utf-8");
    const before = readFileSync(memoryPath(home), "utf-8");

    const result = await execMemory({}, undefined, home);

    expect(result.content).toContain("- 规则甲");
    expect(result.content).toContain("Rules: 2 / 40");
    expect(readFileSync(memoryPath(home), "utf-8")).toBe(before);
    expect(existsSync(`${memoryPath(home)}.bak`)).toBe(false);
  });

  it("空正文（只有标记）报错，不会把文件清空", async () => {
    const home = makeHome();
    writeFileSync(memoryPath(home), "- 保留我\n", "utf-8");

    const result = await execMemory({}, withBody([]), home);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("empty memory body");
    expect(readFileSync(memoryPath(home), "utf-8")).toBe("- 保留我\n");
  });

  it("首次复写写出整份文件并回显内容", async () => {
    const home = makeHome();
    const result = await execMemory(
      {},
      withBody(["- git提交信息需单行中文，无空格，精简概括", "- 注释用中文，专业词保留英文"]),
      home,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Global memory rewritten");
    expect(result.content).toContain("Backup: none (first memory file)");
    expect(readFileSync(memoryPath(home), "utf-8")).toBe(
      "- git提交信息需单行中文，无空格，精简概括\n- 注释用中文，专业词保留英文\n",
    );
  });

  it("复写是替换而非追加，旧内容留在唯一一代 .bak 里", async () => {
    const home = makeHome();
    await execMemory({}, withBody(["- 旧规则"]), home);
    const second = await execMemory({}, withBody(["- 新规则"]), home);

    expect(second.content).toContain("Backup:");
    expect(readFileSync(memoryPath(home), "utf-8")).toBe("- 新规则\n");
    expect(readFileSync(`${memoryPath(home)}.bak`, "utf-8")).toBe("- 旧规则\n");

    await execMemory({}, withBody(["- 第三条"]), home);
    expect(readFileSync(`${memoryPath(home)}.bak`, "utf-8")).toBe("- 新规则\n");
  });

  it("超出行数上限时拒绝写入，并给出合并指令", async () => {
    const home = makeHome();
    const lines = Array.from({ length: MEMORY_MAX_LINES + 1 }, (_, index) => `- 规则 ${index}`);

    const result = await execMemory({}, withBody(lines), home);

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`${MEMORY_MAX_LINES} lines`);
    expect(result.content).toContain("Merge rules");
    expect(existsSync(memoryPath(home))).toBe(false);
  });

  it("单行超长时指名行号与长度", async () => {
    const home = makeHome();
    const tooLong = `- ${"长".repeat(MEMORY_MAX_LINE_CHARS)}`;

    const result = await execMemory({}, withBody(["- 正常行", tooLong]), home);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("line 2");
    expect(result.content).toContain("is 122 characters");
    expect(result.content).toContain(`stay under ${MEMORY_MAX_LINE_CHARS}`);
    expect(existsSync(memoryPath(home))).toBe(false);
  });

  it("总字节超限时拒绝，理由是注入端不会被截断", async () => {
    const home = makeHome();
    // 每行 110 个 ASCII 字符、30 行：行数与行长都在门内，只有总字节越界。
    const line = `- ${"x".repeat(108)}`;
    const body = withBody(Array.from({ length: 30 }, () => line));
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(MEMORY_MAX_LINE_CHARS);

    const result = await execMemory({}, body, home);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("bytes");
    expect(result.content).toContain(String(MEMORY_MAX_BYTES));
    expect(existsSync(memoryPath(home))).toBe(false);
  });
});
