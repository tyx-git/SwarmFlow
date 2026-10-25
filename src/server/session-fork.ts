/**
 * `session.fork`：把源会话目录复制成一个新的独立会话目录。
 */

import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { randomSessionId } from "../config/storage-layout.js";
import { buildLogHead, sessionMetaFromSnake } from "../config/log-codec.js";
import { parseRecordLine, readLogHeader, serializeRecord } from "../config/log-jsonl.js";
import { discardRewindArtifacts } from "../session/rewind/artifacts.js";
import { forceReleaseSessionLock } from "../config/session-lock.js";

import type { ForkSessionPayload } from "./session-status-payloads.js";

export function forkSessionDirectory(
  sourceDir: string,
  opts?: { inheritPromptCacheKey?: boolean },
): ForkSessionPayload {
  if (!existsSync(join(sourceDir, "log.json")) && !existsSync(join(sourceDir, "log.jsonl"))) {
    throw new Error("session.fork: cannot fork an empty session");
  }

  const projectDir = dirname(sourceDir);
  const sourceSessionId = basename(sourceDir);
  let newSessionId = randomSessionId();
  let newDir = join(projectDir, newSessionId);
  for (let attempt = 0; existsSync(newDir) && attempt < 8; attempt += 1) {
    newSessionId = randomSessionId();
    newDir = join(projectDir, newSessionId);
  }
  if (existsSync(newDir)) {
    throw new Error("session.fork: failed to allocate a unique session directory");
  }

  try {
    cpSync(sourceDir, newDir, { recursive: true, errorOnExist: true });
  } catch (err) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`session.fork: copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // fork 不应继承父会话的崩溃恢复事务与写锁。
  discardRewindArtifacts(join(newDir, "artifacts"));
  forceReleaseSessionLock(newDir);

  try {
    const nowIso = new Date().toISOString();
    const metaPath = join(newDir, "meta.json");
    const logPath = join(newDir, "log.json");
    const jsonlPath = join(newDir, "log.jsonl");
    const hasJsonl = existsSync(jsonlPath);
    const hasJson = existsSync(logPath);
    const header = hasJsonl ? readLogHeader(newDir) : undefined;
    const logData = hasJson ? readJsonRecord(logPath) : undefined;
    // 首次快照与 meta.json 之间存在崩溃窗口：meta 缺失时从日志头重建完整元数据，
    // 否则 fork 会因 turn_count 缺失而从会话列表消失。
    const metaExists = existsSync(metaPath);
    const meta: Record<string, unknown> = metaExists
      ? readJsonRecord(metaPath)
      : header
        ? { ...buildLogHead(header), last_active_at: header.updatedAt }
        : logData
          ? { ...buildLogHead(sessionMetaFromSnake(logData)), last_active_at: (logData.updated_at as string) ?? "" }
          : {};
    if (!metaExists) delete meta.updated_at;
    const sourceTitle = firstString(
      meta.title,
      header?.title,
      logData?.title,
      meta.summary,
      logData?.summary,
    );
    const sourceCacheKey = firstString(
      header?.promptCacheAffinityKey,
      logData?.prompt_cache_affinity_key,
      meta.prompt_cache_affinity_key,
    );
    /**
     * fork 的 prompt cache key 策略：
     * - 默认路由隔离（新随机 key）：适合长期并行开发。两个分支各自
     *   演进时不应互相挤占 provider 的缓存分区。
     * - inheritPromptCacheKey：适合轻量级探索/短期实验。分支直接复用
     *   父会话的前缀缓存，降低首轮重放成本。
     */
    const forkedCacheKey = opts?.inheritPromptCacheKey && sourceCacheKey
      ? sourceCacheKey
      : randomSessionId();
    const branchTitle = sourceTitle.startsWith("(branch) ")
      ? sourceTitle
      : `(branch) ${sourceTitle || sourceSessionId}`.trim();

    meta.session_id = newSessionId;
    meta.created_at = nowIso;
    meta.last_active_at = nowIso;
    meta.title = branchTitle;
    meta.forked_from_session_id = sourceSessionId;
    meta.prompt_cache_affinity_key = forkedCacheKey;
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    if (hasJsonl) {
      const raw = readFileSync(jsonlPath, "utf-8");
      const newline = raw.indexOf("\n");
      const firstLine = newline >= 0 ? raw.slice(0, newline) : raw;
      const rest = newline >= 0 ? raw.slice(newline + 1) : "";
      const record = parseRecordLine(firstLine);
      if (record.op !== "session") {
        throw new Error("session.fork: log.jsonl does not start with a session record");
      }
      record.session = {
        ...record.session,
        session_id: newSessionId,
        created_at: nowIso,
        updated_at: nowIso,
        title: branchTitle,
        forked_from_session_id: sourceSessionId,
        prompt_cache_affinity_key: forkedCacheKey,
      };
      const normalizedRest = rest === "" || rest.endsWith("\n") ? rest : `${rest}\n`;
      writeFileSync(jsonlPath, `${serializeRecord(record)}\n${normalizedRest}`);
    } else if (logData) {
      logData.session_id = newSessionId;
      logData.created_at = nowIso;
      logData.updated_at = nowIso;
      logData.title = branchTitle;
      logData.forked_from_session_id = sourceSessionId;
      logData.prompt_cache_affinity_key = forkedCacheKey;
      writeFileSync(logPath, `${JSON.stringify(logData, null, 2)}\n`);
    }

    return {
      sessionId: newSessionId,
      sessionDir: newDir,
      title: branchTitle,
      sourceSessionId,
    };
  } catch (err) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`session.fork: metadata patch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${basename(filePath)} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
