import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { Session } from "../src/session.js";
import { executeTool } from "../src/tools/basic.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Phase 2 tool validation and grep limits", () => {
  it("validates high-risk basic tool arguments at runtime", async () => {
    const root = makeTempDir("swarmflow-phase2-basic-");
    try {
      const readBad = await executeTool("read_file", { path: 123 as unknown as string }, { projectRoot: root });
      expect(readBad.content).toContain("Invalid arguments for read_file");
      expect(readBad.content).toContain("'path' must be a string");

      const bashBad = await executeTool(
        "bash",
        { command: "echo hi", timeout: 1.5 as unknown as number },
        { projectRoot: root },
      );
      expect(bashBad.content).toContain("Invalid arguments for bash");
      expect(bashBad.content).toContain("'timeout' must be an integer");

      const editBad = await executeTool(
        "edit_file",
        { path: "a.txt", edits: [{ old_str: "", new_str: "x" }] },
        { projectRoot: root },
      );
      expect(editBad.content).toContain("old_str");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns current local time with timezone and UTC offset", async () => {
    const root = makeTempDir("swarmflow-phase2-time-tool-");
    try {
      const result = await executeTool("time", {}, { projectRoot: root });
      expect(result.content).toContain("Current local time:");
      expect(result.content).toContain("Timezone:");
      expect(result.content).toContain("ISO 8601:");
      expect(result.content).toMatch(/UTC[+-]\d{2}:\d{2}/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects risky/overlong regex patterns before grep execution", async () => {
    const root = makeTempDir("swarmflow-phase2-search-regex-");
    try {
      writeFileSync(join(root, "a.txt"), "aaaaab\n", "utf-8");

      const tooLong = await executeTool(
        "grep",
        { pattern: "a".repeat(301), path: "." },
        { projectRoot: root },
      );
      expect(tooLong.content).toContain("Invalid arguments for grep");
      expect(tooLong.content).toContain("max length");

      const risky = await executeTool(
        "grep",
        { pattern: "(a+)+$", path: "." },
        { projectRoot: root },
      );
      expect(risky.content).toContain("Regex appears too complex/risky");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces grep depth and file-size limits with notices", async () => {
    const root = makeTempDir("swarmflow-phase2-search-limits-");
    try {
      // Depth limit is SEARCH_MAX_DEPTH (8). Bury the file at depth 10 so it must be skipped.
      let deep = root;
      for (let i = 0; i < 10; i++) {
        deep = join(deep, `d${i}`);
        mkdirSync(deep);
      }
      writeFileSync(join(deep, "too-deep.txt"), "needle\n", "utf-8");

      // Large file > 1MB should be skipped
      writeFileSync(join(root, "large.txt"), "x".repeat(1024 * 1024 + 10) + "needle", "utf-8");

      const result = await executeTool(
        "grep",
        { pattern: "needle", path: "." },
        { projectRoot: root },
      );

      expect(result.content).toContain("No matches found.");
      expect(result.content).toContain("[Search notices]");
      expect(result.content).toContain("Depth limit reached");
      expect(result.content).toContain("Skipped 1 large file(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a diff preview metadata block for edit_file", async () => {
    const root = makeTempDir("swarmflow-phase2-edit-preview-");
    try {
      writeFileSync(join(root, "a.txt"), "line 1\nold value\nline 3\n", "utf-8");

      const result = await executeTool(
        "edit_file",
        { path: "a.txt", edits: [{ old_str: "old value", new_str: "new value" }] },
        { projectRoot: root },
      );

      expect(result.content).toContain("edits applied");
      expect(result.metadata.path).toBe(join(root, "a.txt"));
      expect(result.metadata.tui_preview).toBeTruthy();
      const preview = result.metadata.tui_preview as Record<string, unknown>;
      expect(preview.kind).toBe("diff");
      expect(String(preview.text)).toContain("-old value");
      expect(String(preview.text)).toContain("+new value");
      expect(String(preview.text)).toMatch(/^\s*2\s+-old value$/m);
      expect(String(preview.text)).toMatch(/^\s*2\s+\+new value$/m);
      expect(preview.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a diff preview metadata block for write_file when overwriting", async () => {
    const root = makeTempDir("swarmflow-phase2-write-preview-");
    try {
      writeFileSync(join(root, "a.txt"), "line 1\nold value\nline 3\n", "utf-8");

      const result = await executeTool(
        "write_file",
        { path: "a.txt", content: "line 1\nnew value\nline 3\n" },
        { projectRoot: root },
      );

      expect(result.content).toContain(`OK: Wrote ${"line 1\nnew value\nline 3\n".length} characters`);
      expect(result.metadata.path).toBe(join(root, "a.txt"));
      expect(result.metadata.tui_preview).toBeTruthy();
      const preview = result.metadata.tui_preview as Record<string, unknown>;
      expect(preview.kind).toBe("diff");
      expect(String(preview.text)).toContain("-old value");
      expect(String(preview.text)).toContain("+new value");
      expect(preview.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a diff preview metadata block for write_file when creating a new file", async () => {
    const root = makeTempDir("swarmflow-phase2-write-preview-new-");
    try {
      const result = await executeTool(
        "write_file",
        { path: "new.txt", content: "first line\nsecond line\n" },
        { projectRoot: root },
      );

      expect(result.metadata.path).toBe(join(root, "new.txt"));
      expect(result.metadata.tui_preview).toBeTruthy();
      const preview = result.metadata.tui_preview as Record<string, unknown>;
      expect(preview.kind).toBe("diff");
      expect(String(preview.text)).toContain("--- ");
      expect(String(preview.text)).toContain("+++ ");
      expect(String(preview.text)).toContain("+first line");
      expect(String(preview.text)).toContain("+second line");
      expect(preview.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps all changed lines in large edit diffs without global truncation", async () => {
    const root = makeTempDir("swarmflow-phase2-edit-preview-large-");
    try {
      const oldBlock = Array.from({ length: 80 }, (_, i) => `old ${i + 1}`).join("\n");
      const newBlock = Array.from({ length: 80 }, (_, i) => `new ${i + 1}`).join("\n");
      writeFileSync(join(root, "big.txt"), `before\n${oldBlock}\nafter\n`, "utf-8");

      const result = await executeTool(
        "edit_file",
        { path: "big.txt", edits: [{ old_str: oldBlock, new_str: newBlock }] },
        { projectRoot: root },
      );

      const preview = result.metadata.tui_preview as Record<string, unknown>;
      expect(preview.kind).toBe("diff");
      expect(String(preview.text)).toContain("old 1");
      expect(String(preview.text)).toContain("old 80");
      expect(String(preview.text)).toContain("new 1");
      expect(String(preview.text)).toContain("new 80");
      expect(String(preview.text)).not.toContain("diff lines omitted");
      expect(String(preview.text)).not.toContain("diff preview truncated");
      expect(preview.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still omits unchanged context between distant changes", async () => {
    const root = makeTempDir("swarmflow-phase2-edit-preview-context-gap-");
    try {
      const beforeLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      const afterLines = [...beforeLines];
      afterLines[1] = "line 2 changed";
      afterLines[27] = "line 28 changed";
      writeFileSync(join(root, "gap.txt"), `${beforeLines.join("\n")}\n`, "utf-8");

      const result = await executeTool(
        "write_file",
        { path: "gap.txt", content: `${afterLines.join("\n")}\n` },
        { projectRoot: root },
      );

      const preview = result.metadata.tui_preview as Record<string, unknown>;
      expect(preview.kind).toBe("diff");
      expect(String(preview.text)).toContain("-line 2");
      expect(String(preview.text)).toContain("+line 2 changed");
      expect(String(preview.text)).toContain("-line 28");
      expect(String(preview.text)).toContain("+line 28 changed");
      expect(String(preview.text)).not.toContain("line 15");
      expect(preview.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates comm tool arguments at runtime", async () => {
    const fake = Object.create(Session.prototype) as any;
    fake._activeAgents = new Map();
    fake._progress = undefined;
    fake._turnCount = 0;
    fake._hasActiveAgents = () => false;

    // A bare string ids:"a" is now REPAIRED to ["a"] (tool-input repair, see
    // arg-repair.ts), so use a genuinely unrepairable value to hit the error
    // path. Bare-string→array repair is covered in arg-repair.test.ts.
    const killBad = Session.prototype["_execKillAgent"].call(fake, { ids: 5 });
    expect(killBad.content).toContain("invalid arguments for kill_agent");

    const askBad = Session.prototype["_execAsk"].call(fake, { questions: "bad" });
    expect(askBad.content).toContain("Error: 'questions' must be an array of 1-4 items.");
  });
});
