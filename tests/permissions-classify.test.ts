import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyToolAsync } from "../src/permissions/index.js";

function makeFixture(): string {
  const root = join(tmpdir(), `swarmflow-permissions-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a"), "a\n", "utf-8");
  writeFileSync(join(root, "b"), "b\n", "utf-8");
  mkdirSync(join(root, "target"), { recursive: true });
  mkdirSync(join(root, "out dir"), { recursive: true });
  return root;
}

async function classifyBash(command: string, cwd: string) {
  return classifyToolAsync("bash", { command, cwd });
}

describe("bash permission classification for trackable cp/mv rewind", () => {
  it("keeps a simple single-source copy to a new target reversible", async () => {
    const root = makeFixture();
    try {
      const result = await classifyBash("cp a missing", root);
      expect(result.permissionClass).toBe("write_reversible");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses bash cwd when upgrading cp/mv targets that are existing directories", async () => {
    const root = makeFixture();
    try {
      const result = await classifyBash("cp a target", root);
      expect(result.permissionClass).toBe("write_potent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks later cp/mv segments in compound commands", async () => {
    const root = makeFixture();
    try {
      const cases = [
        "cp a missing && cp b target",
        "cp a missing && mv b target",
        "cp a missing && cp -t target b",
        "cp a missing && cp b c target",
        "cp a missing && cp --parents b target",
      ];

      for (const command of cases) {
        const result = await classifyBash(command, root);
        expect(result.permissionClass, command).toBe("write_potent");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades unsupported cp target-directory flag forms", async () => {
    const root = makeFixture();
    try {
      const cases = [
        "cp -t target a",
        "cp -rt target a",
        "cp -R -t target a",
        "cp --target-directory=target a",
      ];

      for (const command of cases) {
        const result = await classifyBash(command, root);
        expect(result.permissionClass, command).toBe("write_potent");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("redirect over compound commands keeps memoization", () => {
  it("preserves canonicalPattern for `cd <root> && cmd 2>&1`", async () => {
    const root = makeFixture();
    try {
      const result = await classifyBash(`cd ${root} && npm install 2>&1`, root);
      expect(result.canMemoize).toBe(true);
      expect(result.canonicalPattern).toBe("npm install");
      expect(result.externalCwd).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches behavior with and without trailing fd-redirect", async () => {
    const root = makeFixture();
    try {
      const plain = await classifyBash(`cd ${root} && npm install`, root);
      const piped = await classifyBash(`cd ${root} && npm install 2>&1`, root);
      expect(piped.canMemoize).toBe(plain.canMemoize);
      expect(piped.canonicalPattern).toBe(plain.canonicalPattern);
      expect(piped.permissionClass).toBe(plain.permissionClass);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches file-write redirect to the trailing command in a list", async () => {
    const root = makeFixture();
    try {
      // `echo hi > out.txt` alone is write_potent due to file write; chained
      // after a safe `cd`, the redirect still has to land on the npm segment
      // so the overall class isn't downgraded.
      const result = await classifyBash(`cd ${root} && echo hi > out.txt`, root);
      expect(result.permissionClass).toBe("write_potent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
