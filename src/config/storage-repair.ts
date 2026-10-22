/**
 * 存储修复：补齐缺失的 project.json 与 meta.json。
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeSessionId, resolvePreferredBaseDir } from "./storage-layout.js";
import { nowTimestamps } from "./timestamps.js";
import type { SessionMetaSummary } from "./session-meta.js";

// ------------------------------------------------------------------
// fixStorage——修复缺失的 project.json 和 meta.json
// ------------------------------------------------------------------

/** 存储修复结果 */
export interface FixStorageResult {
  /** 检查的项目数 */
  projectsChecked: number;
  /** 修复的项目数 */
  projectsFixed: number;
  /** 检查的会话数 */
  sessionsChecked: number;
  /** 修复的会话数 */
  sessionsFixed: number;
  /** 修复过程中产生的警告信息 */
  warnings: string[];
}

/** 修复存储中的缺失文件（project.json、meta.json） */
export function fixStorage(baseDir?: string): FixStorageResult {
  const resolvedBase = resolvePreferredBaseDir(baseDir);
  const projectsDir = join(resolvedBase, "projects");

  const result: FixStorageResult = {
    projectsChecked: 0,
    projectsFixed: 0,
    sessionsChecked: 0,
    sessionsFixed: 0,
    warnings: [],
  };

  if (!existsSync(projectsDir)) return result;

  for (const projectName of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch { continue; }

    result.projectsChecked++;

    // 检查/创建 project.json
    const projectJson = join(projectDir, "project.json");
    let projectData: Record<string, unknown>;
    if (!existsSync(projectJson)) {
      projectData = {
        original_path: "",
        created_at: nowTimestamps().utcIso,
        last_active_at: "",
      };
      writeFileSync(projectJson, JSON.stringify(projectData, null, 2));
      result.projectsFixed++;
      result.warnings.push(`Created missing project.json for ${projectName} (original_path unknown)`);
    } else {
      try {
        projectData = JSON.parse(readFileSync(projectJson, "utf-8"));
      } catch {
        result.warnings.push(`Could not parse project.json for ${projectName}`);
        continue;
      }
    }

    // 扫描会话并修复 meta.json
    let latestActiveAt = "";
    for (const sessionName of readdirSync(projectDir)) {
      if (!looksLikeSessionId(sessionName)) continue;
      const sessionDir = join(projectDir, sessionName);
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
      } catch { continue; }

      result.sessionsChecked++;

      const metaFile = join(sessionDir, "meta.json");
      const logFile = join(sessionDir, "log.json");

      if (!existsSync(metaFile)) {
        if (existsSync(logFile)) {
          try {
            const raw = JSON.parse(readFileSync(logFile, "utf-8"));
            const payload: SessionMetaSummary = {
              session_id: (raw.session_id as string | undefined) ?? sessionName,
              created_at: raw.created_at ?? "",
              last_active_at: raw.updated_at ?? "",
              summary: raw.summary ?? "",
              title: raw.title ?? undefined,
              turn_count: raw.turn_count ?? 0,
            };
            const tmp = metaFile + ".tmp";
            writeFileSync(tmp, JSON.stringify(payload, null, 2));
            renameSync(tmp, metaFile);
            result.sessionsFixed++;

            if (payload.last_active_at > latestActiveAt) {
              latestActiveAt = payload.last_active_at;
            }
          } catch {
            result.warnings.push(`Could not parse log.json for ${projectName}/${sessionName}`);
          }
        } else {
          result.warnings.push(`No log.json or meta.json for ${projectName}/${sessionName}`);
        }
      } else {
        // meta.json 存在——跟踪最新的用于项目级更新
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
          const activeAt = raw.last_active_at ?? "";
          if (activeAt > latestActiveAt) {
            latestActiveAt = activeAt;
          }
        } catch { /* skip */ }
      }
    }

    // 如果 project.json 的 last_active_at 缺失或过时则更新
    if (latestActiveAt && projectData.last_active_at !== latestActiveAt) {
      projectData.last_active_at = latestActiveAt;
      try {
        const tmp = projectJson + ".tmp";
        writeFileSync(tmp, JSON.stringify(projectData, null, 2));
        renameSync(tmp, projectJson);
        result.projectsFixed++;
      } catch { /* skip */ }
    }
  }

  return result;
}
