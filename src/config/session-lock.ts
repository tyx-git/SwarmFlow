/**
 * 会话单写者锁：`<sessionDir>/log.jsonl.lock`。
 *
 * 锁文件记录持有者 pid 与随机 token。第二个进程/实例打开同一会话时失败；
 * 进程崩溃留下的陈旧锁（pid 不存活）可被下一次打开接管。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_LOCK_FILENAME = "log.jsonl.lock";

export interface SessionLockInfo {
  pid: number;
  token: string;
  created_at: string;
}

export type AcquireSessionLockResult =
  | { ok: true }
  | { ok: false; ownerPid?: number };

function lockFile(dir: string): string {
  return join(dir, SESSION_LOCK_FILENAME);
}

function readLock(dir: string): SessionLockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(lockFile(dir), "utf-8")) as Partial<SessionLockInfo>;
    if (
      typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0
      || typeof raw.token !== "string" || raw.token.length === 0
    ) {
      return null;
    }
    return {
      pid: raw.pid,
      token: raw.token,
      created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号；ESRCH = 已退出。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读取当前锁持有者（诊断/测试用）。 */
export function readSessionLock(dir: string): SessionLockInfo | null {
  return readLock(dir);
}

/** 尝试获取单写者锁；同一 token 可重入。 */
export function acquireSessionLock(dir: string, token: string): AcquireSessionLockResult {
  const path = lockFile(dir);
  const info: SessionLockInfo = {
    pid: process.pid,
    token,
    created_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify(info), { encoding: "utf-8", flag: "wx" });
      // 极小概率下并发接管者覆盖了刚写入的文件；以文件内容为准。
      return readLock(dir)?.token === token ? { ok: true } : { ok: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false };
    }

    const existing = readLock(dir);
    if (existing?.token === token) return { ok: true };
    if (existing && isProcessAlive(existing.pid)) {
      return { ok: false, ownerPid: existing.pid };
    }
    // 陈旧/损坏的锁：删除后重试一次。
    try {
      rmSync(path, { force: true });
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

/** 释放自己持有的锁；不删除他人的锁。 */
export function releaseSessionLock(dir: string, token: string): void {
  const existing = readLock(dir);
  if (!existing || existing.pid !== process.pid || existing.token !== token) return;
  try {
    rmSync(lockFile(dir), { force: true });
  } catch {
    // best effort
  }
}

/** 无条件删除锁（fork 复制后的新目录用）。 */
export function forceReleaseSessionLock(dir: string): void {
  try {
    rmSync(lockFile(dir), { force: true });
  } catch {
    // best effort
  }
}

export function hasSessionLock(dir: string): boolean {
  return existsSync(lockFile(dir));
}
