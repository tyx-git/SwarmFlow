/**
 * M1：封存态（meta.reasoningState）外置。
 *
 * 契约见 LOG_WRITE_DESIGN.md W-2 / 设计 §6.1：
 * - ≥ 4 KiB 的 reasoningState 写 sealed/<entryId>.json.gz；
 * - 日志里只留 { sealedRef, bytes, encoding:"gzip" }；
 * - readSealed 失败返回 null，绝不抛错打断回合。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { readGzipJson, writeGzipJson } from "./gzip-json.js";

export const SEALED_INLINE_BUDGET_BYTES = 4096;
export const SEALED_DIR = "sealed";
const SEALED_SUFFIX = ".json.gz";

export interface SealedRef {
  sealedRef: string;
  bytes: number;
  encoding: "gzip";
}

export function isSealedRef(value: unknown): value is SealedRef {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["sealedRef"] === "string" &&
    typeof (value as Record<string, unknown>)["bytes"] === "number" &&
    (value as Record<string, unknown>)["encoding"] === "gzip",
  );
}

function sealedFileName(entryId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(entryId)) {
    throw new Error(`Unsafe entry id for sealed sidecar: ${entryId}`);
  }
  return `${entryId}${SEALED_SUFFIX}`;
}

/** 超预算则写 sidecar 并返回引用；未超预算/失败返回 undefined（保持内联）。 */
export function maybeExternalizeReasoning(
  sessionDir: string,
  entryId: string,
  value: unknown,
): SealedRef | undefined {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes < SEALED_INLINE_BUDGET_BYTES) return undefined;

  const sealedDir = join(sessionDir, SEALED_DIR);
  const fileName = sealedFileName(entryId);
  const target = join(sealedDir, fileName);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(sealedDir, { recursive: true });
    writeGzipJson(tmp, value);
    renameSync(tmp, target);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return undefined;
  }
  return { sealedRef: `${SEALED_DIR}/${fileName}`, bytes, encoding: "gzip" };
}

/** 读取 sidecar；任何失败返回 null。 */
export function readSealed(sessionDir: string, ref: SealedRef): unknown | null {
  const relativePath = ref.sealedRef.replace(/\\/g, "/");
  if (!relativePath.startsWith(`${SEALED_DIR}/`)) return null;
  const sealedDir = resolve(sessionDir, SEALED_DIR);
  const target = resolve(sessionDir, relativePath);
  if (target !== sealedDir && !target.startsWith(`${sealedDir}${sep}`)) return null;
  try {
    return readGzipJson<unknown>(target);
  } catch {
    return null;
  }
}

/** 日志里现存引用集合（供诊断/清理用）。 */
export function collectSealedRefs(entries: readonly { meta: Record<string, unknown> }[]): Set<string> {
  const refs = new Set<string>();
  for (const entry of entries) {
    const state = entry.meta?.["reasoningState"];
    if (isSealedRef(state)) refs.add(state.sealedRef);
  }
  return refs;
}

/** 删除不在 live id 集合中的 sidecar；返回删除数。 */
export function pruneSealed(sessionDir: string, live: ReadonlySet<string>): number {
  const sealedDir = join(sessionDir, SEALED_DIR);
  if (!existsSync(sealedDir)) return 0;
  let removed = 0;
  for (const name of readdirSync(sealedDir)) {
    if (!name.endsWith(SEALED_SUFFIX)) continue;
    const entryId = name.slice(0, -SEALED_SUFFIX.length);
    if (live.has(entryId)) continue;
    try {
      rmSync(join(sealedDir, name), { force: true });
      removed += 1;
    } catch {
      // best effort
    }
  }
  return removed;
}
