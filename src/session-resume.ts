import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { loadLog, validateAndRepairLog, type SessionStore } from "./config/persistence.js";
import type { Session } from "./session.js";

/**
 * One swarmflow session located on disk. Exposed by `findSessionById`.
 */
export interface FoundSession {
  /** Absolute path to the session directory. */
  sessionDir: string;
  /** Absolute path to the project directory containing this session. */
  projectDir: string;
  /** Original cwd of the project (from project.json), if available. */
  projectPath: string | undefined;
  /** Title from meta.json, if available. */
  title: string | undefined;
}

/**
 * Look up a session by its UUID across all projects in the swarmflow home.
 * Returns null if no project contains a directory with this name.
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
      // optional
    }

    let title: string | undefined;
    try {
      const meta = JSON.parse(readFileSync(join(sessionDir, "meta.json"), "utf-8"));
      if (typeof meta.title === "string" && meta.title.length > 0) title = meta.title;
    } catch {
      // optional
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
 * Load a session log into an existing (freshly bootstrapped) Session, swapping
 * in its history, model, title, etc. The store is rebound to the resumed dir.
 *
 * Used by both:
 *   鈥?the `/session <id>` slash command (via cmdResume)
 *   鈥?the `swarmflow --resume <id>` CLI flag (via main.tsx after bootstrap)
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

  // Re-attach (defensive: prepareRestoreFromLog may have left store in an
  // intermediate state under some error paths).
  store.attachToExistingSession(sessionDir);
  return { ok: true, warnings };
}

