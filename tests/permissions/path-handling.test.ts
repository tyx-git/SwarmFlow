/**
 * Regression coverage for cross-platform command classification:
 *   - H-4: on case-insensitive filesystems (default macOS, Windows Git
 *          Bash) an uppercase danger command (RM, SUDO) must classify
 *          the same as its lowercase form, instead of slipping past the
 *          danger/catastrophic gate. On case-sensitive Linux the
 *          original casing is preserved (RM is a distinct file).
 *
 * The H-4 assertions are gated on osCapabilities.caseInsensitiveFilesystem
 * so the suite is correct regardless of which OS runs it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyToolAsync } from "../../src/permissions/index.js";
import { osCapabilities } from "../../src/platform/index.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
