/**
 * 存储布局的寻址原语：项目 slug、基础目录、会话 ID 的生成与识别。
 */

import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { getSwarmflowHomeDir } from "./home-dir.js";

/**
 * 生成项目路径的 slug 格式：<name>_<sha256前6位>。
 *
 * 先解析成绝对路径，避免 `.`、`a/..`、末尾分隔符等写法产生不同的项目目录。
 * Windows 上不同大小写盘符仍会产生不同 slug；这是历史既有行为，改动会让
 * 已有会话失联，故不做大小写折叠。
 */
export function projectSlug(projectPath: string): string {
  const absolute = resolve(projectPath);
  const name = basename(absolute) || "root";
  const h = createHash("sha256").update(absolute).digest("hex").slice(0, 6);
  return `${name}_${h}`;
}
/** 解析首选基础目录，将 ~ 替换为用户主目录 */
export function resolvePreferredBaseDir(baseDir?: string): string {
  if (baseDir) return baseDir.replace(/^~/, homedir());
  return getSwarmflowHomeDir();
}
/**
 * 生成 UUIDv7——48 位毫秒时间戳（大端序）+ 版本号 + 随机数。
 * 时间有序，使得字典序和时间顺序一致，用作会话目录名（同时作为会话 ID）。
 */
export function randomSessionId(): string {
  const ts = BigInt(Date.now());
  const buf = new Uint8Array(16);
  buf[0] = Number((ts >> 40n) & 0xffn);
  buf[1] = Number((ts >> 32n) & 0xffn);
  buf[2] = Number((ts >> 24n) & 0xffn);
  buf[3] = Number((ts >> 16n) & 0xffn);
  buf[4] = Number((ts >> 8n) & 0xffn);
  buf[5] = Number(ts & 0xffn);
  const rand = randomBytes(10);
  buf.set(rand, 6);
  buf[6] = (buf[6]! & 0x0f) | 0x70; // version 7
  buf[8] = (buf[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUID 格式的会话 ID 正则表达式 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 检查字符串是否看起来像会话 ID */
export function looksLikeSessionId(name: string): boolean {
  return SESSION_ID_RE.test(name);
}
