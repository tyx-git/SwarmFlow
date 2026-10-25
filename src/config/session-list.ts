/**
 * 会话列表的单一权威实现。
 *
 * 顺序：meta.json → log.jsonl header → legacy log.json header。
 * 体积只统计已知类别，不递归 artifacts/。SessionStore 与 resume 都委托这里。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readLogHeader } from "./log-jsonl.js";
import { readLegacyLogHeader } from "./log-legacy.js";
import { looksLikeSessionId } from "./storage-layout.js";
import { toLocalIsoFromUtc } from "./timestamps.js";

export interface SessionInfo {
  sessionId: string;
  path: string;
  created: string;
  lastActiveAt: string;
  summary: string;
  title?: string;
  turns: number;
  /** 会话目录大小（只统计已知文件/目录，不含 artifacts）。 */
  sizeBytes: number;
}

/** 列表体积只统计这些已知文件与目录；`artifacts/` 随文件数线性增长，不参与。 */
const KNOWN_SIZE_FILES: ReadonlySet<string> = new Set([
  "log.jsonl",
  "log.json",
  "log.json.pre-v4.bak",
  "log.index.jsonl",
  "meta.json",
]);
const KNOWN_SIZE_DIRS: ReadonlySet<string> = new Set(["archive", "images", "sealed"]);

function knownDirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      try {
        const s = statSync(p);
        total += s.isDirectory() ? knownDirSize(p) : s.size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function sessionDirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      try {
        const s = statSync(p);
        if (s.isFile() && KNOWN_SIZE_FILES.has(entry)) {
          total += s.size;
        } else if (s.isDirectory() && KNOWN_SIZE_DIRS.has(entry)) {
          total += knownDirSize(p);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

/** 列出指定项目目录中的所有会话，按最后活跃时间降序排列。 */
export function listSessionsInProject(projectDir: string): SessionInfo[] {
  if (!existsSync(projectDir)) return [];

  const sessions: SessionInfo[] = [];
  const entries = readdirSync(projectDir).sort().reverse();

  for (const name of entries) {
    if (!looksLikeSessionId(name)) continue;
    const d = join(projectDir, name);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }

    // 优先使用 meta.json 进行快速列表
    const metaFile = join(d, "meta.json");
    if (existsSync(metaFile)) {
      try {
        const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
        const createdUtc = (raw.created_at as string) ?? "";
        const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
        const lastActiveUtc = (raw.last_active_at as string) ?? createdUtc;
        const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
        const summary = (raw.summary as string) ?? "";
        const title = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : undefined;
        const turns = (raw.turn_count as number) ?? 0;
        if (turns === 0) continue;
        if (raw.archived) continue;
        const sizeBytes = sessionDirSize(d);
        sessions.push({ sessionId: name, path: d, created, lastActiveAt, summary, title, turns, sizeBytes });
        continue;
      } catch {
        // Fall through to log header
      }
    }

    // 回退到 log.jsonl 头部（meta.json 缺失/损坏时）
    const jsonlFile = join(d, "log.jsonl");
    if (existsSync(jsonlFile)) {
      try {
        const header = readLogHeader(d);
        if (header.turnCount === 0) continue;
        const created = toLocalIsoFromUtc(header.createdAt) || header.createdAt;
        const lastActiveUtc = header.updatedAt || header.createdAt;
        const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
        sessions.push({
          sessionId: header.sessionId || name,
          path: d,
          created,
          lastActiveAt,
          summary: header.summary,
          title: header.title,
          turns: header.turnCount,
          sizeBytes: sessionDirSize(d),
        });
      } catch { /* ignore corrupt header */ }
      continue;
    }

    // 回退到 legacy log.json
    const logFile = join(d, "log.json");
    if (!existsSync(logFile)) continue;
    try {
      const raw = readLegacyLogHeader(d);
      const createdUtc = (raw["created_at"] as string) ?? "";
      const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
      const lastActiveUtc = (raw["updated_at"] as string) ?? createdUtc;
      const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
      const summary = (raw["summary"] as string) ?? "";
      const title = typeof raw["title"] === "string" && raw["title"].length > 0 ? raw["title"] : undefined;
      const turns = (raw["turn_count"] as number) ?? 0;
      if (turns === 0) continue;
      if (raw.archived) continue;
      const sizeBytes = sessionDirSize(d);
      const sessionId = typeof raw["session_id"] === "string" && raw["session_id"].length > 0
        ? raw["session_id"]
        : name;
      sessions.push({ sessionId, path: d, created, lastActiveAt, summary, title, turns, sizeBytes });
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) => {
    if (!a.lastActiveAt && !b.lastActiveAt) return 0;
    if (!a.lastActiveAt) return 1;
    if (!b.lastActiveAt) return -1;
    return b.lastActiveAt.localeCompare(a.lastActiveAt);
  });

  return sessions;
}
