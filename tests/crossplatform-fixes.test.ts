/**
 * Regression coverage for the cross-platform audit fixes:
 *   - H-3: edit_file must match a multi-line, LF-only old_str against a
 *          CRLF file (read_file strips CR, so the model only ever sees
 *          LF) and preserve the file's CRLF line endings on write.
 *   - H-4: on case-insensitive filesystems (default macOS, Windows Git
 *          Bash) an uppercase danger command (RM, SUDO) must classify
 *          the same as its lowercase form, instead of slipping past the
 *          danger/catastrophic gate. On case-sensitive Linux the
 *          original casing is preserved (RM is a distinct file).
 *
 * The H-4 assertions are gated on osCapabilities.caseInsensitiveFilesystem
 * so the suite is correct regardless of which OS runs it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyToolAsync } from "../src/permissions/index.js";
import { executeTool } from "../src/tools/basic.js";
import { osCapabilities } from "../src/platform/index.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("H-3: edit_file handles CRLF files with LF old_str", () => {
  it("matches a multi-line LF old_str against a CRLF file and keeps CRLF", async () => {
    const root = makeTempDir("swarmflow-crlf-edit-");
    try {
      const file = join(root, "crlf.txt");
      // Windows-authored file: CRLF line endings throughout.
      writeFileSync(file, "line1\r\nline2\r\nline3\r\nline4\r\n", "utf-8");

      // The model copies a snippet from read_file output, which is
      // LF-only — so old_str spans two lines joined by a bare "\n".
      const result = await executeTool(
        "edit_file",
        {
          path: "crlf.txt",
          edits: [{ old_str: "line2\nline3", new_str: "line2\nNEW3" }],
        },
        { projectRoot: root },
      );

      // Must succeed: no "old_str not found" / error.
      expect(result.content).not.toContain("not found");
      expect(result.content).not.toMatch(/^ERROR/);

      // The replacement landed and the file is still CRLF (no lone-LF
      // lines seeded into the edited region).
      const after = readFileSync(file, "utf-8");
      expect(after).toContain("NEW3");
      expect(after).toContain("line2\r\nNEW3\r\nline4");
      expect(after).not.toMatch(/[^\r]\n/); // every \n is preceded by \r
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still edits a plain LF file unchanged (no regression)", async () => {
    const root = makeTempDir("swarmflow-lf-edit-");
    try {
      const file = join(root, "lf.txt");
      writeFileSync(file, "alpha\nbeta\ngamma\n", "utf-8");

      const result = await executeTool(
        "edit_file",
        {
          path: "lf.txt",
          edits: [{ old_str: "beta\ngamma", new_str: "beta\nGAMMA" }],
        },
        { projectRoot: root },
      );

      expect(result.content).not.toContain("not found");
      const after = readFileSync(file, "utf-8");
      expect(after).toBe("alpha\nbeta\nGAMMA\n");
      expect(after).not.toContain("\r");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("H-4: danger-command classification respects filesystem case sensitivity", () => {
  const ci = osCapabilities.caseInsensitiveFilesystem;

  async function classify(command: string, cwd: string) {
    return (await classifyToolAsync("bash", { command, cwd })).permissionClass;
  }

  it("always treats lowercase `rm -rf /` as catastrophic", async () => {
    const root = makeTempDir("swarmflow-rm-lower-");
    try {
      expect(await classify("rm -rf /", root)).toBe("catastrophic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies uppercase `RM -rf /` according to the case-lookup capability", async () => {
    const root = makeTempDir("swarmflow-rm-upper-");
    try {
      const cls = await classify("RM -rf /", root);
      if (ci) {
        // Case-insensitive FS: RM resolves to rm — must NOT slip the gate.
        expect(cls).toBe("catastrophic");
      } else {
        // Case-sensitive FS (Linux): RM is a distinct file, not rm.
        expect(cls).not.toBe("catastrophic");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies uppercase `SUDO whoami` according to the case-lookup capability", async () => {
    const root = makeTempDir("swarmflow-sudo-upper-");
    try {
      const cls = await classify("SUDO whoami", root);
      if (ci) {
        expect(cls).toBe("write_danger");
      } else {
        expect(cls).not.toBe("write_danger");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("M-5: write_file preserves the file's existing line endings", () => {
  it("keeps CRLF when overwriting a CRLF file with LF content", async () => {
    const root = makeTempDir("swarmflow-write-crlf-");
    try {
      const file = join(root, "crlf.txt");
      writeFileSync(file, "alpha\r\nbeta\r\ngamma\r\n", "utf-8");

      // The model composes replacement content with LF (read_file only
      // ever shows LF).
      const result = await executeTool(
        "write_file",
        { path: "crlf.txt", content: "alpha\nBETA\ngamma\n" },
        { projectRoot: root },
      );
      expect(result.content).not.toMatch(/^ERROR/);

      const after = readFileSync(file, "utf-8");
      // The edit landed AND the file is still CRLF throughout — no silent
      // EOL rewrite of the untouched lines.
      expect(after).toBe("alpha\r\nBETA\r\ngamma\r\n");
      expect(after).not.toMatch(/[^\r]\n/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps LF for a new file authored with LF (no spurious CR)", async () => {
    const root = makeTempDir("swarmflow-write-lf-");
    try {
      const result = await executeTool(
        "write_file",
        { path: "new.txt", content: "one\ntwo\n" },
        { projectRoot: root },
      );
      expect(result.content).not.toMatch(/^ERROR/);
      const after = readFileSync(join(root, "new.txt"), "utf-8");
      expect(after).toBe("one\ntwo\n");
      expect(after).not.toContain("\r");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("M-6: Windows disk-wipe commands classify as catastrophic", () => {
  async function classifyPS(command: string, cwd: string) {
    return (await classifyToolAsync("bash", { command, cwd }, cwd, "powershell")).permissionClass;
  }

  it("classifies PowerShell disk cmdlets as catastrophic on any host", async () => {
    const root = makeTempDir("swarmflow-ps-disk-");
    try {
      // PS_CATASTROPHIC_COMMANDS is checked in the PowerShell path and
      // doesn't depend on host osCapabilities, so this holds wherever the
      // suite runs. catastrophic is the only class yolo still prompts on.
      expect(await classifyPS("Format-Volume -DriveLetter D -Force", root)).toBe("catastrophic");
      expect(await classifyPS("Clear-Disk -Number 1 -RemoveData -Confirm:$false", root)).toBe("catastrophic");
      expect(await classifyPS("Remove-Partition -DiskNumber 1 -PartitionNumber 2", root)).toBe("catastrophic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("H-4 (wrappers): uppercase process wrappers don't slip the gate", () => {
  const ci = osCapabilities.caseInsensitiveFilesystem;

  async function classify(command: string, cwd: string) {
    return (await classifyToolAsync("bash", { command, cwd })).permissionClass;
  }

  // Regression: case-folding used to live only inside classifyParsedCommand,
  // AFTER the case-sensitive wrapper stripping. So `ENV rm -rf ~` was never
  // unwrapped and the folded `env` landed on the SAFE branch => `read`
  // (auto-allowed in every mode) — strictly worse than the lowercase form,
  // which is `catastrophic`. Now folding happens at the wrapper boundary too.
  it.each(["env", "command", "nice", "timeout 5"])(
    "treats uppercase `%s rm -rf ~` like its lowercase form",
    async (wrapper) => {
      const root = makeTempDir("swarmflow-wrap-");
      try {
        const upper = wrapper.toUpperCase();
        const lowerCls = await classify(`${wrapper} rm -rf ~`, root);
        const upperCls = await classify(`${upper} rm -rf ~`, root);
        // Lowercase wrapper always unwraps to the catastrophic inner rm.
        expect(lowerCls).toBe("catastrophic");
        if (ci) {
          // Case-insensitive FS: uppercase must match lowercase — no bypass,
          // and crucially never the auto-allowed `read` class.
          expect(upperCls).toBe("catastrophic");
        } else {
          // Case-sensitive Linux: uppercase is a distinct (nonexistent)
          // command, so it must NOT be the fail-open `read` either.
          expect(upperCls).not.toBe("read");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("M-5 (append): edit_file append_str preserves the file's EOL", () => {
  it("appends LF content to a CRLF file without seeding mixed endings", async () => {
    const root = makeTempDir("swarmflow-append-crlf-");
    try {
      const file = join(root, "crlf.txt");
      writeFileSync(file, "alpha\r\nbeta\r\n", "utf-8");

      const result = await executeTool(
        "edit_file",
        { path: "crlf.txt", append_str: "gamma\ndelta\n" },
        { projectRoot: root },
      );
      expect(result.content).not.toMatch(/^ERROR/);

      const after = readFileSync(file, "utf-8");
      // Appended text adopts the file's CRLF; no lone-LF lines.
      expect(after).toBe("alpha\r\nbeta\r\ngamma\r\ndelta\r\n");
      expect(after).not.toMatch(/[^\r]\n/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
