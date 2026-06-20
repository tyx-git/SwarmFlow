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