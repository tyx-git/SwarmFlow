/**
 * D13：fork 后清理从父会话继承的 rewind 崩溃恢复产物。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discardRewindArtifacts } from "../../src/session/rewind/artifacts.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-rewind-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("discardRewindArtifacts", () => {
  it("删除 journal 与所有 .data-*，保留无关文件", () => {
    const dir = makeDir();
    const journal = join(dir, "rewind-journal.json");
    const backupDir = join(dir, "rewind-journal.json.data-a");
    const backupFile = join(dir, "rewind-journal.json.data-b");
    writeFileSync(journal, "{}", "utf-8");
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, "0"), "pre", "utf-8");
    writeFileSync(backupFile, "pre", "utf-8");
    writeFileSync(join(dir, "tasks.json"), "[]", "utf-8");
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "rewind-journal.json"), "keep", "utf-8");

    discardRewindArtifacts(dir);

    expect(existsSync(journal)).toBe(false);
    expect(existsSync(backupDir)).toBe(false);
    expect(existsSync(backupFile)).toBe(false);
    expect(existsSync(join(dir, "tasks.json"))).toBe(true);
    expect(existsSync(join(dir, "agents", "rewind-journal.json"))).toBe(true);
  });

  it("目录不存在时静默返回", () => {
    const dir = join(makeDir(), "missing");
    expect(() => discardRewindArtifacts(dir)).not.toThrow();
  });
});
