/**
 * I4.1：SessionStore.listSessions 与 listSessionsForProject 必须逐项相等。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { SessionStore } from "../../src/config/session-store.js";
import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { listSessionsForProject } from "../../src/session/resume.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-list-parity-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function meta(turnCount: number) {
  return createLogSessionMeta({
    sessionId: randomUUID(),
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    projectPath: "/work/demo",
    modelConfigName: "test",
    summary: "summary",
    title: "title",
    turnCount,
    compactCount: 0,
    thinkingLevel: "off",
  });
}

describe("会话列表单一映射", () => {
  it("SessionStore 与 listSessionsForProject 返回一致", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });
    const created = store.createSession();
    const projectDir = dirname(created);

    // meta.json 路径
    const withMeta = join(projectDir, randomUUID());
    mkdirSync(withMeta, { recursive: true });
    writeFileSync(join(withMeta, "meta.json"), JSON.stringify({
      session_id: "meta-session",
      created_at: "2026-10-20T00:00:00.000Z",
      last_active_at: "2026-10-21T00:00:00.000Z",
      summary: "meta summary",
      title: "Meta",
      turn_count: 2,
    }), "utf-8");

    // JSONL header 路径
    const withJsonl = join(projectDir, randomUUID());
    writeLogJsonlSnapshot(withJsonl, meta(3), []);

    // legacy header 路径
    const withLegacy = join(projectDir, randomUUID());
    mkdirSync(withLegacy, { recursive: true });
    writeFileSync(join(withLegacy, "log.json"), JSON.stringify({
      version: 3,
      session_id: "legacy-session",
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-21T00:00:00.000Z",
      summary: "legacy summary",
      title: "Legacy",
      turn_count: 4,
      archived: false,
      entries: [],
    }), "utf-8");

    expect(store.listSessions()).toEqual(listSessionsForProject(projectDir));
  });
});
