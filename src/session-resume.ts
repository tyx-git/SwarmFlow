import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { loadLog, validateAndRepairLog, type SessionStore } from "./config/persistence.js";
import type { Session } from "./session.js";

/**
 * 磁盘上的一个 swarmflow 会话。由 `findSessionById` 暴露。
 */
export interface FoundSession {
  /** 会话目录的绝对路径。 */
  sessionDir: string;
  /** 包含此会话的项目目录的绝对路径。 */
  projectDir: string;
  /** 项目的原始 cwd（来自 project.json），如果可用。 */
  projectPath: string | undefined;
  /** 来自 meta.json 的标题，如果可用。 */
  title: string | undefined;
}

/** 用于名称匹配的会话信息。 */
export interface SessionInfo {
  sessionId: string;
  path: string;
  created: string;
  lastActiveAt: string;
  summary: string;
  title?: string;
  turns: number;
}

/** 会话 UUID 格式正则。 */
const LOOKS_LIKE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 在 swarmflow 主目录的所有项目中按 UUID 查找会话。
 * 如果没有项目包含此名称的目录，则返回 null。
 */
export function findSessionById(sessionId: string, homeDir?: string): FoundSession | null {
  const base = homeDir ?? getSwarmflowHomeDir();
  const projectsRoot = join(base, "projects");
  if (!existsSync(projectsRoot)) return null;

  for (const projectName of readdirSync(projectsRoot)) {
    const projectDir = join(projectsRoot, projectName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const sessionDir = join(projectDir, sessionId);
    if (!existsSync(sessionDir)) continue;
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let projectPath: string | undefined;
    try {
      const projectJson = JSON.parse(readFileSync(join(projectDir, "project.json"), "utf-8"));
      projectPath = typeof projectJson.original_path === "string" && projectJson.original_path.length > 0
        ? projectJson.original_path
        : undefined;
    } catch {
      // 可选
    }

    let title: string | undefined;
    try {
      const meta = JSON.parse(readFileSync(join(sessionDir, "meta.json"), "utf-8"));
      if (typeof meta.title === "string" && meta.title.length > 0) title = meta.title;
    } catch {
      // 可选
    }

    return { sessionDir, projectDir, projectPath, title };
  }
  return null;
}

/**
 * 列出指定项目目录中的所有会话，按最后活跃时间降序排列。
 * 不依赖 SessionStore 实例。
 */
export function listSessionsForProject(projectDir: string): SessionInfo[] {
  if (!existsSync(projectDir)) return [];

  const sessions: SessionInfo[] = [];
  const entries = readdirSync(projectDir).sort().reverse();

  for (const name of entries) {
    if (!LOOKS_LIKE_SESSION_ID.test(name)) continue;
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
        const created = (raw.created_at as string) ?? "";
        const lastActiveAt = (raw.last_active_at as string) ?? created;
        const summary = (raw.summary as string) ?? "";
        const title = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : undefined;
        const turns = (raw.turn_count as number) ?? 0;
        if (turns === 0) continue;
        if (raw.archived) continue;
        sessions.push({ sessionId: name, path: d, created, lastActiveAt, summary, title, turns });
        continue;
      } catch {
        // Fall through to log.json
      }
    }

    // 回退到 log.json
    const logFile = join(d, "log.json");
    if (!existsSync(logFile)) continue;
    try {
      const raw = JSON.parse(readFileSync(logFile, "utf-8"));
      const created = (raw["created_at"] as string) ?? "";
      const lastActiveAt = (raw["updated_at"] as string) ?? created;
      const summary = (raw["summary"] as string) ?? "";
      const title = typeof raw["title"] === "string" && raw["title"].length > 0 ? raw["title"] : undefined;
      const turns = (raw["turn_count"] as number) ?? 0;
      if (turns === 0) continue;
      if (raw.archived) continue;
      sessions.push({ sessionId: name, path: d, created, lastActiveAt, summary, title, turns });
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

/**
 * 按名称（title/summary）在指定项目目录中查找会话。
 * 匹配优先级：title 精确匹配 → title 包含 → summary 包含。
 */
export function findSessionByName(
  name: string,
  projectDir: string,
): { sessionId: string; path: string; title?: string } | null {
  const sessions = listSessionsForProject(projectDir);
  if (sessions.length === 0) return null;

  const lower = name.toLowerCase();

  // 1. title 精确匹配
  const exact = sessions.find((s) => s.title?.toLowerCase() === lower);
  if (exact) return { sessionId: exact.sessionId, path: exact.path, title: exact.title };

  // 2. title 包含匹配
  const titleContains = sessions.find((s) => s.title?.toLowerCase().includes(lower));
  if (titleContains) return { sessionId: titleContains.sessionId, path: titleContains.path, title: titleContains.title };

  // 3. summary 包含匹配
  const summaryContains = sessions.find((s) => s.summary.toLowerCase().includes(lower));
  if (summaryContains) return { sessionId: summaryContains.sessionId, path: summaryContains.path, title: summaryContains.title };

  return null;
}

export interface RestoreResult {
  ok: boolean;
  warnings: string[];
  error?: string;
}

/**
 * 将会话日志加载到现有（ freshly bootstrapped）Session 中，
 * 交换其历史记录、模型、标题等。存储绑定到恢复的目录。
 *
 * 用于：
 *   —`/session <id>` 斜杠命令（通过 cmdResume）
 *   —`swarmflow --resume <id>` CLI 标志（通过 bootstrap 后的 main.tsx）
 */
export function applySessionRestore(
  session: Session,
  store: SessionStore,
  sessionDir: string,
): RestoreResult {
  const logJsonPath = join(sessionDir, "log.json");
  if (!existsSync(logJsonPath)) {
    return { ok: false, warnings: [], error: "No log.json found for this session." };
  }

  let logData;
  try {
    logData = loadLog(sessionDir);
  } catch (e) {
    return {
      ok: false,
      warnings: [],
      error: `Failed to load log: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const { entries: repairedEntries, repaired, warnings: repairWarnings } = validateAndRepairLog(logData.entries);
  const warnings: string[] = [];
  if (repaired) {
    for (const w of repairWarnings) warnings.push(`[repair] ${w}`);
  }

  const bindingState = store.captureBindingState();
  try {
    store.attachToExistingSession(sessionDir);
    if (typeof (session as { setStore?: (s: SessionStore) => void }).setStore === "function") {
      (session as { setStore: (s: SessionStore) => void }).setStore(store);
    }
    const prepared = session.prepareRestoreFromLog(logData.meta, repairedEntries, logData.idAllocator);
    const restoreWarnings = session.commitPreparedRestore(prepared);
    for (const w of restoreWarnings) warnings.push(`[resume] ${w}`);
  } catch (e) {
    store.restoreBindingState(bindingState);
    return {
      ok: false,
      warnings,
      error: `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 重新附加（防御性：prepareRestoreFromLog 在某些错误路径下可能使 store 处于中间状态）。
  store.attachToExistingSession(sessionDir);
  return { ok: true, warnings };
}