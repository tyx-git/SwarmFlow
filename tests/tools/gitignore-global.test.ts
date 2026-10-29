/**
 * 全局 gitignore 的解析与优先级测试。
 *
 * 解析规则对齐 git 的常用形态：GIT_CONFIG_GLOBAL 优先；否则读
 * ~/.gitconfig 与 $XDG_CONFIG_HOME/git/config 的 core.excludesFile；
 * 未配置时回退 $XDG_CONFIG_HOME/git/ignore。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GitIgnoreStack, resolveGlobalIgnoreFiles } from "../../src/tools/gitignore.js";

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("resolveGlobalIgnoreFiles", () => {
  it("uses core.excludesFile from ~/.gitconfig", () => {
    const home = makeTemp("gitignore-home-");
    try {
      writeFileSync(join(home, ".gitconfig"), "[core]\n\texcludesFile = ~/.global-ignore\n", "utf8");
      expect(resolveGlobalIgnoreFiles({}, home)).toEqual([join(home, ".global-ignore")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("honours GIT_CONFIG_GLOBAL and XDG config paths", () => {
    const home = makeTemp("gitignore-home-");
    const xdg = makeTemp("gitignore-xdg-");
    try {
      const custom = join(home, "custom-ignore");
      const globalConfig = join(home, "gitconfig-alt");
      writeFileSync(globalConfig, `[core]\n\texcludesFile = ${custom}\n`, "utf8");
      expect(resolveGlobalIgnoreFiles({ GIT_CONFIG_GLOBAL: globalConfig }, home)).toEqual([custom]);

      mkdirSync(join(xdg, "git"), { recursive: true });
      writeFileSync(join(xdg, "git", "config"), `[core]\n\texcludesFile = ${custom}\n`, "utf8");
      expect(resolveGlobalIgnoreFiles({ XDG_CONFIG_HOME: xdg }, home)).toEqual([custom]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it("falls back to $XDG_CONFIG_HOME/git/ignore", () => {
    const home = makeTemp("gitignore-home-");
    const xdg = makeTemp("gitignore-xdg-");
    try {
      expect(resolveGlobalIgnoreFiles({ XDG_CONFIG_HOME: xdg }, home))
        .toEqual([join(xdg, "git", "ignore")]);
      expect(resolveGlobalIgnoreFiles({}, home)).toEqual([join(home, ".config", "git", "ignore")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it("resolves include.path relative to the including config and lets later values win", () => {
    const home = makeTemp("gitignore-home-");
    try {
      const included = join(home, "included-ignore");
      const overridden = join(home, "overridden-ignore");
      writeFileSync(join(home, "inc.config"), `[core]\n\texcludesFile = ${included}\n`, "utf8");

      const onlyInclude = join(home, "only-include.config");
      writeFileSync(onlyInclude, "[include]\n\tpath = inc.config\n", "utf8");
      expect(resolveGlobalIgnoreFiles({ GIT_CONFIG_GLOBAL: onlyInclude }, home)).toEqual([included]);

      const withOverride = join(home, "with-override.config");
      writeFileSync(
        withOverride,
        `[include]\n\tpath = inc.config\n[core]\n\texcludesFile = ${overridden}\n`,
        "utf8",
      );
      expect(resolveGlobalIgnoreFiles({ GIT_CONFIG_GLOBAL: withOverride }, home)).toEqual([overridden]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads system config via GIT_CONFIG_SYSTEM unless GIT_CONFIG_NOSYSTEM is set", () => {
    const home = makeTemp("gitignore-home-");
    const xdg = makeTemp("gitignore-xdg-");
    try {
      const systemIgnore = join(home, "system-ignore");
      const systemConfig = join(home, "system.config");
      writeFileSync(systemConfig, `[core]\n\texcludesFile = ${systemIgnore}\n`, "utf8");

      expect(resolveGlobalIgnoreFiles({ GIT_CONFIG_SYSTEM: systemConfig, XDG_CONFIG_HOME: xdg }, home))
        .toEqual([systemIgnore]);
      expect(resolveGlobalIgnoreFiles(
        { GIT_CONFIG_SYSTEM: systemConfig, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: xdg },
        home,
      )).toEqual([join(xdg, "git", "ignore")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it("prefers ~/.gitconfig over the XDG config file and keeps relative values cwd-relative", () => {
    const home = makeTemp("gitignore-home-");
    try {
      mkdirSync(join(home, ".config", "git"), { recursive: true });
      writeFileSync(join(home, ".config", "git", "config"), "[core]\n\texcludesFile = xdg-ignore\n", "utf8");
      writeFileSync(join(home, ".gitconfig"), "[core]\n\texcludesFile = relative-ignore\n", "utf8");
      // git 按 cwd 解析相对路径；这里只验证解析结果不额外拼接配置目录。
      expect(resolveGlobalIgnoreFiles({}, home)).toEqual(["relative-ignore"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("expands quoted tilde values and ignores conditional include sections", () => {
    const home = makeTemp("gitignore-home-");
    try {
      writeFileSync(join(home, ".gitconfig"), "[core]\n\texcludesFile = \"~/.quoted-ignore\"\n", "utf8");
      writeFileSync(join(home, ".quoted-ignore"), "", "utf8");
      expect(resolveGlobalIgnoreFiles({}, home)).toEqual([join(home, ".quoted-ignore")]);

      const conditional = join(home, "conditional.config");
      writeFileSync(
        conditional,
        `[includeIf "gitdir:~/work/"]\n\tpath = inc.config\n[core]\n\texcludesFile = ~/.quoted-ignore\n`,
        "utf8",
      );
      expect(resolveGlobalIgnoreFiles({ GIT_CONFIG_GLOBAL: conditional }, home))
        .toEqual([join(home, ".quoted-ignore")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("terminates on include cycles", () => {
    const home = makeTemp("gitignore-home-");
    try {
      const cyclic = join(home, "cyclic.config");
      writeFileSync(cyclic, "[include]\n\tpath = cyclic.config\n", "utf8");
      expect(resolveGlobalIgnoreFiles({ GIT_CONFIG_GLOBAL: cyclic }, home))
        .toEqual([join(home, ".config", "git", "ignore")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores excludesFile inside a [core \"sub\"] subsection", () => {
    const home = makeTemp("gitignore-home-");
    try {
      writeFileSync(
        join(home, ".gitconfig"),
        `[core "sub"]\n\texcludesFile = ${join(home, "wrong-ignore")}\n`,
        "utf8",
      );
      expect(resolveGlobalIgnoreFiles({}, home)).toEqual([join(home, ".config", "git", "ignore")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("GitIgnoreStack global rules", () => {
  it("ignores globally ignored files by default", () => {
    const root = makeTemp("gitignore-stack-");
    const globalFile = join(root, ".global-ignore");
    try {
      writeFileSync(join(root, "a.ts"), "", "utf8");
      writeFileSync(join(root, "b.log"), "", "utf8");
      writeFileSync(globalFile, "*.log\n", "utf8");

      const stack = new GitIgnoreStack(true, [".gitignore", ".ignore"], [globalFile]);
      stack.seedGlobal(root);
      stack.seedAncestors(root, root);
      stack.push(root);
      expect(stack.ignores(join(root, "b.log"), false)).toBe(true);
      expect(stack.ignores(join(root, "a.ts"), false)).toBe(false);
      stack.pop(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets project .gitignore negation re-include a globally ignored file", () => {
    const root = makeTemp("gitignore-stack-neg-");
    const globalFile = join(root, ".global-ignore");
    try {
      writeFileSync(join(root, "keep.log"), "", "utf8");
      writeFileSync(join(root, "drop.log"), "", "utf8");
      writeFileSync(join(root, ".gitignore"), "!keep.log\n", "utf8");
      writeFileSync(globalFile, "*.log\n", "utf8");

      const stack = new GitIgnoreStack(true, [".gitignore", ".ignore"], [globalFile]);
      stack.seedGlobal(root);
      stack.seedAncestors(root, root);
      stack.push(root);
      expect(stack.ignores(join(root, "keep.log"), false)).toBe(false);
      expect(stack.ignores(join(root, "drop.log"), false)).toBe(true);
      stack.pop(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disables global rules when the stack is disabled", () => {
    const root = makeTemp("gitignore-stack-off-");
    const globalFile = join(root, ".global-ignore");
    try {
      writeFileSync(join(root, "b.log"), "", "utf8");
      writeFileSync(globalFile, "*.log\n", "utf8");

      const stack = new GitIgnoreStack(false, [".gitignore", ".ignore"], [globalFile]);
      stack.seedGlobal(root);
      stack.seedAncestors(root, root);
      stack.push(root);
      expect(stack.ignores(join(root, "b.log"), false)).toBe(false);
      stack.pop(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
