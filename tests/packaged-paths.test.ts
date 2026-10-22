/**
 * 打包后的路径/路由解析回归测试。
 *
 * 这些测试不依赖真实构建产物（dist/release 都在 .gitignore 里），
 * 而是用临时目录模拟源码、dist、SEA 三种布局，验证：
 *   - OpenTUI 入口路由
 *   - 内置资源根目录（assets/prompts/skills）
 *   - 原生工具（jq/rg/fd）定位
 *   - 项目 slug 与相对路径归一化
 *   - /hooks 命令从配置的 home 读取钩子
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDefaultRegistry } from "../src/commands/registration.js";
import { getBundledAssetsDir, resolveAssetPaths } from "../src/config/asset-paths.js";
import { projectSlug } from "../src/config/storage-layout.js";
import { SessionStore } from "../src/config/session-store.js";
import { resolveOpenTuiEntry } from "../src/cli.js";
import { bundledJqPath } from "../src/tools/json-query.js";
import { resolveBundledSearchExecutable } from "../src/tools/native-search.js";

function makeTempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `swarmflow-pkg-${label}-`));
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", "utf-8");
}

describe("packaged entry routing", () => {
  it("finds the TypeScript entry in a source checkout", () => {
    const root = makeTempRoot("entry-src");
    try {
      const modulePath = join(root, "src", "cli.ts");
      touch(modulePath);
      touch(join(root, "external", "opentui", "main.tsx"));
      expect(resolveOpenTuiEntry(modulePath)).toBe(join(root, "external", "opentui", "main.tsx"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the compiled entry from a dist/src layout", () => {
    const root = makeTempRoot("entry-dist");
    try {
      const modulePath = join(root, "dist", "src", "cli.js");
      touch(modulePath);
      touch(join(root, "external", "opentui", "main.js"));
      expect(resolveOpenTuiEntry(modulePath)).toBe(join(root, "external", "opentui", "main.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the compiled entry from a SEA runtime layout", () => {
    const root = makeTempRoot("entry-sea");
    try {
      const modulePath = join(root, "runtime", "dist", "src", "cli.js");
      touch(modulePath);
      touch(join(root, "runtime", "external", "opentui", "main.js"));
      expect(resolveOpenTuiEntry(modulePath)).toBe(join(root, "runtime", "external", "opentui", "main.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the compiled entry when both .js and .tsx exist", () => {
    const root = makeTempRoot("entry-prefer");
    try {
      const modulePath = join(root, "dist", "src", "cli.js");
      touch(modulePath);
      touch(join(root, "external", "opentui", "main.js"));
      touch(join(root, "external", "opentui", "main.tsx"));
      expect(resolveOpenTuiEntry(modulePath)).toBe(join(root, "external", "opentui", "main.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the UI distribution is missing", () => {
    const root = makeTempRoot("entry-missing");
    try {
      const modulePath = join(root, "dist", "src", "cli.js");
      touch(modulePath);
      expect(resolveOpenTuiEntry(modulePath)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles install paths with spaces and non-ASCII characters", () => {
    const root = makeTempRoot("安装 路径");
    try {
      const modulePath = join(root, "runtime", "dist", "src", "cli.js");
      touch(modulePath);
      touch(join(root, "runtime", "external", "opentui", "main.js"));
      expect(resolveOpenTuiEntry(modulePath)).toBe(join(root, "runtime", "external", "opentui", "main.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bundled assets root", () => {
  it("maps a compiled module URL to the dist root", () => {
    const root = makeTempRoot("assets-dist");
    try {
      const moduleUrl = pathToFileURL(join(root, "dist", "src", "config", "config.js")).href;
      expect(getBundledAssetsDir(moduleUrl)).toBe(join(root, "dist"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps the SEA runtime module URL to runtime/dist", () => {
    const root = makeTempRoot("assets-sea");
    try {
      const moduleUrl = pathToFileURL(
        join(root, "runtime", "dist", "src", "config", "config.js"),
      ).href;
      expect(getBundledAssetsDir(moduleUrl)).toBe(join(root, "runtime", "dist"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips install paths containing URL-special characters", () => {
    const root = makeTempRoot("assets#100% 版");
    try {
      const moduleUrl = pathToFileURL(join(root, "dist", "src", "config", "config.js")).href;
      expect(getBundledAssetsDir(moduleUrl)).toBe(join(root, "dist"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("points at the checkout root in source runs and keeps assets present", () => {
    const root = getBundledAssetsDir();
    expect(existsSync(join(root, "assets", "ui-texts", "language.json"))).toBe(true);
    expect(existsSync(join(root, "prompts", "review.md"))).toBe(true);
    expect(existsSync(join(root, "prompts", "templates"))).toBe(true);
    expect(existsSync(join(root, "skills"))).toBe(true);
  });
});

describe("bundled native tools", () => {
  it("resolves jq next to the compiled tool module", () => {
    const root = makeTempRoot("tools-jq");
    try {
      const moduleDir = join(root, "dist", "src", "tools");
      const jq = join(moduleDir, "intools", "jq", "jq.exe");
      touch(jq);
      expect(bundledJqPath(moduleDir, join(root, "node.exe"))).toBe(jq);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the executable directory when the module layout is unavailable", () => {
    // SEA 单文件：import.meta.url 指向 exe，模块目录推导落空，
    // 必须能按 exe 同级找到 intools。构建脚本负责把 intools 放在那里。
    const root = makeTempRoot("tools-jq-exe");
    try {
      const moduleDir = join(root, "nowhere", "dist", "src", "tools");
      const exeDir = join(root, "release", "SwarmFlow-win32-x64");
      const jq = join(exeDir, "intools", "jq", "jq.exe");
      touch(jq);
      expect(bundledJqPath(moduleDir, join(exeDir, "SwarmFlow.exe"))).toBe(jq);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the module-local jq over the executable copy", () => {
    const root = makeTempRoot("tools-jq-prefer");
    try {
      const moduleDir = join(root, "dist", "src", "tools");
      const exeDir = join(root, "release", "SwarmFlow-win32-x64");
      const moduleJq = join(moduleDir, "intools", "jq", "jq.exe");
      touch(moduleJq);
      touch(join(exeDir, "intools", "jq", "jq.exe"));
      expect(bundledJqPath(moduleDir, join(exeDir, "SwarmFlow.exe"))).toBe(moduleJq);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("resolves ripgrep and fd next to the compiled tool module", () => {
    const root = makeTempRoot("tools-search");
    try {
      const moduleDir = join(root, "dist", "src", "tools");
      const rg = join(moduleDir, "intools", "ripgrep", "rg.exe");
      const fd = join(moduleDir, "intools", "fd", "fd.exe");
      touch(rg);
      touch(fd);
      expect(resolveBundledSearchExecutable("rg", moduleDir, join(root, "node.exe"))).toBe(rg);
      expect(resolveBundledSearchExecutable("fd", moduleDir, join(root, "node.exe"))).toBe(fd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("falls back to the executable directory for ripgrep and fd", () => {
    // 与 jq 同源的 SEA 缺陷：import.meta.url 指向 exe，模块目录推导落空。
    const root = makeTempRoot("tools-search-exe");
    try {
      const moduleDir = join(root, "nowhere", "dist", "src", "tools");
      const exeDir = join(root, "release", "SwarmFlow-win32-x64");
      const rg = join(exeDir, "intools", "ripgrep", "rg.exe");
      const fd = join(exeDir, "intools", "fd", "fd.exe");
      touch(rg);
      touch(fd);
      const exe = join(exeDir, "SwarmFlow.exe");
      expect(resolveBundledSearchExecutable("rg", moduleDir, exe)).toBe(rg);
      expect(resolveBundledSearchExecutable("fd", moduleDir, exe)).toBe(fd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to a binary in the process cwd", () => {
    const root = makeTempRoot("tools-cwd");
    try {
      const moduleDir = join(root, "dist", "src", "tools");
      mkdirSync(moduleDir, { recursive: true });
      // 仓库的 src/tools/intools 里确实有 jq.exe；模拟的 dist 缺失且 exe 目录也没有时
      // 必须返回 null，而不是悄悄执行 cwd 里的同名文件。
      expect(bundledJqPath(moduleDir, join(root, "node.exe"))).toBeNull();
      if (process.platform === "win32") {
        expect(resolveBundledSearchExecutable("rg", moduleDir, join(root, "node.exe"))).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dist assembly", () => {
  let output: string;

  beforeAll(() => {
    output = makeTempRoot("dist-assembly");
    execFileSync(process.execPath, [join(process.cwd(), "scripts", "copy-node-assets.mjs"), output], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
  }, 30_000);

  afterAll(() => {
    rmSync(output, { recursive: true, force: true });
  });

  it("copies user-facing assets next to compiled modules", () => {
    expect(existsSync(join(output, "assets", "ui-texts", "language.json"))).toBe(true);
    expect(existsSync(join(output, "assets", "ui-colors", "color.json"))).toBe(true);
    expect(existsSync(join(output, "assets", "model-registry", "providers.json"))).toBe(true);
    expect(existsSync(join(output, "prompts", "review.md"))).toBe(true);
    expect(existsSync(join(output, "prompts", "templates"))).toBe(true);
    expect(existsSync(join(output, "skills"))).toBe(true);
  });

  it("keeps JSON imports from compiled src modules reachable", () => {
    // dist/src/ui/text.js imports ../../assets/ui-texts/language.json
    const assetsRoot = getBundledAssetsDir(pathToFileURL(join(output, "src", "lib", "ui-text.js")).href);
    expect(assetsRoot).toBe(output);
    expect(existsSync(join(assetsRoot, "assets", "ui-texts", "language.json"))).toBe(true);
    // dist/src/version.js imports ../package.json
    expect(existsSync(join(output, "package.json"))).toBe(true);
  });

  it("copies native intools next to the compiled tools", () => {
    const intools = join(output, "src", "tools", "intools");
    expect(existsSync(intools)).toBe(true);
    expect(existsSync(join(intools, "jq", "jq.exe"))).toBe(true);
    if (process.platform === "win32") {
      expect(existsSync(join(intools, "ripgrep", "rg.exe"))).toBe(true);
    }
  });
});

// release/ 是本地构建产物（.gitignore），CI 无产物时跳过；本地构建后可兜底
// 检查真实发布目录是否缺文件。
const releaseRoot = join(process.cwd(), "release", "SwarmFlow-win32-x64");
describe.skipIf(!existsSync(releaseRoot))("release layout", () => {
  it("contains the executable and both runtime entry points", () => {
    expect(existsSync(join(releaseRoot, "SwarmFlow.exe"))).toBe(true);
    expect(existsSync(join(releaseRoot, "runtime", "dist", "src", "cli.js"))).toBe(true);
    expect(existsSync(join(releaseRoot, "runtime", "external", "opentui", "main.js"))).toBe(true);
  });

  it("keeps assets reachable from both the CLI and the bundled TUI entry", () => {
    for (const base of [join(releaseRoot, "runtime"), join(releaseRoot, "runtime", "dist")]) {
      expect(existsSync(join(base, "assets", "ui-texts", "language.json"))).toBe(true);
      expect(existsSync(join(base, "prompts", "review.md"))).toBe(true);
      expect(existsSync(join(base, "prompts", "templates"))).toBe(true);
      expect(existsSync(join(base, "skills"))).toBe(true);
    }
    expect(existsSync(join(releaseRoot, "runtime", "node_modules", "@opentui", "core-win32-x64"))).toBe(true);
    // 运行时实际使用的 tree-sitter worker 在 @opentui/core 包内，而不是 fork 的源码目录。
    expect(existsSync(join(releaseRoot, "runtime", "node_modules", "@opentui", "core", "parser.worker.js"))).toBe(true);
  });

  it("contains every ./assets reference emitted into the bundled TUI entry", () => {
    const mainJs = join(releaseRoot, "runtime", "external", "opentui", "main.js");
    const source = readFileSync(mainJs, "utf-8");
    // default-parsers.ts 同时保留源码布局的 fallback 子路径（javascript/...），
    // 它们不会被 esbuild 发射；真正被打包引用的是扁平哈希文件。
    const references = new Set(
      [...source.matchAll(/"\.\/assets\/([^"]+)"/g)]
        .map((match) => match[1]!)
        .filter((reference) => !reference.includes("/")),
    );
    expect(references.size).toBeGreaterThan(0);
    for (const reference of references) {
      expect(existsSync(join(dirname(mainJs), "assets", reference))).toBe(true);
    }
  });
});

describe("extension layer routing", () => {
  it("resolves global, project and workspace roots against projectPath", () => {
    const root = makeTempRoot("layers");
    try {
      const home = join(root, "home");
      const project = join(root, "my project");
      const slug = projectSlug(project);
      const projectStore = join(home, "projects", slug, ".swarmflow");
      const workspace = join(project, ".swarmflow");

      mkdirSync(join(home, "prompts", "templates"), { recursive: true });
      mkdirSync(join(home, "skills"), { recursive: true });
      mkdirSync(join(home, "hooks"), { recursive: true });
      mkdirSync(join(projectStore, "prompts", "templates"), { recursive: true });
      mkdirSync(join(projectStore, "skills"), { recursive: true });
      mkdirSync(join(projectStore, "hooks"), { recursive: true });
      mkdirSync(join(workspace, "prompts", "templates"), { recursive: true });
      mkdirSync(join(workspace, "skills"), { recursive: true });
      mkdirSync(join(workspace, "hooks"), { recursive: true });
      writeFileSync(join(project, ".mcp.json"), "{}\n", "utf-8");

      const paths = resolveAssetPaths({ projectPath: project, homeDir: home });

      expect(paths.homeDir).toBe(home);
      expect(paths.extensions.workspace).toBe(workspace);
      expect(paths.extensions.project).toBe(projectStore);
      expect(paths.extensions.global).toBe(home);

      expect(paths.templateRoots).toEqual([
        join(home, "prompts", "templates"),
        join(projectStore, "prompts", "templates"),
        join(workspace, "prompts", "templates"),
      ]);
      expect(paths.skillRoots).toEqual([
        join(home, "skills"),
        join(projectStore, "skills"),
        join(workspace, "skills"),
      ]);
      expect(paths.hookRoots).toEqual([
        { dir: join(home, "hooks"), scope: "global" },
        { dir: join(projectStore, "hooks"), scope: "project" },
        { dir: join(workspace, "hooks"), scope: "workspace" },
      ]);
      expect(paths.projectMcpConfigPath).toBe(join(project, ".mcp.json"));
      expect(paths.projectSkillsPath).toBe(join(workspace, "skills"));
      expect(paths.projectTemplatesPath).toBe(join(workspace, "prompts", "templates"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relative module routing", () => {
  it("contains no relative require() that bypasses the TypeScript resolver", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          visit(path);
          continue;
        }
        if (!path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
        const source = readFileSync(path, "utf-8");
        for (const match of source.matchAll(/require\(\s*(["'])(\.[^"']*)\1\s*\)/g)) {
          offenders.push(`${path}: ${match[2]}`);
        }
      }
    };
    visit(root);
    expect(offenders).toEqual([]);
  });
});

describe("project path normalization", () => {
  it("maps relative, dotted and trailing-separator paths to the same slug", () => {
    const cwd = process.cwd();
    expect(projectSlug(".")).toBe(projectSlug(cwd));
    expect(projectSlug(join(cwd, "."))).toBe(projectSlug(cwd));
    expect(projectSlug(`${cwd}${sep}`)).toBe(projectSlug(cwd));
  });

  it("stores sessions for a relative project path under the absolute project slug", () => {
    const home = makeTempRoot("slug-store");
    try {
      const store = new SessionStore({ projectPath: ".", baseDir: home });
      expect(store.projectDir).toBe(join(home, "projects", projectSlug(process.cwd())));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps project metadata absolute for a relative project path", () => {
    const home = makeTempRoot("slug-meta");
    try {
      const store = new SessionStore({ projectPath: ".", baseDir: home });
      store.createSession();
      const meta = JSON.parse(readFileSync(join(store.projectDir, "project.json"), "utf-8"));
      expect(meta.original_path).toBe(process.cwd());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("normalizes a relative projectPath before building workspace roots", () => {
    const home = makeTempRoot("assets-relative");
    try {
      const paths = resolveAssetPaths({ projectPath: ".", homeDir: home });
      const project = process.cwd();
      expect(paths.extensions.workspace).toBe(join(project, ".swarmflow"));
      expect(paths.projectMcpConfigPath).toBe(
        existsSync(join(project, ".mcp.json")) ? join(project, ".mcp.json") : null,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves project templates against projectPath, not the process cwd", () => {
    const root = makeTempRoot("templates-project");
    try {
      const home = join(root, "home");
      const project = join(root, "workspace with space");
      mkdirSync(home, { recursive: true });
      mkdirSync(join(project, "prompts", "templates"), { recursive: true });
      const paths = resolveAssetPaths({ projectPath: project, homeDir: home });
      expect(paths.templatesPath).toBe(join(project, "prompts", "templates"));
      expect(paths.promptsPath).toBe(join(project, "prompts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("/hooks command routing", () => {
  it("reads global hooks from the configured SwarmFlow home", async () => {
    const home = makeTempRoot("hooks-home");
    try {
      const hookDir = join(home, "hooks", "notify");
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(join(hookDir, "hook.json"), JSON.stringify({
        event: "SessionStart",
        type: "command",
        command: "node",
        args: ["-e", "process.exit(0)"],
      }), "utf-8");

      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/hooks");
      expect(cmd).toBeTruthy();

      const messages: string[] = [];
      const ctx: any = {
        session: { hookRuntime: {} },
        showMessage: (message: string) => messages.push(message),
        swarmflowHomeDir: home,
        autoSave: () => {},
        resetUiState: () => {},
        commandRegistry: registry,
      };

      await cmd!.handler(ctx, "");

      expect(messages.at(-1)).toContain("1 hook(s), 1 active.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not treat a missing hook directory as a routing failure", async () => {
    const home = makeTempRoot("hooks-empty");
    try {
      mkdirSync(home, { recursive: true });
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/hooks");
      const messages: string[] = [];
      const ctx: any = {
        session: { hookRuntime: {} },
        showMessage: (message: string) => messages.push(message),
        swarmflowHomeDir: home,
        autoSave: () => {},
        resetUiState: () => {},
        commandRegistry: registry,
      };

      await cmd!.handler(ctx, "");

      expect(messages.at(-1)).toBe("No hooks registered.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
