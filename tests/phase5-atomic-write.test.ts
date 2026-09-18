import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executeTool } from "../src/tools/basic.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function modeBits(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe("Phase 5 file write safety", () => {
  it("write_file preserves executable mode on overwrite and leaves no temp file", async () => {
    if (process.platform === "win32") return;

    const root = makeTempDir("swarmflow-atomic-write-");
    try {
      const file = join(root, "script.sh");
      writeFileSync(file, "#!/bin/sh\necho old\n", "utf-8");
      chmodSync(file, 0o755);

      const result = await executeTool(
        "write_file",
        { path: "script.sh", content: "#!/bin/sh\necho new\n" },
        { projectRoot: root },
      );

      expect(result.content).toContain("OK: Wrote");
      expect(readFileSync(file, "utf-8")).toContain("echo new");
      expect(modeBits(file)).toBe(0o755);

      const entries = readdirSync(root);
      expect(entries.some((name) => name.startsWith(".script.sh.tmp-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edit_file preserves executable mode on atomic rewrite", async () => {
    if (process.platform === "win32") return;

    const root = makeTempDir("swarmflow-atomic-edit-");
    try {
      const file = join(root, "tool.sh");
      writeFileSync(file, "#!/bin/sh\necho hello\n", "utf-8");
      chmodSync(file, 0o755);

      const result = await executeTool(
        "edit_file",
        { path: "tool.sh", edits: [{ old_str: "hello", new_str: "world" }] },
        { projectRoot: root },
      );

      expect(result.content).toContain("edits applied");
      expect(readFileSync(file, "utf-8")).toContain("world");
      expect(modeBits(file)).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects edit_file when expected_mtime_ms is stale", async () => {
    const root = makeTempDir("swarmflow-atomic-mtime-edit-");
    try {
      const file = join(root, "note.txt");
      writeFileSync(file, "hello\n", "utf-8");

      const read = await executeTool("read_file", { path: "note.txt" }, { projectRoot: root });
      const m = /mtime_ms=(\d+)/.exec(read.content);
      expect(m).not.toBeNull();
      const mtime = Number(m![1]);

      // External change after the read.
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeFileSync(file, "hello changed\n", "utf-8");

      const result = await executeTool(
        "edit_file",
        {
          path: "note.txt",
          edits: [{ old_str: "hello", new_str: "world" }],
          expected_mtime_ms: mtime,
        },
        { projectRoot: root },
      );

      expect(result.content).toContain("mtime conflict");
      expect(readFileSync(file, "utf-8")).toBe("hello changed\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects write_file overwrite when expected_mtime_ms is stale", async () => {
    const root = makeTempDir("swarmflow-atomic-mtime-write-");
    try {
      const file = join(root, "data.txt");
      writeFileSync(file, "v1\n", "utf-8");

      const read = await executeTool("read_file", { path: "data.txt" }, { projectRoot: root });
      const m = /mtime_ms=(\d+)/.exec(read.content);
      expect(m).not.toBeNull();
      const mtime = Number(m![1]);

      await new Promise((resolve) => setTimeout(resolve, 5));
      writeFileSync(file, "v2\n", "utf-8");

      const result = await executeTool(
        "write_file",
        {
          path: "data.txt",
          content: "agent overwrite\n",
          expected_mtime_ms: mtime,
        },
        { projectRoot: root },
      );

      expect(result.content).toContain("mtime conflict");
      expect(readFileSync(file, "utf-8")).toBe("v2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes to the same file with a process-local lock", async () => {
    const root = makeTempDir("swarmflow-atomic-lock-");
    const file = join(root, "same.txt");
    writeFileSync(file, "init\n", "utf-8");

    const originalRename = fsPromises.rename.bind(fsPromises);
    let renameCallCount = 0;
    let firstRenameReleased = false;
    let secondRenameStartedBeforeRelease = false;
    let firstRenameEnteredResolve!: () => void;
    let releaseFirstRename!: () => void;
    const firstRenameEntered = new Promise<void>((resolve) => {
      firstRenameEnteredResolve = resolve;
    });
    const firstRenameGate = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });

    const spy = vi.spyOn(fsPromises, "rename").mockImplementation(async (...args: Parameters<typeof fsPromises.rename>) => {
      renameCallCount += 1;
      if (renameCallCount === 1) {
        firstRenameEnteredResolve();
        await firstRenameGate;
        firstRenameReleased = true;
      } else if (!firstRenameReleased) {
        secondRenameStartedBeforeRelease = true;
      }
      return originalRename(...args);
    });

    try {
      const p1 = executeTool(
        "write_file",
        { path: "same.txt", content: "one\n" },
        { projectRoot: root },
      );
      const p2 = executeTool(
        "write_file",
        { path: "same.txt", content: "two\n" },
        { projectRoot: root },
      );

      await firstRenameEntered;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondRenameStartedBeforeRelease).toBe(false);

      releaseFirstRename();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.content).toContain("OK: Wrote");
      expect(r2.content).toContain("OK: Wrote");
      expect(["one\n", "two\n"]).toContain(readFileSync(file, "utf-8"));
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
