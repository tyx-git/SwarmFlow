/**
 * Coverage for the basic-tool overhaul:
 *  - read_file:  offset/limit aliases, per-line truncation
 *  - list_dir:   max_depth, max_entries, skipped-default dirs, file size suffix
 *  - glob:       Bun.Glob path, auto `**\/` prefix, limit cap
 *  - grep:       multi-pattern OR, smart-case, per-file limit, output cap
 *  - edit_file:  replace_all, no-op rejection, line-number disambiguation
 *  - bash:       spill-to-file when output exceeds the cap
 *  - web_fetch:  middle-cut truncation (covered indirectly via shared util)
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { executeTool } from "../src/tools/basic.js";
import { truncateMiddle } from "../src/tools/shared.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("read_file improvements", () => {
  it("accepts offset/limit aliases for start_line/end_line", async () => {
    const root = makeTempDir("swarmflow-read-aliases-");
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
      writeFileSync(join(root, "a.txt"), lines, "utf-8");

      const r = await executeTool(
        "read_file",
        { path: "a.txt", offset: 5, limit: 3 },
        { projectRoot: root },
      );
      expect(r.content).toContain("line5");
      expect(r.content).toContain("line6");
      expect(r.content).toContain("line7");
      expect(r.content).not.toContain("line8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates individual lines longer than the per-line cap and points at max_line_chars", async () => {
    const root = makeTempDir("swarmflow-read-line-trunc-");
    try {
      const huge = "x".repeat(6000);
      writeFileSync(join(root, "big.txt"), `before\n${huge}\nafter\n`, "utf-8");
      const r = await executeTool("read_file", { path: "big.txt" }, { projectRoot: root });
      expect(r.content).toContain("line truncated at 5000 chars");
      expect(r.content).toContain("1 line exceeded 5000 chars");
      expect(r.content).toContain("longest is 6000 chars");
      expect(r.content).toContain("max_line_chars=6000");
      expect(r.content).toContain("before");
      expect(r.content).toContain("after");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps lines between the old 2000 cap and the 5000 default intact", async () => {
    const root = makeTempDir("swarmflow-read-line-mid-");
    try {
      const line = "y".repeat(3500);
      writeFileSync(join(root, "mid.txt"), `${line}\n`, "utf-8");
      const r = await executeTool("read_file", { path: "mid.txt" }, { projectRoot: root });
      expect(r.content).toContain(line);
      expect(r.content).not.toContain("truncated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("max_line_chars raises the cap so the full line is returned", async () => {
    const root = makeTempDir("swarmflow-read-line-override-");
    try {
      const huge = "z".repeat(6000);
      writeFileSync(join(root, "big.txt"), `before\n${huge}\nafter\n`, "utf-8");
      const r = await executeTool(
        "read_file",
        { path: "big.txt", max_line_chars: 6000 },
        { projectRoot: root },
      );
      expect(r.content).toContain(huge);
      expect(r.content).not.toContain("truncated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("list_dir improvements", () => {
  it("renders file size suffixes and applies max_entries", async () => {
    const root = makeTempDir("swarmflow-list-cap-");
    try {
      // 12 files
      for (let i = 0; i < 12; i++) {
        writeFileSync(join(root, `f${i}.txt`), "hi", "utf-8");
      }
      const r = await executeTool(
        "list_dir",
        { path: ".", max_entries: 5 },
        { projectRoot: root },
      );
      expect(r.content).toContain("[2 B]"); // size suffix
      expect(r.content).toMatch(/Output truncated at 5 entries/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips excluded directories at depth > 0 but inspects them when passed as path", async () => {
    const root = makeTempDir("swarmflow-list-skip-");
    try {
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "pkg.json"), "{}", "utf-8");
      writeFileSync(join(root, "main.ts"), "// hi", "utf-8");

      const skipped = await executeTool("list_dir", { path: "." }, { projectRoot: root });
      expect(skipped.content).toContain("main.ts");
      expect(skipped.content).not.toContain("pkg.json");
      expect(skipped.content).toMatch(/Skipped \d+ excluded/);

      const explicit = await executeTool(
        "list_dir",
        { path: "node_modules" },
        { projectRoot: root },
      );
      expect(explicit.content).toContain("pkg.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("glob improvements", () => {
  it("auto-prepends **/ for slashless patterns", async () => {
    const root = makeTempDir("swarmflow-glob-auto-");
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "deep.ts"), "//", "utf-8");
      writeFileSync(join(root, "top.ts"), "//", "utf-8");

      const r = await executeTool(
        "glob",
        { pattern: "*.ts" },
        { projectRoot: root },
      );
      // Both files should match because the slashless `*.ts` is auto-prefixed
      // with `**/` to match anywhere in the tree.
      expect(r.content).toContain("top.ts");
      expect(r.content).toContain("deep.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a truncation notice when results exceed the limit", async () => {
    const root = makeTempDir("swarmflow-glob-limit-");
    try {
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(root, `f${i}.md`), "x", "utf-8");
      }
      const r = await executeTool(
        "glob",
        { pattern: "*.md", limit: 3 },
        { projectRoot: root },
      );
      expect(r.content).toMatch(/Showing 3 of 6 matches/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("grep improvements", () => {
  it("supports multi-pattern OR with array input", async () => {
    const root = makeTempDir("swarmflow-grep-multi-");
    try {
      writeFileSync(
        join(root, "a.ts"),
        "loadUser()\nload_user()\nLoadUser()\nunrelated()\n",
        "utf-8",
      );
      const r = await executeTool(
        "grep",
        {
          pattern: ["loadUser", "load_user", "LoadUser"],
          path: ".",
          output_mode: "content",
        },
        { projectRoot: root },
      );
      expect(r.content).toContain("loadUser()");
      expect(r.content).toContain("load_user()");
      expect(r.content).toContain("LoadUser()");
      expect(r.content).not.toContain("unrelated()");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("auto case-insensitive when pattern is all-lowercase (smart case)", async () => {
    const root = makeTempDir("swarmflow-grep-smartcase-");
    try {
      writeFileSync(join(root, "a.ts"), "FooBar\nfoobar\n", "utf-8");
      const r = await executeTool(
        "grep",
        { pattern: "foobar", path: ".", output_mode: "content" },
        { projectRoot: root },
      );
      expect(r.content).toContain("FooBar");
      expect(r.content).toContain("foobar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects -i: false to force case-sensitive even with lowercase pattern", async () => {
    const root = makeTempDir("swarmflow-grep-icase-off-");
    try {
      writeFileSync(join(root, "a.ts"), "FooBar\nfoobar\n", "utf-8");
      const r = await executeTool(
        "grep",
        { pattern: "foobar", path: ".", output_mode: "content", "-i": false },
        { projectRoot: root },
      );
      expect(r.content).toContain("foobar");
      expect(r.content).not.toContain("FooBar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps matches per file and surfaces a 'more matches' marker", async () => {
    const root = makeTempDir("swarmflow-grep-perfile-");
    try {
      const lines = Array.from({ length: 30 }, () => "needle").join("\n");
      writeFileSync(join(root, "a.ts"), lines, "utf-8");
      const r = await executeTool(
        "grep",
        {
          pattern: "needle",
          path: ".",
          output_mode: "content",
          limit_per_file: 5,
        },
        { projectRoot: root },
      );
      expect(r.content).toContain("more matches in this file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("edit_file improvements", () => {
  it("rejects no-op edits where old_str === new_str", async () => {
    const root = makeTempDir("swarmflow-edit-noop-");
    try {
      writeFileSync(join(root, "a.txt"), "hello\n", "utf-8");
      const r = await executeTool(
        "edit_file",
        { path: "a.txt", edits: [{ old_str: "hello", new_str: "hello" }] },
        { projectRoot: root },
      );
      expect(r.content).toContain("no-op");
      expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("hello\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports line numbers of every match when old_str is ambiguous", async () => {
    const root = makeTempDir("swarmflow-edit-ambig-");
    try {
      writeFileSync(
        join(root, "a.txt"),
        "alpha\nfoo\nbeta\nfoo\ngamma\nfoo\n",
        "utf-8",
      );
      const r = await executeTool(
        "edit_file",
        { path: "a.txt", edits: [{ old_str: "foo", new_str: "bar" }] },
        { projectRoot: root },
      );
      expect(r.content).toContain("appears 3 times");
      // Lines 2, 4, 6 in 1-indexed
      expect(r.content).toMatch(/at lines 2, 4, 6/);
      expect(r.content).toContain("replace_all: true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replace_all: true rewrites every occurrence", async () => {
    const root = makeTempDir("swarmflow-edit-replace-all-");
    try {
      writeFileSync(
        join(root, "a.txt"),
        "alpha\nfoo\nbeta\nfoo\ngamma\nfoo\n",
        "utf-8",
      );
      const r = await executeTool(
        "edit_file",
        {
          path: "a.txt",
          edits: [{ old_str: "foo", new_str: "BAR", replace_all: true }],
        },
        { projectRoot: root },
      );
      expect(r.content).toContain("edits applied");
      const after = readFileSync(join(root, "a.txt"), "utf-8");
      expect(after).toBe("alpha\nBAR\nbeta\nBAR\ngamma\nBAR\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bash spill", () => {
  it("writes the full untruncated output to a temp file when capped", async () => {
    const root = makeTempDir("swarmflow-bash-spill-proj-");
    const artifacts = makeTempDir("swarmflow-bash-spill-art-");
    try {
      // Generate ~250KB of stdout — comfortably above the 200K cap.
      const cmd = "yes 'X' | head -n 130000";
      const r = await executeTool(
        "bash",
        { command: cmd, timeout: 30 },
        { projectRoot: root, sessionArtifactsDir: artifacts },
      );
      expect(r.content).toContain("EXIT CODE: 0");
      expect(r.content).toContain("[truncated");
      expect(r.content).toMatch(/Full untruncated output saved to: .+\.log/);
      // The spill file should exist and contain the full output.
      const spillMatch = r.content.match(/saved to: (.+\.log)/);
      expect(spillMatch).not.toBeNull();
      const spillPath = spillMatch![1];
      const spilled = readFileSync(spillPath, "utf-8");
      expect(spilled.length).toBeGreaterThan(200_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------
// Reviewer-driven regression fixes
// ---------------------------------------------------------------------

describe("EXCLUDE_DIRS regression: regular files should not be hidden", () => {
  it("glob finds a regular file named like an excluded directory", async () => {
    const root = makeTempDir("swarmflow-fix-excldir-glob-");
    try {
      // Extensionless executable script literally named "build" — should be reachable.
      writeFileSync(join(root, "build"), "#!/bin/sh\necho hi\n", "utf-8");
      // Also a real "build" directory with something inside (must remain skipped).
      mkdirSync(join(root, "build_dir"));
      writeFileSync(join(root, "build_dir", "main.ts"), "// hi", "utf-8");
      // And a real excluded dir to make sure directory-skip still works.
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "should-not-appear.ts"), "//", "utf-8");

      const r = await executeTool(
        "glob",
        { pattern: "*" },
        { projectRoot: root },
      );
      expect(r.content).toContain("/build");
      expect(r.content).toContain("main.ts");
      expect(r.content).not.toContain("should-not-appear.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("list_dir surfaces a regular file named 'dist'", async () => {
    const root = makeTempDir("swarmflow-fix-excldir-list-");
    try {
      writeFileSync(join(root, "dist"), "binary stub", "utf-8");
      mkdirSync(join(root, "node_modules"));

      const r = await executeTool("list_dir", { path: "." }, { projectRoot: root });
      expect(r.content).toContain("dist");
      // node_modules should still be excluded
      expect(r.content).toContain("Skipped 1 excluded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grep finds matches in a regular file named 'vendor'", async () => {
    const root = makeTempDir("swarmflow-fix-excldir-grep-");
    try {
      writeFileSync(join(root, "vendor"), "needle\n", "utf-8");

      const r = await executeTool(
        "grep",
        { pattern: "needle", path: ".", output_mode: "files_with_matches" },
        { projectRoot: root },
      );
      expect(r.content).toContain("/vendor");
      expect(r.content).not.toContain("No matches found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("glob depth guard against circular symlinks", () => {
  // Skip on Windows where symlink creation needs admin privileges.
  if (process.platform === "win32") return;

  it("does not recurse forever through a self-referential symlink", async () => {
    const root = makeTempDir("swarmflow-fix-glob-symloop-");
    try {
      mkdirSync(join(root, "a"));
      // a/loop -> a (creates an infinite directory loop)
      symlinkSync(join(root, "a"), join(root, "a", "loop"));
      writeFileSync(join(root, "a", "real.ts"), "// hi", "utf-8");

      const start = Date.now();
      const r = await executeTool(
        "glob",
        { pattern: "*.ts" },
        { projectRoot: root },
      );
      // Must return promptly (depth guard kicks in) and find the real file.
      expect(Date.now() - start).toBeLessThan(5000);
      expect(r.content).toContain("real.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bash timeout spill threshold", () => {
  it("spills full output even when only one stream overflows", async () => {
    const root = makeTempDir("swarmflow-fix-spill-thresh-proj-");
    const artifacts = makeTempDir("swarmflow-fix-spill-thresh-art-");
    try {
      // Generate ~120K of stdout (well above half = 100K) then sleep past
      // the 1s timeout. stderr stays empty so total < BASH_MAX_OUTPUT_CHARS,
      // which previously suppressed the spill. With the fix, the spill is
      // written whenever a single stream exceeds the per-stream cap.
      const cmd = "yes 'X' | head -n 60000 && sleep 3";
      const r = await executeTool(
        "bash",
        { command: cmd, timeout: 1 },
        { projectRoot: root, sessionArtifactsDir: artifacts },
      );
      expect(r.content).toContain("timed out");
      expect(r.content).toMatch(/Full untruncated output saved to: .+\.log/);

      const spillMatch = r.content.match(/saved to: (.+\.log)/);
      expect(spillMatch).not.toBeNull();
      const spilled = readFileSync(spillMatch![1], "utf-8");
      expect(spilled.length).toBeGreaterThan(100_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
    }
  });
});

describe("read_file: offset/limit semantics", () => {
  it("limit means line count, not last-line index", async () => {
    const root = makeTempDir("swarmflow-fix-read-limit-");
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n");
      writeFileSync(join(root, "a.txt"), lines, "utf-8");

      // offset=10, limit=3 => lines 10, 11, 12 (NOT 10..3)
      const r = await executeTool(
        "read_file",
        { path: "a.txt", offset: 10, limit: 3 },
        { projectRoot: root },
      );
      expect(r.content).toContain("L10");
      expect(r.content).toContain("L11");
      expect(r.content).toContain("L12");
      expect(r.content).not.toContain("L13");
      // Verify the header reports lines 10-12, not 10-3
      expect(r.content).toMatch(/Lines 10-12 of 30/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dispatcher rejects non-positive limit/count args", () => {
  it("glob limit=0 returns a clear error instead of silently clamping", async () => {
    const root = makeTempDir("swarmflow-fix-glob-zero-");
    try {
      writeFileSync(join(root, "a.ts"), "//", "utf-8");
      const r = await executeTool(
        "glob",
        { pattern: "*.ts", limit: 0 },
        { projectRoot: root },
      );
      expect(r.content).toContain("Invalid arguments for glob");
      expect(r.content).toContain("'limit' must be >= 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("list_dir max_entries=-5 rejected", async () => {
    const root = makeTempDir("swarmflow-fix-list-neg-");
    try {
      const r = await executeTool(
        "list_dir",
        { path: ".", max_entries: -5 },
        { projectRoot: root },
      );
      expect(r.content).toContain("Invalid arguments for list_dir");
      expect(r.content).toContain("'max_entries' must be >= 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grep head_limit=0 rejected", async () => {
    const root = makeTempDir("swarmflow-fix-grep-zero-");
    try {
      writeFileSync(join(root, "a.ts"), "needle\n", "utf-8");
      const r = await executeTool(
        "grep",
        { pattern: "needle", path: ".", head_limit: 0 },
        { projectRoot: root },
      );
      expect(r.content).toContain("Invalid arguments for grep");
      expect(r.content).toContain("'head_limit' must be >= 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("read_file long-line escape hatch", () => {
  // The shell hint only appears for lines that cannot fit the per-call char
  // budget at all; anything shorter is recoverable in-tool via max_line_chars.
  it("points at head/tail/cut when a line exceeds the per-call char budget", async () => {
    const root = makeTempDir("swarmflow-fix-read-longline-hint-");
    try {
      writeFileSync(join(root, "big.txt"), "before\n" + "x".repeat(90_000) + "\nafter\n", "utf-8");
      const r = await executeTool("read_file", { path: "big.txt" }, { projectRoot: root });
      expect(r.content).toContain("head -n LINE_NUM");
      expect(r.content).toContain("cut -c FROM-TO");
      expect(r.content).toContain("pre-approved");
      expect(r.content).not.toContain("max_line_chars=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the full file path (not basename) so the command works from any cwd", async () => {
    const root = makeTempDir("swarmflow-fix-longline-fullpath-");
    try {
      // Put the long-line file in a subdirectory so basename ≠ full path.
      mkdirSync(join(root, "deep", "nested"), { recursive: true });
      const filePath = join(root, "deep", "nested", "big.txt");
      writeFileSync(filePath, "before\n" + "x".repeat(90_000) + "\nafter\n", "utf-8");

      const r = await executeTool(
        "read_file",
        { path: "deep/nested/big.txt" },
        { projectRoot: root },
      );
      // Must reference the absolute file path, not just `big.txt`, otherwise
      // the model running the hint from the project root would miss the file.
      expect(r.content).toContain(filePath);
      // And the hint should single-quote the path so spaces in the path
      // wouldn't break the command.
      expect(r.content).toContain(`'${filePath}'`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("truncateMiddle", () => {
  it("returns input unchanged when within limit", () => {
    expect(truncateMiddle("abcdef", 100)).toBe("abcdef");
  });

  it("keeps both head and tail when over the limit", () => {
    const input = "A".repeat(50) + "M".repeat(50) + "Z".repeat(50);
    const out = truncateMiddle(input, 40);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("Z")).toBe(true);
    expect(out).toContain("[truncated");
  });
});
