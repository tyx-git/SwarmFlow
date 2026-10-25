/**
 * P-6/R-1：会话列表的体积只统计已知类别，不递归 artifacts/。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { listSessionsForProject } from "../../src/session/resume.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-dir-size-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf-8");
}

describe("会话体积统计", () => {
  it("只统计日志/meta/索引/归档/图片/封存态，不递归 artifacts", () => {
    const projectDir = makeDir();
    const sessionDir = join(projectDir, randomUUID());
    mkdirSync(sessionDir, { recursive: true });

    const meta = JSON.stringify({
      session_id: "s-1",
      created_at: "2026-10-20T00:00:00.000Z",
      last_active_at: "2026-10-21T00:00:00.000Z",
      summary: "size probe",
      turn_count: 1,
    });
    write(join(sessionDir, "meta.json"), meta);
    write(join(sessionDir, "log.jsonl"), "a".repeat(100));
    write(join(sessionDir, "log.index.jsonl"), "b".repeat(40));
    write(join(sessionDir, "log.json.pre-v4.bak"), "c".repeat(25));
    write(join(sessionDir, "archive", "window-0.json.gz"), "d".repeat(50));
    write(join(sessionDir, "archive", "window-0.index.json.gz"), "e".repeat(15));
    write(join(sessionDir, "images", "img-1.png"), "f".repeat(30));
    write(join(sessionDir, "sealed", "r-1.json.gz"), "g".repeat(20));
    write(join(sessionDir, "artifacts", "rewind-journal.json.data-x", "big.bin"), "x".repeat(2_000_000));
    write(join(sessionDir, "artifacts", "agents", "a", "large.txt"), "y".repeat(2_000_000));

    const expected =
      statSync(join(sessionDir, "meta.json")).size
      + statSync(join(sessionDir, "log.jsonl")).size
      + statSync(join(sessionDir, "log.index.jsonl")).size
      + statSync(join(sessionDir, "log.json.pre-v4.bak")).size
      + statSync(join(sessionDir, "archive", "window-0.json.gz")).size
      + statSync(join(sessionDir, "archive", "window-0.index.json.gz")).size
      + statSync(join(sessionDir, "images", "img-1.png")).size
      + statSync(join(sessionDir, "sealed", "r-1.json.gz")).size;

    const [session] = listSessionsForProject(projectDir);
    expect(session?.sizeBytes).toBe(expected);

    // 负向探针：再塞一个大 artifact，体积不变。
    write(join(sessionDir, "artifacts", "agents", "a", "more.bin"), "z".repeat(1_500_000));
    expect(listSessionsForProject(projectDir)[0]?.sizeBytes).toBe(expected);
  });
});
