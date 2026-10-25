/**
 * 运行期切到 log.jsonl 后，选择器/用量统计仍能读取新格式。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { LOG_JSONL_VERSION, appendRecords, type SessionRecord } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta, saveSessionMeta } from "../../src/config/session-meta.js";
import { SessionStore } from "../../src/config/session-store.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-jsonl-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("SessionStore 读取 JSONL 会话", () => {
  it("meta.json 缺失时用 header 列出会话", () => {
    const home = makeDir();
    const store = new SessionStore({ baseDir: home, projectPath: "/work/demo" });
    const dir = store.createSession();
    const sessionId = basename(dir);
    const header: SessionRecord = {
      v: LOG_JSONL_VERSION,
      op: "session",
      seq: 1,
      ts: "2026-10-23T00:00:00.000Z",
      session: {
        session_id: sessionId,
        created_at: "2026-10-23T00:00:00Z",
        updated_at: "2026-10-23T00:00:00Z",
        project_path: "/work/demo",
        model_config_name: "test-model",
        summary: "jsonl summary",
        title: "JSONL session",
        turn_count: 2,
        compact_count: 0,
        thinking_level: "medium",
      },
    };
    appendRecords(dir, [header]);

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId,
      title: "JSONL session",
      summary: "jsonl summary",
      turns: 2,
    });
  });

  it("用量统计只读 meta.json.tokens；日志写成非法 JSON 也不受影响", () => {
    const home = makeDir();
    const store = new SessionStore({ baseDir: home, projectPath: "/work/demo" });
    const dir = store.createSession();
    const sessionId = basename(dir);
    saveSessionMeta(dir, createLogSessionMeta({
      sessionId,
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
      projectPath: "/work/demo",
      modelConfigName: "test-model",
      summary: "",
      turnCount: 1,
      compactCount: 0,
      thinkingLevel: "medium",
      tokens: { input: 10, output: 5, cacheRead: 2 },
    }));
    // 整读日志的旧实现会在这里崩掉；新实现只读 meta。
    writeFileSync(join(dir, "log.jsonl"), "{ not json");
    writeFileSync(join(dir, "log.json"), "also not json");

    const stats = store.computeGlobalTokenStats();
    expect(stats).toEqual({
      cumulativeInput: 10,
      cumulativeOutput: 5,
      cumulativeCacheRead: 2,
      cumulativeUncached: 8,
      sessionCount: 1,
      sessionsWithoutTokens: [],
    });
  });
});
