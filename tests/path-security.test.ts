import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { SafePathError, safePath } from "../src/security/path.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function expectSafePathError(
  fn: () => unknown,
  code: SafePathError["code"],
): SafePathError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SafePathError);
    expect((e as SafePathError).code).toBe(code);
    return e as SafePathError;
  }
  throw new Error(`Expected SafePathError(${code}) but no error was thrown`);
}

describe("safePath", () => {
  it("allows existing files within the base directory", () => {
    const root = makeTempDir("swarmflow-safe-path-");
    try {
      const file = join(root, "ok.txt");
      writeFileSync(file, "ok\n", "utf-8");

      const result = safePath({
        baseDir: root,
        requestedPath: "ok.txt",
        cwd: root,
        mustExist: true,
        expectFile: true,
        accessKind: "read",
      });

      expect(result.decision).toBe("allow");
      expect(result.safePath).toBe(file);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows creating a new file within the base directory", () => {
    const root = makeTempDir("swarmflow-safe-create-");
    try {
      mkdirSync(join(root, "nested"), { recursive: true });

      const result = safePath({
        baseDir: root,
        requestedPath: "nested/new.txt",
        cwd: root,
        allowCreate: true,
        expectFile: true,
        accessKind: "write",
      });

      expect(result.decision).toBe("allow");
      expect(result.safePath).toBe(join(root, "nested", "new.txt"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects lexical traversal outside the base directory", () => {
    const root = makeTempDir("swarmflow-safe-traversal-");
    try {
      expectSafePathError(
        () =>
          safePath({
            baseDir: root,
            requestedPath: "../secret.txt",
            cwd: root,
            allowCreate: true,
            accessKind: "write",
          }),
        "PATH_OUTSIDE_SCOPE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths outside the base directory", () => {
    const root = makeTempDir("swarmflow-safe-abs-");
    const external = makeTempDir("swarmflow-safe-abs-ext-");
    try {
      const outside = join(external, "secret.txt");
      expectSafePathError(
        () =>
          safePath({
            baseDir: root,
            requestedPath: outside,
            cwd: root,
            allowCreate: true,
            accessKind: "write",
          }),
        "PATH_OUTSIDE_SCOPE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("rejects prefix-collision siblings (e.g. proj vs proj-other)", () => {
    const parent = makeTempDir("swarmflow-safe-prefix-parent-");
    const root = join(parent, "proj");
    const sibling = join(parent, "proj-other");
    mkdirSync(root, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    try {
      const outside = join(sibling, "a.txt");
      expectSafePathError(
        () =>
          safePath({
            baseDir: root,
            requestedPath: outside,
            cwd: root,
            allowCreate: true,
            accessKind: "write",
          }),
        "PATH_OUTSIDE_SCOPE",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects file/dir type mismatches", () => {
    const root = makeTempDir("swarmflow-safe-type-");
    try {
      const dir = join(root, "d");
      const file = join(root, "f.txt");
      mkdirSync(dir);
      writeFileSync(file, "x", "utf-8");

      expectSafePathError(
        () =>
          safePath({
            baseDir: root,
            requestedPath: "d",
            cwd: root,
            mustExist: true,
            expectFile: true,
            accessKind: "read",
          }),
        "PATH_NOT_FILE",
      );

      expectSafePathError(
        () =>
          safePath({
            baseDir: root,
            requestedPath: "f.txt",
            cwd: root,
            mustExist: true,
            expectDirectory: true,
            accessKind: "list",
          }),
        "PATH_NOT_DIRECTORY",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes for existing files and create paths", () => {
    const root = makeTempDir("swarmflow-safe-symlink-");
    const external = makeTempDir("swarmflow-safe-symlink-ext-");
    try {
      writeFileSync(join(external, "secret.txt"), "secret\n", "utf-8");
      const linkDir = join(root, "link");
      try {
        symlinkSync(external, linkDir, "dir");
      } catch (e: any) {
        if (e?.code === "EPERM" || e?.code === "EACCES") {
          return;
        }
        throw e;
      }

      expectSafePathError(
        () =>
          safePath({
            baseDir: root,
            requestedPath: "link/secret.txt",
            cwd: root,
            mustExist: true,
            expectFile: true,
            accessKind: "read",
          }),
        "PATH_SYMLINK_ESCAPES_SCOPE",
      );

      expectSafePathError(
        () =>
          safePath({
            baseDir: root,
            requestedPath: "link/new.txt",
            cwd: root,
            allowCreate: true,
            expectFile: true,
            accessKind: "write",
          }),
        "PATH_SYMLINK_ESCAPES_SCOPE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
