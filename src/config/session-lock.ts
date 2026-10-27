/**
 * 会话单写者锁：持有的是内核对象，不是 PID 记录。
 *
 * Windows 用命名管道、POSIX 用 unix socket：进程退出（含崩溃、被强杀）时内核
 * 自动回收，因此不存在"陈旧锁 + PID 被复用后永远判活"的问题，也不再落任何
 * 锁文件。同一进程内按目录路径 + token 幂等，方便 SessionStore 重复调用。
 */

import { createHash } from "node:crypto";
import { createServer, connect, type Server } from "node:net";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export type AcquireSessionLockResult = { ok: true } | { ok: false };

interface HeldLock {
  token: string;
  server: Server;
  /** 仅 POSIX：unix socket 文件路径，释放时要删掉。 */
  socketFile?: string;
}

const held = new Map<string, HeldLock>();
const closing = new Map<string, Promise<void>>();

/** 锁身份按规范化后的目录路径算：大小写/分隔符不同视为同一会话。 */
function lockKey(sessionDir: string): string {
  return resolve(sessionDir).replace(/\\/g, "/").toLowerCase();
}

function endpointForKey(key: string): { target: string; socketFile?: string } {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 32);
  if (process.platform === "win32") {
    return { target: `\\\\.\\pipe\\swarmflow-session-${id}` };
  }
  const socketFile = join(tmpdir(), `swarmflow-session-${id}.sock`);
  return { target: socketFile, socketFile };
}

function listenOn(server: Server, target: string): Promise<boolean> {
  return new Promise((resolveListen) => {
    const settle = (ok: boolean) => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      resolveListen(ok);
    };
    const onError = () => settle(false);
    const onListening = () => settle(true);
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(target);
  });
}

/** POSIX：socket 文件是否真有监听者（崩溃残留的文件连不上）。 */
function socketAlive(socketFile: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect(socketFile);
    const done = (alive: boolean) => {
      socket.destroy();
      resolveProbe(alive);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function openListener(target: string, socketFile?: string): Promise<Server | null> {
  for (let attempt = 0; ; attempt += 1) {
    const server = createServer((socket) => socket.destroy());
    // listen 失败由 listenOn 的 once 处理；监听成功后的偶发错误不该拖垮进程。
    server.on("error", () => { /* 归属已确定，忽略 */ });
    if (await listenOn(server, target)) {
      // 占位靠句柄本身，不该把它算作"还有活要干"而阻止进程退出。
      server.unref();
      return server;
    }
    if (!socketFile || attempt > 0 || await socketAlive(socketFile)) {
      server.close();
      return null;
    }
    try {
      unlinkSync(socketFile);
    } catch {
      // 别的进程刚清掉；直接重试。
    }
  }
}

/** 尝试获取单写者锁；同一 token 可重入。 */
export async function acquireSessionLock(
  sessionDir: string,
  token: string,
): Promise<AcquireSessionLockResult> {
  const key = lockKey(sessionDir);
  const existing = held.get(key);
  if (existing) return existing.token === token ? { ok: true } : { ok: false };

  const pending = closing.get(key);
  if (pending) await pending;

  const endpoint = endpointForKey(key);
  const server = await openListener(endpoint.target, endpoint.socketFile);
  if (!server) return { ok: false };

  held.set(key, { token, server, socketFile: endpoint.socketFile });
  return { ok: true };
}

/** 释放自己持有的锁；不碰他人的锁。 */
export function releaseSessionLock(sessionDir: string, token: string): void {
  const key = lockKey(sessionDir);
  const entry = held.get(key);
  if (!entry || entry.token !== token) return;
  held.delete(key);

  const done = new Promise<void>((resolveClose) => entry.server.close(() => resolveClose()));
  closing.set(key, done);
  void done.then(() => {
    if (closing.get(key) === done) closing.delete(key);
  });

  if (entry.socketFile) {
    try {
      unlinkSync(entry.socketFile);
    } catch {
      // best effort
    }
  }
}
