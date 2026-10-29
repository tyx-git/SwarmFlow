/**
 * glob 的 JS 语义测试。
 *
 * 锁定字符类、花括号通配、多段扩展名、exclude 目录剪枝、
 * .gitignore/.ignore/全局 gitignore、目录尾斜杠、Windows executable 与空结果文案。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { toolGlob, type GlobOptions } from "../../src/tools/glob.js";

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function globJs(
  pattern: string,
  root: string,
  options: Partial<GlobOptions> = {},
): Promise<string> {
  return toolGlob(pattern, root, { limit: 50, ignoreRoot: root, ...options });
}

function names(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("["))
    .map((line) => line.split(/[\\/]/).filter(Boolean).pop() ?? line);
}

describe("glob JS fallback: pattern syntax", () => {
  it("supports character classes, ranges and negation", async () => {
    const root = makeTemp("glob-js-class-");
    try {
      for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(root, name), "");
      expect(names(await globJs("[ab].ts", root)).sort()).toEqual(["a.ts", "b.ts"]);
      expect(names(await globJs("[a-c].ts", root)).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(names(await globJs("[!a].ts", root)).sort()).toEqual(["b.ts", "c.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a leading or trailing dash in a class as a literal", async () => {
    const root = makeTemp("glob-js-class-dash-");
    try {
      for (const name of ["0.ts", "a.ts", "b.ts", "-.ts"]) writeFileSync(join(root, name), "");
      expect(names(await globJs("[!-a].ts", root)).sort()).toEqual(["0.ts", "b.ts"]);
      expect(names(await globJs("[a-].ts", root)).sort()).toEqual(["-.ts", "a.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports wildcard and nested brace alternation", async () => {
    const root = makeTemp("glob-js-brace-");
    try {
      for (const name of ["a.ts", "b.md", "c.md", "d.js"]) writeFileSync(join(root, name), "");
      expect(names(await globJs("{*.ts,*.md}", root)).sort()).toEqual(["a.ts", "b.md", "c.md"]);
      expect(names(await globJs("{{a,b},c}.md", root)).sort()).toEqual(["b.md", "c.md"]);
      expect(names(await globJs("{a}.ts", root))).toEqual(["a.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("glob JS fallback: filtering", () => {
  it("matches multi-part extensions by suffix", async () => {
    const root = makeTemp("glob-js-ext-");
    try {
      writeFileSync(join(root, "m.d.ts"), "");
      writeFileSync(join(root, "n.ts"), "");
      expect(names(await globJs("*.{ts}", root, { extensions: ["d.ts"] }))).toEqual(["m.d.ts"]);
      expect(names(await globJs("*.{ts}", root, { extensions: ["ts"] })).sort())
        .toEqual(["m.d.ts", "n.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes directories matched by exclude", async () => {
    const root = makeTemp("glob-js-exclude-");
    try {
      mkdirSync(join(root, "mydir"), { recursive: true });
      writeFileSync(join(root, "mydir", "b.ts"), "");
      writeFileSync(join(root, "x.ts"), "");
      expect(names(await globJs("**/*.ts", root, { excludes: ["mydir"] }))).toEqual(["x.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads .ignore with negation overriding .gitignore", async () => {
    const root = makeTemp("glob-js-ignore-");
    try {
      writeFileSync(join(root, "keep.ts"), "");
      writeFileSync(join(root, "app.ts"), "");
      writeFileSync(join(root, ".gitignore"), "*.ts\n", "utf8");
      writeFileSync(join(root, ".ignore"), "!keep.ts\n", "utf8");
      expect(names(await globJs("*.ts", root))).toEqual(["keep.ts"]);

      writeFileSync(join(root, ".gitignore"), "", "utf8");
      writeFileSync(join(root, ".ignore"), "app.ts\n", "utf8");
      expect(names(await globJs("*.ts", root))).toEqual(["keep.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips files matched by the global ignore file", async () => {
    const root = makeTemp("glob-js-global-ignore-");
    try {
      writeFileSync(join(root, "a.ts"), "");
      writeFileSync(join(root, "b.tmp"), "");
      const globalIgnore = join(root, ".global-ignore");
      writeFileSync(globalIgnore, "*.tmp\n", "utf8");

      expect(names(await globJs("*", root, { globalIgnoreFiles: [globalIgnore] }))).toEqual(["a.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("glob JS fallback: entry types and output", () => {
  it.skipIf(process.platform !== "win32")("treats exe/bat/cmd/com and extensionless files as executable", async () => {
    const root = makeTemp("glob-js-exec-");
    try {
      for (const name of ["a.exe", "b.bat", "c.cmd", "d.com", "plain", "e.txt", "f.EXE"]) {
        writeFileSync(join(root, name), "");
      }
      expect(names(await globJs("*", root, { type: ["executable"] })).sort())
        .toEqual(["a.exe", "b.bat", "c.cmd", "d.com", "plain"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends a trailing slash to directory results", async () => {
    const root = makeTemp("glob-js-dir-");
    try {
      mkdirSync(join(root, "mydir", "lib"), { recursive: true });
      const out = await globJs("**/lib", root, { type: ["directory"] });
      expect(out.endsWith("/lib/")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the canonical empty-result text", async () => {
    const root = makeTemp("glob-js-empty-");
    try {
      expect(await globJs("*.zzz", root)).toBe("No files found matching the pattern.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops at the search budget and reports the native notice", async () => {
    const root = makeTemp("glob-js-budget-");
    try {
      writeFileSync(join(root, "a.ts"), "");
      // 0ms 预算：确定性触发超时分支，不依赖真实耗时。
      const out = await globJs("*", root, { timeBudgetMs: 0 });
      expect(out).toBe("[Search stopped after 0ms.]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
