/**
 * M8/D8：全局用量只读 meta.json.tokens；缺失 tokens 的会话进入"未统计"列表。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/config/session-store.js";

const tempDirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-usage-meta-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function seedSession(
  home: string,
  project: string,
  sessionId: string,
  meta: Record<string, unknown> | null,
  logContent = "{ not json",
): string {
  const dir = join(home, "projects", project, sessionId);
  mkdirSync(dir, { recursive: true });
  if (meta) writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  // 旧实现会整读日志；这里写成非法 JSON，任何整读都会失败。
  writeFileSync(join(dir, "log.json"), logContent);
  writeFileSync(join(dir, "log.jsonl"), logContent);
  return dir;
}

describe("全局用量：meta.json.tokens 单一权威源", () => {
  it("只读 meta；缺 tokens 的会话列出但不整读", () => {
    const home = makeHome();
    seedSession(home, "p1", "11111111-1111-4111-8111-111111111111", {
      session_id: "11111111-1111-4111-8111-111111111111",
      turn_count: 3,
      tokens: { input: 1000, output: 200, cacheRead: 800 },
    });
    seedSession(home, "p1", "22222222-2222-4222-8222-222222222222", {
      session_id: "22222222-2222-4222-8222-222222222222",
      turn_count: 2,
      // 没有 tokens：旧会话。
    });

    const store = new SessionStore({ baseDir: home, projectPath: "/work/demo" });
    const stats = store.computeGlobalTokenStats();
    expect(stats.cumulativeInput).toBe(1000);
    expect(stats.cumulativeOutput).toBe(200);
    expect(stats.cumulativeCacheRead).toBe(800);
    expect(stats.cumulativeUncached).toBe(200);
    expect(stats.sessionCount).toBe(1);
    expect(stats.sessionsWithoutTokens).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("tokens 全零的会话不计入，也不进未统计列表", () => {
    const home = makeHome();
    seedSession(home, "p1", "33333333-3333-4333-8333-333333333333", {
      session_id: "33333333-3333-4333-8333-333333333333",
      tokens: { input: 0, output: 0, cacheRead: 0 },
    });

    const stats = new SessionStore({ baseDir: home, projectPath: "/work/demo" }).computeGlobalTokenStats();
    expect(stats.sessionCount).toBe(0);
    expect(stats.sessionsWithoutTokens).toEqual([]);
  });

  it("meta.json 损坏：计入未统计，不读取日志", () => {
    const home = makeHome();
    const dir = seedSession(home, "p1", "44444444-4444-4444-8444-444444444444", null);
    writeFileSync(join(dir, "meta.json"), "{ broken");

    const stats = new SessionStore({ baseDir: home, projectPath: "/work/demo" }).computeGlobalTokenStats();
    expect(stats.sessionCount).toBe(0);
    expect(stats.sessionsWithoutTokens).toEqual(["44444444-4444-4444-8444-444444444444"]);
  });
});
