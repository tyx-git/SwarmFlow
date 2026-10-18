import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isDirectEntry } from "../external/opentui/main.js";

/**
 * 回归保护：TUI 入口的自启动判定 + Node 运行图里不允许再出现 Bun 编译路径。
 *
 * 现场背景：
 *   main.tsx 原先有一段 `prewarmCompiledOpenTuiCore()`，只在 Bun --compile 产物
 *   （模块挂在 /$bunfs/ 或 B:\~BUN\root 虚拟盘）里执行，用一串动态 import 预热
 *   fork 的 renderer 与全部 renderable。本项目已经只跑 Node（tsx 开发态 + SEA exe），
 *   这段代码永远不会执行，但 esbuild 会因为动态 import 可静态解析而把整个 vendored
 *   fork 打进产物：实测 TUI bundle 3186.4 KB / fork 输入 113 个 → 清理后
 *   1930.8 KB / 26 个（renderer、zig、platform/ffi、renderables 全部归零）。
 *
 * 入口判定同样是 Bun 遗留：`import.meta.main` 是运行时注入的开关，旧的 Node 兜底
 * 又用 `require()` 取内置模块 —— tsx 与打包后的 ESM 里 `require` 根本不存在，
 * 那条路只会静默返回 false。现在只保留 realpath 比对，并且这里直接测到它。
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const mainTsx = join(repoRoot, "external", "opentui", "main.tsx");
const cliTs = join(repoRoot, "src", "cli.ts");
const mainSource = readFileSync(mainTsx, "utf-8");

describe("TUI 入口自启动判定", () => {
  it("被当作模块引入时不能自己启动（防止双实例）", () => {
    // 本进程里 process.argv[1] 是 vitest，main.tsx 不是入口。
    expect(isDirectEntry()).toBe(false);
  });

  it("main.tsx 就是 argv[1] 时必须判定为入口", () => {
    expect(isDirectEntry(pathToFileURL(mainTsx).href, mainTsx)).toBe(true);
  });

  it("argv[1] 是相对路径时按 cwd 归一化后仍然命中", () => {
    expect(isDirectEntry(pathToFileURL(mainTsx).href, "external/opentui/main.tsx")).toBe(true);
  });

  it("argv[1] 是 src/cli.ts 时必须判定为非入口", () => {
    expect(isDirectEntry(pathToFileURL(mainTsx).href, cliTs)).toBe(false);
  });

  it("argv[1] 缺失时返回 false", () => {
    expect(isDirectEntry(pathToFileURL(mainTsx).href, undefined)).toBe(false);
  });

  it("realpath 失败（路径不存在）时退回字面比较", () => {
    const ghost = join(repoRoot, "external", "opentui", "not-there.tsx");
    expect(existsSync(ghost)).toBe(false);
    expect(isDirectEntry(pathToFileURL(ghost).href, ghost)).toBe(true);
    expect(isDirectEntry(pathToFileURL(ghost).href, join(repoRoot, "other.tsx"))).toBe(false);
  });
});

describe("Node 运行图里不允许 Bun 编译路径", () => {
  it("main.tsx 不再包含 Bun 单文件预热门径", () => {
    expect(mainSource).not.toContain("prewarmCompiledOpenTuiCore");
    expect(mainSource).not.toContain("$bunfs");
    expect(mainSource).not.toMatch(/~BUN/i);
    expect(mainSource).not.toContain("import.meta.main");
    expect(mainSource).not.toMatch(/\bbun:/);
  });

  it("main.tsx 不再动态导入 fork 的 renderer / renderables / animation", () => {
    expect(mainSource).not.toMatch(/forked\/core\/renderer/);
    expect(mainSource).not.toMatch(/forked\/core\/renderables\//);
    expect(mainSource).not.toMatch(/forked\/core\/animation\//);
    expect(mainSource).not.toMatch(/forked\/core\/Renderable\b/);
  });

  it("入口只引用 Node 真正会用到的 fork 模块", () => {
    const specifiers = [...mainSource.matchAll(/["'](\.\/forked\/[^"']+)["']/g)].map((m) => m[1]);
    const allowed = new Set([
      "./forked/core/lib/diagnostic.js",
      "./forked/patch-ffi-bounds.js",
      "./forked/patch-windows-console.js",
    ]);
    for (const spec of specifiers) {
      expect(allowed.has(spec), `未登记的 fork 引用: ${spec}`).toBe(true);
    }
    expect(specifiers.length).toBeGreaterThan(0);
  });

  it("bunfs 虚拟文件系统助手已随 Bun 编译路径一起删除", () => {
    expect(existsSync(join(repoRoot, "external", "opentui", "forked", "core", "lib", "bunfs.ts"))).toBe(false);
  });

  it("Bun 全局声明不再存在", () => {
    expect(existsSync(join(repoRoot, "external", "opentui", "types.d.ts"))).toBe(false);
    const shims = readFileSync(join(repoRoot, "external", "opentui", "upstream-shims.d.ts"), "utf-8");
    expect(shims).not.toMatch(/\bBun\b/);
    expect(shims).not.toMatch(/interface\s+ImportMeta/);
    // 资产模块声明是 Node 打包要用的，必须留着
    expect(shims).toContain('declare module "*.scm"');
    expect(shims).toContain('declare module "*.wasm"');
  });

  it("fork 平台运行层不再有 Bun 探测分支", () => {
    const runtime = readFileSync(
      join(repoRoot, "external", "opentui", "forked", "core", "platform", "runtime.ts"),
      "utf-8",
    );
    expect(runtime).not.toMatch(/BunLike/);
    expect(runtime).not.toMatch(/GlobalWithBun/);
    expect(runtime).not.toMatch(/\bbun\?/);
  });

  it("fork 的 FFI 层只剩 Node 后端", () => {
    const ffi = readFileSync(join(repoRoot, "external", "opentui", "forked", "core", "platform", "ffi.ts"), "utf-8");
    expect(ffi).not.toMatch(/createBunBackend|BunFfiBackend|BunFFIFunction|BunPointer/);
    expect(ffi).not.toMatch(/process\.versions\.bun/);
    expect(ffi).toContain("createNodeBackend");
  });

  it("NativeSpanFeed 不再按运行时分支决定抛错方式", () => {
    const feed = readFileSync(join(repoRoot, "external", "opentui", "forked", "core", "NativeSpanFeed.ts"), "utf-8");
    expect(feed).not.toMatch(/canThrowAcrossNativeCallback/);
    expect(feed).toMatch(/if \(!this\.inCallback\) \{/);
  });

  it("全仓代码行不允许再出现 Bun 运行期/编译期标识", () => {
    const patterns: Array<[string, RegExp]> = [
      ["bun:ffi", /\bbun:ffi\b/],
      ["process.versions.bun", /process\.versions\.bun/],
      ["import.meta.main", /import\.meta\.main/],
      ["isBun 探测", /\bisBun\b|canThrowAcrossNativeCallback/],
      ["Bun FFI 后端", /createBunBackend|BunFfiBackend|BunFFIFunction|BunPointer|BUN_DLOPEN_NULL|normalizeBunDefinition/],
      ["bunfs 虚拟盘", /isBunfsPath|normalizeBunfsPath|getBunfsRootPath|\$bunfs|~BUN/],
    ];
    const offenders: string[] = [];
    const files = sourceFiles();
    // 自检：扫描集合不能是空的，否则这条守卫会静默失效
    expect(files.length).toBeGreaterThan(150);
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split(/\r?\n/);
      lines.forEach((line, index) => {
        const text = line.trimStart();
        // 允许留注释说明“这里原先是什么、为什么删”；代码行一律不许出现。
        if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
        for (const [label, pattern] of patterns) {
          if (pattern.test(line)) {
            offenders.push(`${relative(repoRoot, file)}:${index + 1} 命中 ${label}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        out.push(abs);
      }
    }
  };
  for (const root of ["external/opentui", "src", "scripts"]) walk(join(repoRoot, root));
  return out;
}
