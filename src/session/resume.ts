import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "../config/home-dir.js";
import { loadLog } from "../config/log-serialization.js";
import { LOG_JSONL_FILENAME, LOG_JSONL_VERSION, loadModelContext, readLogJsonlVersion } from "../config/log-jsonl.js";
import { validateAndRepairLog } from "../config/log-repair.js";
import { listSessionsInProject, type SessionInfo } from "../config/session-list.js";
import type { SessionStore } from "../config/session-store.js";
import type { Session } from "../session.js";
import { createUiText, getUiLanguage } from "../ui/text.js";

export type { SessionInfo };
export { listSessionsInProject as listSessionsForProject };

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

/** 格式化字节大小为人类可读格式 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
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

/**
 * 按名称（title/summary）在指定项目目录中查找会话。
 * 匹配优先级：title 精确匹配 → title 包含 → summary 包含。
 */
export function findSessionByName(
  name: string,
  projectDir: string,
): { sessionId: string; path: string; title?: string } | null {
  const sessions = listSessionsInProject(projectDir);
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

function legacyLogJsonlVersion(sessionDir: string): number | undefined {
  const file = join(sessionDir, LOG_JSONL_FILENAME);
  return existsSync(file) ? readLogJsonlVersion(sessionDir) : undefined;
}

/**
 * 将会话日志加载到现有（ freshly bootstrapped）Session 中，
 * 交换其历史记录、模型、标题等。存储绑定到恢复的目录。
 *
 * 用于 `swarmflow --resume <id>` CLI 标志（通过 bootstrap 后的 main.tsx）。
 */
export async function applySessionRestore(
  session: Session,
  store: SessionStore,
  sessionDir: string,
  opts: { fork?: boolean } = {},
): Promise<RestoreResult> {
  const logJsonPath = join(sessionDir, "log.json");
  const logJsonlPath = join(sessionDir, "log.jsonl");
  if (!existsSync(logJsonPath) && !existsSync(logJsonlPath)) {
    return { ok: false, warnings: [], error: "No log.json or log.jsonl found for this session." };
  }

  const alreadyHeld = store.holdsSessionLock(sessionDir);
  const lock = await store.acquireSessionLock(sessionDir);
  if (!lock.ok) {
    return {
      ok: false,
      warnings: [],
      error: createUiText(getUiLanguage()).get(["Error", "sessionBusy"]),
    };
  }

  const legacyVersion = legacyLogJsonlVersion(sessionDir);
  if (legacyVersion !== undefined && legacyVersion !== LOG_JSONL_VERSION) {
    if (!alreadyHeld) store.releaseSessionLock(sessionDir);
    return {
      ok: false,
      warnings: [],
      error:
        `E_COMPACT_FORMAT_LEGACY: log.jsonl version ${legacyVersion} is not supported by this runtime. `
        + "Run `swarmflow sessions migrate-compact <id>` before resuming it.",
    };
  }

  let logData;
  try {
    logData = existsSync(join(sessionDir, LOG_JSONL_FILENAME))
      ? loadModelContext(sessionDir)
      : loadLog(sessionDir);
  } catch (e) {
    if (!alreadyHeld) store.releaseSessionLock(sessionDir);
    return {
      ok: false,
      warnings: [],
      error: `Failed to load log: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const legacyMarker = logData.entries.some((entry) =>
    entry.type === "compact_marker"
    && !entry.discarded
    && typeof (entry.meta as Record<string, unknown>)["checkpointId"] !== "string");
  let hasLegacyArchive = false;
  try {
    const archiveDir = join(sessionDir, "archive");
    hasLegacyArchive = existsSync(archiveDir)
      && readdirSync(archiveDir).some((name) => /^window-\d+(?:\.index)?\.json\.gz$/.test(name));
  } catch { /* no archive dir */ }
  const hasArchivedEntriesWithoutCheckpoint = logData.entries.some((entry) => entry.archived)
    && !logData.entries.some((entry) =>
      entry.type === "compact_marker"
      && !entry.discarded
      && typeof (entry.meta as Record<string, unknown>)["checkpointId"] === "string");
  if (legacyMarker || hasLegacyArchive || hasArchivedEntriesWithoutCheckpoint) {
    if (!alreadyHeld) store.releaseSessionLock(sessionDir);
    return {
      ok: false,
      warnings: [],
      error:
        "E_COMPACT_FORMAT_LEGACY: this session uses the legacy compact format. "
        + "Run `swarmflow sessions migrate-compact <id>` before resuming it.",
    };
  }

  const { entries: repairedEntries, repaired, warnings: repairWarnings } = validateAndRepairLog(logData.entries);
  const warnings: string[] = [];
  if (repaired) {
    for (const w of repairWarnings) warnings.push(`[repair] ${w}`);
  }

  const bindingState = store.captureBindingState();
  try {
    let rewindRecovered = false;
    store.attachToExistingSession(sessionDir);
    if (typeof (session as { setStore?: (s: SessionStore) => void }).setStore === "function") {
      (session as { setStore: (s: SessionStore) => void }).setStore(store);
    }
    const prepared = session.prepareRestoreFromLog(logData.meta, repairedEntries, logData.idAllocator, {
      bounded: logData.bounded === true,
    });
    const restoreWarnings = session.commitPreparedRestore(prepared);
    if (logData.bounded && logData.meta.persistencePolicy !== 3) {
      // 旧 policy 会在下一次保存做整份归一化；有界条目不足以重写完整历史。
      logData = loadLog(sessionDir);
      warnings.push("[load] legacy persistence policy; loaded the full log to keep history intact");
      const fullPrepared = session.prepareRestoreFromLog(logData.meta, logData.entries, logData.idAllocator, {
        bounded: false,
      });
      session.commitPreparedRestore(fullPrepared);
    } else if (logData.bounded && logData.windowStartOffset !== undefined) {
      session.enableBoundedHistory(logData.windowStartOffset);
    } else {
      warnings.push("[load] model context is unbounded (no live marker or missing counters); loaded the full log");
    }
    for (const w of restoreWarnings) warnings.push(`[resume] ${w}`);
    try {
      rewindRecovered = session.recoverRewindIfNeeded();
    } catch (e) {
      warnings.push(`[rewind] recovery failed; the journal was retained: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 启动对账：重启后子代理一律视为已终止，只按阈值判定是否值得断点续跑。
    // 必须在这里（子会话提交之后）：阈值指标来自恢复出的子日志。
    try {
      const reconcile = session.reconcileTaskListAfterRestore({ fork: opts.fork === true });
      for (const w of reconcile.warnings) warnings.push(`[tasks] ${w}`);
      if (reconcile.notice) session.deliverRestoreNotice(reconcile.notice);
    } catch (e) {
      warnings.push(`[tasks] reconciliation failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (rewindRecovered) {
      try {
        if (!session.persistToDisk()) throw new Error("session directory is not bound");
        session.finalizeRewindJournal();
      } catch (e) {
        warnings.push(`[rewind] recovery log could not be saved; the journal was retained: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    store.restoreBindingState(bindingState);
    if (!alreadyHeld) store.releaseSessionLock(sessionDir);
    return {
      ok: false,
      warnings,
      error: `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 重新附加（防御性：prepareRestoreFromLog 在某些错误路径下可能使 store 处于中间状态）。
  store.attachToExistingSession(sessionDir);
  store.releaseOtherSessionLocks(sessionDir);
  return { ok: true, warnings };
}
