import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createPatch, applyPatch } from "diff";

// ------------------------------------------------------------------
// buildFileMutation (mirrors the logic in basic.ts)
// ------------------------------------------------------------------

interface FileMutation {
  path: string;
  kind: "created" | "modified";
  reversePatch: string | null;
  postImageSha: string;
  untracked?: true;
}

function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function buildFileMutation(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  fileExistedBefore: boolean,
): FileMutation {
  const postImageSha = computeSha256(afterContent);
  const reversePatch = createPatch(filePath, afterContent, beforeContent);
  return {
    path: filePath,
    kind: fileExistedBefore ? "modified" : "created",
    reversePatch,
    postImageSha,
  };
}

// ------------------------------------------------------------------
// Test fixtures
// ------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rewind-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// fileMutation capture
// ------------------------------------------------------------------

describe("buildFileMutation", () => {
  it("produces correct reverse patch for edit", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nMODIFIED\nline3\n";
    const fm = buildFileMutation("test.txt", before, after, true);

    expect(fm.kind).toBe("modified");
    expect(fm.postImageSha).toBe(computeSha256(after));
    expect(fm.reversePatch).toBeTruthy();

    // Applying the reverse patch to `after` should yield `before`
    const reverted = applyPatch(after, fm.reversePatch!);
    expect(reverted).toBe(before);
  });

  it("produces correct reverse patch for file creation", () => {
    const before = "";
    const after = "new content\nline2\n";
    const fm = buildFileMutation("new.txt", before, after, false);

    expect(fm.kind).toBe("created");
    const reverted = applyPatch(after, fm.reversePatch!);
    expect(reverted).toBe(before);
  });

  it("chains multiple reverse patches correctly", () => {
    const v0 = "aaa\nbbb\nccc\n";
    const v1 = "aaa\nBBB\nccc\n";
    const v2 = "aaa\nBBB\nCCC\nDDD\n";

    const fm1 = buildFileMutation("foo.txt", v0, v1, true);
    const fm2 = buildFileMutation("foo.txt", v1, v2, true);

    // Revert chain: v2 → v1 → v0 (newest first)
    let current: string | false = v2;
    current = applyPatch(current, fm2.reversePatch!);
    expect(current).toBe(v1);
    current = applyPatch(current as string, fm1.reversePatch!);
    expect(current).toBe(v0);
  });
});

// ------------------------------------------------------------------
// Conflict detection
// ------------------------------------------------------------------

describe("conflict detection", () => {
  it("detects user modification via SHA mismatch", () => {
    const before = "original\n";
    const after = "modified by agent\n";
    const fm = buildFileMutation("test.txt", before, after, true);

    // User modifies the file further
    const userModified = "modified by agent\nuser added line\n";
    const diskSha = computeSha256(userModified);

    expect(diskSha).not.toBe(fm.postImageSha);
  });

  it("reverse patch still applies on user-modified file if context matches", () => {
    const before = "aaa\nbbb\nccc\n";
    const after = "aaa\nBBB\nccc\n";
    const fm = buildFileMutation("test.txt", before, after, true);

    // User adds a line far from the edit
    const userModified = "aaa\nBBB\nccc\nuser_added\n";
    const reverted = applyPatch(userModified, fm.reversePatch!);
    expect(reverted).toBe("aaa\nbbb\nccc\nuser_added\n");
  });

  it("reverse patch fails when context is completely different", () => {
    const before = "aaa\nbbb\nccc\n";
    const after = "aaa\nBBB\nccc\n";
    const fm = buildFileMutation("test.txt", before, after, true);

    const totallyDifferent = "xxx\nyyy\n";
    const result = applyPatch(totallyDifferent, fm.reversePatch!);
    expect(result).toBe(false);
  });
});

// ------------------------------------------------------------------
// File revert on disk
// ------------------------------------------------------------------

describe("file revert on disk", () => {
  it("reverts a modified file", () => {
    const filePath = join(testDir, "file.txt");
    const before = "original content\n";
    const after = "modified content\n";

    writeFileSync(filePath, after, "utf-8");
    const fm = buildFileMutation(filePath, before, after, true);

    // Apply reverse patch
    const current = readFileSync(filePath, "utf-8");
    const reverted = applyPatch(current, fm.reversePatch!);
    expect(reverted).toBe(before);

    writeFileSync(filePath, reverted as string, "utf-8");
    expect(readFileSync(filePath, "utf-8")).toBe(before);
  });

  it("deletes a created file when reverted to empty", () => {
    const filePath = join(testDir, "new-file.txt");
    const after = "brand new content\n";

    writeFileSync(filePath, after, "utf-8");
    const fm = buildFileMutation(filePath, "", after, false);

    expect(fm.kind).toBe("created");

    const current = readFileSync(filePath, "utf-8");
    const reverted = applyPatch(current, fm.reversePatch!);
    expect(reverted).toBe("");

    // When reverted content is empty and file was created, delete it
    if (reverted === "" && fm.kind === "created") {
      rmSync(filePath);
    }
    expect(existsSync(filePath)).toBe(false);
  });

  it("reverts a chain of edits to the same file", () => {
    const filePath = join(testDir, "chained.txt");
    const v0 = "line1\nline2\nline3\n";
    const v1 = "line1\nEDITED\nline3\n";
    const v2 = "line1\nEDITED\nline3\nline4\n";

    writeFileSync(filePath, v2, "utf-8");

    const fm1 = buildFileMutation(filePath, v0, v1, true);
    const fm2 = buildFileMutation(filePath, v1, v2, true);

    // Apply newest first
    let current: string | false = readFileSync(filePath, "utf-8");
    current = applyPatch(current, fm2.reversePatch!);
    expect(current).toBe(v1);
    current = applyPatch(current as string, fm1.reversePatch!);
    expect(current).toBe(v0);

    writeFileSync(filePath, current as string, "utf-8");
    expect(readFileSync(filePath, "utf-8")).toBe(v0);
  });
});

// ------------------------------------------------------------------
// Crash journal
// ------------------------------------------------------------------

describe("crash journal", () => {
  it("restores preimages from journal", () => {
    const fileA = join(testDir, "a.txt");
    const fileB = join(testDir, "b.txt");

    // Original state
    writeFileSync(fileA, "original A\n", "utf-8");
    writeFileSync(fileB, "original B\n", "utf-8");

    // Simulate journal creation (preimage capture)
    const journal = [
      { path: fileA, existed: true, content: "original A\n" },
      { path: fileB, existed: true, content: "original B\n" },
    ];

    // Simulate partial revert (some files modified)
    writeFileSync(fileA, "reverted A\n", "utf-8");
    // fileB was being reverted when crash happened — still in modified state
    writeFileSync(fileB, "CORRUPTED\n", "utf-8");

    // Simulate recovery: restore from journal
    for (const img of journal) {
      if (img.existed && img.content !== null) {
        writeFileSync(img.path, img.content, "utf-8");
      }
    }

    expect(readFileSync(fileA, "utf-8")).toBe("original A\n");
    expect(readFileSync(fileB, "utf-8")).toBe("original B\n");
  });

  it("deletes files that did not exist before", () => {
    const fileC = join(testDir, "c.txt");

    // File was created by agent
    writeFileSync(fileC, "agent created\n", "utf-8");

    const journal = [
      { path: fileC, existed: false, content: null },
    ];

    // Recovery: delete files that didn't exist before
    for (const img of journal) {
      if (!img.existed) {
        try { rmSync(img.path); } catch { /* ignore */ }
      }
    }

    expect(existsSync(fileC)).toBe(false);
  });
});
