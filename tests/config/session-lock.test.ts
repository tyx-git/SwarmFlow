/**
 * 会话单写者锁：现在由内核对象承载（Windows 命名管道 / POSIX unix socket）。
 *
 * 期望值来自锁的契约（不来自实现）：
 * - 目录里不再有任何锁文件，新会话目录唯一，创建时不预占；
 * - 同一进程同一 token 可重入，不同 token 视为占用；
 * - 占用判定看内核对象是否存在，进程被强杀后锁自动消失，不需要陈旧判定。
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SessionStore } from "../../src/config/session-store.js";
import { acquireSessionLock, releaseSessionLock } from "../../src/config/session-lock.js";
import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { forkSessionDirectory } from "../../src/server/session-fork.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-session-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const baseDir of tempDirs.splice(0)) releaseAllThenRemove(baseDir);
});

/** 清目录前先按路径释放可能残留的锁，避免内核对象把临时目录占住。 */
function releaseAllThenRemove(dir: string): void {
  for (const token of ["store-0", "store-1", "parent", "child", "fork"]) {
    releaseSessionLock(dir, token);
  }
  rmSync(dir, { recursive: true, force: true });
}

const LOCK_MODULE = JSON.stringify(
  resolve("src/config/session-lock.ts").replace(/\\/g, "/"),
);

/** 子进程：拿锁成功就打印 LOCKED 并挂住；失败打印 BUSY 退出。 */
function spawnLockHolder(dir: string): ChildProcess {
  const script = `
    const { acquireSessionLock } = await import("file:///${LOCK_MODULE.slice(1, -1)}");
    const lock = await acquireSessionLock(${JSON.stringify(dir)}, "child");
    console.log(lock.ok ? "LOCKED" : "BUSY");
    if (lock.ok) setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitForLine(child: ChildProcess, expected: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not print ${expected}`)), timeoutMs);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      if (!buffer.includes(expected)) return;
      clearTimeout(timer);
      resolvePromise();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`child exited before printing ${expected}: ${buffer}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) resolvePromise();
    else child.once("exit", () => resolvePromise());
  });
}

describe("会话写锁", () => {
  it("createSession 不落锁文件，也不预占管道", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });

    const sessionDir = store.createSession();

    expect(existsSync(join(sessionDir, "log.jsonl.lock"))).toBe(false);
    expect(store.holdsSessionLock(sessionDir)).toBe(false);
  });

  it("同一 store 重复获取幂等，另一个 token 判占用，释放后可再获取", async () => {
    const dir = makeDir();

    expect((await acquireSessionLock(dir, "parent")).ok).toBe(true);
    expect((await acquireSessionLock(dir, "parent")).ok).toBe(true);
    expect((await acquireSessionLock(dir, "child")).ok).toBe(false);

    releaseSessionLock(dir, "parent");
    expect((await acquireSessionLock(dir, "child")).ok).toBe(true);
    releaseSessionLock(dir, "child");
  });

  it("释放后立刻重取不会撞上关闭中的句柄", async () => {
    const dir = makeDir();

    for (let round = 0; round < 3; round += 1) {
      expect((await acquireSessionLock(dir, "parent")).ok).toBe(true);
      releaseSessionLock(dir, "parent");
    }
  });

  it("不同目录互不影响", async () => {
    const first = makeDir();
    const second = makeDir();

    expect((await acquireSessionLock(first, "parent")).ok).toBe(true);
    expect((await acquireSessionLock(second, "child")).ok).toBe(true);

    releaseSessionLock(first, "parent");
    releaseSessionLock(second, "child");
  });

  it("另一个进程持锁时判占用", async () => {
    const dir = makeDir();
    const child = spawnLockHolder(dir);
    await waitForLine(child, "LOCKED");

    expect((await acquireSessionLock(dir, "parent")).ok).toBe(false);

    child.kill();
    await waitForExit(child);
  }, 30_000);

  it("持锁进程被强杀后锁自动消失", async () => {
    const dir = makeDir();
    const child = spawnLockHolder(dir);
    await waitForLine(child, "LOCKED");
    expect((await acquireSessionLock(dir, "parent")).ok).toBe(false);

    // kill() 在 Windows 上是 TerminateProcess：不给子进程任何清理机会。
    child.kill();
    await waitForExit(child);

    expect((await acquireSessionLock(dir, "parent")).ok).toBe(true);
    releaseSessionLock(dir, "parent");
  }, 30_000);

  it("fork 出的新目录不继承父会话的锁", async () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });
    const sessionDir = store.createSession();
    await store.acquireSessionLock(sessionDir);
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

    expect((await acquireSessionLock(forked.sessionDir, "fork")).ok).toBe(true);
    expect((await acquireSessionLock(sessionDir, "child")).ok).toBe(false);

    releaseSessionLock(forked.sessionDir, "fork");
    store.releaseSessionLock(sessionDir);
  });
});
