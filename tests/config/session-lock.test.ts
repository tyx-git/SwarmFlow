/**
 * W4.2：log.jsonl.lock 单写者锁。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/config/session-store.js";
import {
  SESSION_LOCK_FILENAME,
  forceReleaseSessionLock,
  readSessionLock,
} from "../../src/config/session-lock.js";
import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { forkSessionDirectory } from "../../src/server/session-fork.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-session-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("会话写锁", () => {
  it("createSession 获取锁，release 后删除", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });
    const sessionDir = store.createSession();
    const lockPath = join(sessionDir, SESSION_LOCK_FILENAME);

    expect(existsSync(lockPath)).toBe(true);
    expect(store.holdsSessionLock(sessionDir)).toBe(true);
    expect(readSessionLock(sessionDir)?.pid).toBe(process.pid);

    store.releaseSessionLock(sessionDir);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("第二个 store 获取同一目录失败；前一个释放后可获取", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const first = new SessionStore({ baseDir, projectPath: projectRoot });
    const sessionDir = first.createSession();
    const second = new SessionStore({ baseDir, projectPath: projectRoot });

    const blocked = second.acquireSessionLock(sessionDir);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.ownerPid).toBe(process.pid);

    first.releaseSessionLock(sessionDir);
    expect(second.acquireSessionLock(sessionDir).ok).toBe(true);
    second.releaseSessionLock(sessionDir);
  });

  it("陈旧锁（pid 不存活）可被接管", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });
    const sessionDir = store.createSession();
    store.releaseSessionLock(sessionDir);
    writeFileSync(join(sessionDir, SESSION_LOCK_FILENAME), JSON.stringify({
      pid: 999_999,
      token: "stale",
      created_at: "2026-01-01T00:00:00.000Z",
    }), "utf-8");

    expect(store.acquireSessionLock(sessionDir).ok).toBe(true);
    expect(readSessionLock(sessionDir)?.token).not.toBe("stale");
    store.releaseSessionLock(sessionDir);
  });

  it("release 不删除他人的锁", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });
    const sessionDir = store.createSession();
    writeFileSync(join(sessionDir, SESSION_LOCK_FILENAME), JSON.stringify({
      pid: process.pid,
      token: "foreign",
      created_at: "2026-01-01T00:00:00.000Z",
    }), "utf-8");

    store.releaseSessionLock(sessionDir);
    expect(existsSync(join(sessionDir, SESSION_LOCK_FILENAME))).toBe(true);
    forceReleaseSessionLock(sessionDir);
  });

  it("fork 不继承父会话的锁", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });
    const sessionDir = store.createSession();
    writeLogJsonlSnapshot(sessionDir, createLogSessionMeta({
      sessionId: "s-lock",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
      projectPath: projectRoot,
      modelConfigName: "test",
      summary: "",
      turnCount: 1,
      compactCount: 0,
      thinkingLevel: "off",
    }), []);

    const forked = forkSessionDirectory(sessionDir);
    expect(existsSync(join(forked.sessionDir, SESSION_LOCK_FILENAME))).toBe(false);
    expect(existsSync(join(sessionDir, SESSION_LOCK_FILENAME))).toBe(true);
    store.releaseSessionLock(sessionDir);
  });
});
