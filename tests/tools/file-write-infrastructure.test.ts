import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  atomicWriteTextFile,
  withFileWriteLock,
} from "../../src/tools/file-write.js";
import {
  FileVersionConflictError,
  getFileVersionSnapshot,
} from "../../src/tools/file-version.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function modeBits(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe("file write infrastructure", () => {
  it.skipIf(process.platform === "win32")("preserves the executable mode and leaves no temp file", async () => {
    const root = makeTempDir("swarmflow-atomic-write-");
    try {
      const file = join(root, "script.sh");
      writeFileSync(file, "#!/bin/sh\necho old\n", "utf-8");
      chmodSync(file, 0o755);

      await atomicWriteTextFile(file, "#!/bin/sh\necho new\n", 0o755);

      expect(readFileSync(file, "utf-8")).toContain("echo new");
      expect(modeBits(file)).toBe(0o755);
      expect(readdirSync(root).some((name) => name.startsWith(".script.sh.tmp-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale expected version without touching the file or leaving temp files", async () => {
    const root = makeTempDir("swarmflow-atomic-version-");
    try {
      const file = join(root, "note.txt");
      writeFileSync(file, "v1\n", "utf-8");
      const stale = getFileVersionSnapshot(file);

      writeFileSync(file, "v2 with a different size\n", "utf-8");

      await expect(
        atomicWriteTextFile(file, "agent overwrite\n", undefined, stale),
      ).rejects.toBeInstanceOf(FileVersionConflictError);

      expect(readFileSync(file, "utf-8")).toBe("v2 with a different size\n");
      expect(readdirSync(root).some((name) => name.startsWith(".note.txt.tmp-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes writers to the same path", async () => {
    const root = makeTempDir("swarmflow-atomic-lock-");
    try {
      const file = join(root, "same.txt");
      writeFileSync(file, "init\n", "utf-8");

      let active = 0;
      let maxActive = 0;
      const run = async (content: string): Promise<void> => {
        await withFileWriteLock(file, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          await atomicWriteTextFile(file, content);
          active -= 1;
        });
      };

      await Promise.all([run("one\n"), run("two\n")]);

      expect(maxActive).toBe(1);
      expect(["one\n", "two\n"]).toContain(readFileSync(file, "utf-8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
