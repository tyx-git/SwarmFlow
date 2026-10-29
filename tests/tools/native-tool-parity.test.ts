/**
 * native rg 与 JS 回退的逐项对比测试。
 *
 * 目标不是“两条路径都能跑”，而是同一次调用必须返回完全相同的文本：
 * 格式、排序、忽略规则、每文件上限、长行截断、multiline、敏感文件边界。
 * 通过 useNative:false 强制 JS 回退（仅测试注入，生产默认走二进制）。
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bundledRgArgs, toolGrep, type GrepOptions } from "../../src/tools/grep.js";
import { resolveBundledSearchExecutable } from "../../src/tools/native-search.js";

const hasRg = resolveBundledSearchExecutable() !== null;

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function grepOptions(root: string, overrides: Partial<GrepOptions> = {}): GrepOptions {
  return {
    outputMode: "content",
    afterContext: 0,
    beforeContext: 0,
    caseInsensitive: undefined,
    showLineNumbers: true,
    headLimit: 0,
    perFileLimit: 15,
    fixedStrings: false,
    wordRegexp: false,
    lineRegexp: false,
    multiline: false,
    hidden: false,
    noIgnore: false,
    follow: false,
    maxDepth: 8,
    maxCount: 0,
    invertMatch: false,
    onlyMatching: false,
    countMatches: false,
    includeZero: false,
    text: false,
    sort: "path",
    ignoreRoot: root,
    ...overrides,
  };
}

async function grepPair(root: string, patterns: string[], overrides: Partial<GrepOptions> = {}) {
  const options = grepOptions(root, overrides);
  return {
    native: await toolGrep(patterns, root, { ...options, useNative: true }),
    js: await toolGrep(patterns, root, { ...options, useNative: false }),
  };
}

describe.skipIf(!hasRg)("grep native/JS parity", () => {
  it("matches content, context, no-line-number, only-matching, files and count formats", async () => {
    const root = makeTemp("swarmflow-parity-grep-");
    try {
      writeFileSync(join(root, "a.txt"), "before\nmatch foo:1:bar\nafter\n", "utf8");
      writeFileSync(join(root, "b.txt"), "other\nMATCH\nend\n", "utf8");

      for (const overrides of [
        {},
        { beforeContext: 1, afterContext: 1 },
        { showLineNumbers: false },
        { onlyMatching: true },
        { outputMode: "files_with_matches" as const },
        { outputMode: "count" as const },
      ]) {
        const pair = await grepPair(root, ["match"], overrides);
        expect(pair.js, JSON.stringify(overrides)).toBe(pair.native);
        expect(pair.native).not.toContain("supersecret");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps count mode independent from limit_per_file and honours max_count", async () => {
    const root = makeTemp("swarmflow-parity-count-");
    try {
      writeFileSync(join(root, "many.txt"), "MATCH\n".repeat(20), "utf8");

      const defaultCount = await grepPair(root, ["MATCH"], { outputMode: "count" });
      expect(defaultCount.js).toBe(defaultCount.native);
      expect(defaultCount.native).toContain("many.txt:20");

      const perFileIgnored = await grepPair(root, ["MATCH"], {
        outputMode: "count",
        perFileLimit: 3,
      });
      expect(perFileIgnored.js).toBe(perFileIgnored.native);
      expect(perFileIgnored.native).toContain("many.txt:20");

      const maxFive = await grepPair(root, ["MATCH"], {
        outputMode: "count",
        maxCount: 5,
      });
      expect(maxFive.js).toBe(maxFive.native);
      expect(maxFive.native).toContain("many.txt:5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies limit_per_file only to content and emits the same marker", async () => {
    const root = makeTemp("swarmflow-parity-perfile-");
    try {
      writeFileSync(join(root, "many.txt"), "MATCH\n".repeat(20), "utf8");
      const pair = await grepPair(root, ["MATCH"], { perFileLimit: 5 });
      expect(pair.js).toBe(pair.native);
      expect(pair.native).toContain("more matches in this file");
      expect(pair.native.split("\n").filter((line) => line.includes(":MATCH"))).toHaveLength(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses rg multiline semantics (no dotall)", async () => {
    const root = makeTemp("swarmflow-parity-multiline-");
    try {
      writeFileSync(join(root, "multi.txt"), "foo\nbar\nbaz\n", "utf8");

      const explicitNewline = await grepPair(root, ["foo\\nbar"], { multiline: true });
      expect(explicitNewline.js).toBe(explicitNewline.native);
      expect(explicitNewline.native).toContain("multi.txt:1:foo");
      expect(explicitNewline.native).toContain("multi.txt:2:bar");

      const dotAcrossLines = await grepPair(root, ["foo.*bar"], { multiline: true });
      expect(dotAcrossLines.js).toBe(dotAcrossLines.native);
      expect(dotAcrossLines.native).toBe("No matches found.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates every content line at 2000 characters on both paths", async () => {
    const root = makeTemp("swarmflow-parity-longline-");
    try {
      writeFileSync(join(root, "long.txt"), `match ${"x".repeat(3000)}\n`, "utf8");
      const pair = await grepPair(root, ["match"]);
      expect(pair.js).toBe(pair.native);
      expect(pair.native).toContain("line truncated at 2000 chars");
      expect(pair.native).not.toContain("x".repeat(2500));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sorts modified newest-first on both paths", async () => {
    const root = makeTemp("swarmflow-parity-sort-");
    try {
      const oldFile = join(root, "a-old.txt");
      const newFile = join(root, "z-new.txt");
      writeFileSync(oldFile, "needle\n", "utf8");
      writeFileSync(newFile, "needle\n", "utf8");
      utimesSync(oldFile, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
      utimesSync(newFile, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));

      const pair = await grepPair(root, ["needle"], { sort: "modified" });
      expect(pair.js).toBe(pair.native);
      expect(pair.native.indexOf("z-new.txt")).toBeLessThan(pair.native.indexOf("a-old.txt"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects .gitignore without a .git directory, including nested negations", async () => {
    const root = makeTemp("swarmflow-parity-ignore-");
    try {
      mkdirSync(join(root, "sub"));
      writeFileSync(join(root, ".gitignore"), "ignored.txt\n*.log\n", "utf8");
      writeFileSync(join(root, "sub", ".gitignore"), "!keep.log\n", "utf8");
      writeFileSync(join(root, "ignored.txt"), "needle\n", "utf8");
      writeFileSync(join(root, "a.log"), "needle\n", "utf8");
      writeFileSync(join(root, "sub", "keep.log"), "needle\n", "utf8");
      writeFileSync(join(root, "sub", "drop.log"), "needle\n", "utf8");
      writeFileSync(join(root, "kept.txt"), "needle\n", "utf8");

      const enforced = await grepPair(root, ["needle"]);
      expect(enforced.js).toBe(enforced.native);
      expect(enforced.native).toContain("kept.txt");
      expect(enforced.native).toContain("keep.log");
      expect(enforced.native).not.toContain("ignored.txt");
      expect(enforced.native).not.toContain("drop.log");

      const bypassed = await grepPair(root, ["needle"], { noIgnore: true });
      expect(bypassed.js).toBe(bypassed.native);
      expect(bypassed.native).toContain("ignored.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits the same head_limit truncation notice", async () => {
    const root = makeTemp("swarmflow-parity-head-");
    try {
      for (let index = 1; index <= 5; index += 1) {
        writeFileSync(join(root, `f${index}.txt`), "needle\n", "utf8");
      }
      for (const outputMode of ["content", "files_with_matches", "count"] as const) {
        const pair = await grepPair(root, ["needle"], { outputMode, headLimit: 2 });
        expect(pair.js, outputMode).toBe(pair.native);
        expect(pair.native).toContain("Reached results cap (2)");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks sensitive files in every output mode and on explicit paths", async () => {
    const root = makeTemp("swarmflow-parity-sensitive-");
    try {
      writeFileSync(join(root, "credentials.json"), '{"password":"supersecret"}\nnote\npassword here\n', "utf8");
      writeFileSync(join(root, "notes.txt"), "password docs\n", "utf8");

      for (const overrides of [
        { beforeContext: 1, afterContext: 1 },
        { showLineNumbers: false },
        { outputMode: "files_with_matches" as const },
        { outputMode: "count" as const },
      ]) {
        const pair = await grepPair(root, ["password"], overrides);
        expect(pair.js, JSON.stringify(overrides)).toBe(pair.native);
        expect(pair.native).not.toContain("supersecret");
        expect(pair.native).not.toContain("credentials.json");
        expect(pair.native).toContain("Skipped 1 sensitive file");
      }

      const explicit = await grepPair(root, ["password"], {});
      const sensitivePath = join(root, "credentials.json");
      const nativeExplicit = await toolGrep(["password"], sensitivePath, {
        ...grepOptions(root),
        useNative: true,
      });
      const jsExplicit = await toolGrep(["password"], sensitivePath, {
        ...grepOptions(root),
        useNative: false,
      });
      expect(jsExplicit).toBe(nativeExplicit);
      expect(nativeExplicit).toContain("blocked by default");
      // 防止 unused 变量：显式目录搜索的结果已被上面的 pair 覆盖。
      expect(explicit.native).toContain("notes.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not pass limit_per_file into count/files max-count", () => {
    const root = "C:/project";
    const countArgs = bundledRgArgs(grepOptions(root, {
      outputMode: "count",
      perFileLimit: 5,
      maxCount: 0,
    }));
    expect(countArgs).not.toContain("--max-count");

    const countWithMax = bundledRgArgs(grepOptions(root, {
      outputMode: "count",
      perFileLimit: 5,
      maxCount: 5,
    }));
    expect(countWithMax).toContain("--max-count");
    expect(countWithMax[countWithMax.indexOf("--max-count") + 1]).toBe("5");

    const contentArgs = bundledRgArgs(grepOptions(root, {
      outputMode: "content",
      perFileLimit: 5,
      maxCount: 0,
    }));
    expect(contentArgs).toContain("--json");
    expect(contentArgs[contentArgs.indexOf("--max-count") + 1]).toBe("6");
  });
});
