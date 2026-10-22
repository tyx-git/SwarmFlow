/**
 * SessionStore——会话目录的创建、绑定与列举。
 *
 * 存储布局：
 *
 *   <base_dir>/
 *   └── projects/
 *       ├── <project_slug>/           # <dir_name>_<sha256[:6]>
 *       │   ├── project.json
 *       │   ├── <session_uuid_v7>/    # 例如 019de786-1e41-7d21-b1e6-43919a4be1ce
 *       │   │   ├── log.json
 *       │   │   ├── meta.json
 *       │   │   └── artifacts/
 *       │   └── ...
 *       └── general/                  # 无项目路径的会话
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { looksLikeSessionId, projectSlug, randomSessionId, resolvePreferredBaseDir } from "./storage-layout.js";
import { nowTimestamps, toLocalIsoFromUtc } from "./timestamps.js";

// ------------------------------------------------------------------
// SessionStore——会话存储管理
// ------------------------------------------------------------------

export class SessionStore {
  private _projectPath: string | undefined;
  private _projectSlug: string;
  private _preferredBaseDir: string;
  private _activeBaseDir: string | undefined;
  private _projectDir: string;
  private _sessionDir: string | undefined;
  private _predictedSessionDir: string | undefined;

  constructor(opts?: { projectPath?: string; baseDir?: string }) {
    // 元数据与 slug 都保存绝对路径，避免 GUI 传入 `.` 时与 TUI 的 cwd 不一致。
    this._projectPath = opts?.projectPath ? resolve(opts.projectPath) : undefined;
    this._projectSlug = this._projectPath
      ? projectSlug(this._projectPath)
      : "general";
    this._preferredBaseDir = resolvePreferredBaseDir(opts?.baseDir);
    this._projectDir = join(this._preferredBaseDir, "projects", this._projectSlug);
  }

  // -- 生命周期 --

  /** 返回候选的基础目录列表（首选目录 + 临时目录） */
  private _candidateBaseDirs(): string[] {
    const candidates = [
      this._preferredBaseDir,
      join(tmpdir(), "swarmflow", "sessions"),
    ];
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      dedup.push(c);
    }
    return dedup;
  }

  /** 确保项目元数据文件存在，不存在则创建 */
  private _ensureProjectMetadata(projectDir: string): void {
    const projectJson = join(projectDir, "project.json");
    if (existsSync(projectJson)) return;
    const now = nowTimestamps().utcIso;
    writeFileSync(
      projectJson,
      JSON.stringify(
        {
          original_path: this._projectPath ?? "",
          created_at: now,
          last_active_at: now,
        },
        null,
        2,
      ),
    );
  }

  /** 查找唯一的会话目录，UUIDv7 碰撞概率极低，发生时重新生成 */
  private static _findUniqueSessionDir(projectDir: string): string {
    // UUIDv7 碰撞概率极低；如果发生，只需重新生成。
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = join(projectDir, randomSessionId());
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error("Failed to allocate a unique session directory.");
  }

  /** 创建新的会话目录结构，返回会话目录路径 */
  createSession(): string {
    const errors: string[] = [];

    for (const baseDir of this._candidateBaseDirs()) {
      const projectDir = join(baseDir, "projects", this._projectSlug);
      try {
        mkdirSync(projectDir, { recursive: true });
        this._ensureProjectMetadata(projectDir);
        let sessionDir = this._predictedSessionDir;
        if (!sessionDir || dirname(sessionDir) !== projectDir || existsSync(sessionDir)) {
          sessionDir = SessionStore._findUniqueSessionDir(projectDir);
        }
        mkdirSync(sessionDir, { recursive: true });
        mkdirSync(join(sessionDir, "artifacts"), { recursive: true });

        this._activeBaseDir = baseDir;
        this._projectDir = projectDir;
        this._sessionDir = sessionDir;
        this._predictedSessionDir = undefined;

        if (baseDir !== this._preferredBaseDir) {
          console.warn(
            `SessionStore fallback active: preferred '${this._preferredBaseDir}' not writable, using '${baseDir}'`,
          );
        }
        return sessionDir;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
        continue;
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no candidate paths available";
    throw new Error(`Unable to create session storage directory. Tried: ${detail}`);
  }

  /** 清除当前会话目录（用于 /new 延迟创建） */
  clearSession(): void {
    this._sessionDir = undefined;
    this._predictedSessionDir = undefined;
  }

  /** 捕获当前绑定状态快照 */
  captureBindingState(): {
    activeBaseDir: string | undefined;
    projectDir: string;
    sessionDir: string | undefined;
    predictedSessionDir: string | undefined;
  } {
    return {
      activeBaseDir: this._activeBaseDir,
      projectDir: this._projectDir,
      sessionDir: this._sessionDir,
      predictedSessionDir: this._predictedSessionDir,
    };
  }

  /** 从快照恢复绑定状态 */
  restoreBindingState(state: {
    activeBaseDir: string | undefined;
    projectDir: string;
    sessionDir: string | undefined;
    predictedSessionDir: string | undefined;
  }): void {
    this._activeBaseDir = state.activeBaseDir;
    this._projectDir = state.projectDir;
    this._sessionDir = state.sessionDir;
    this._predictedSessionDir = state.predictedSessionDir;
  }

  /** 附加到现有会话目录 */
  attachToExistingSession(sessionDir: string): void {
    this._sessionDir = sessionDir;
    this._predictedSessionDir = undefined;
    this._projectDir = dirname(sessionDir);

    const projectsDir = dirname(this._projectDir);
    if (basename(projectsDir) === "projects") {
      this._activeBaseDir = dirname(projectsDir);
    }
  }

  /** 预测下一个会话目录路径（不创建，仅预测） */
  predictNextSessionDir(): string {
    if (this._sessionDir) return this._sessionDir;
    if (this._predictedSessionDir) return this._predictedSessionDir;

    const errors: string[] = [];
    for (const baseDir of this._candidateBaseDirs()) {
      const projectDir = join(baseDir, "projects", this._projectSlug);
      try {
        mkdirSync(projectDir, { recursive: true });
        this._ensureProjectMetadata(projectDir);
        const sessionDir = SessionStore._findUniqueSessionDir(projectDir);
        this._activeBaseDir = baseDir;
        this._projectDir = projectDir;
        this._predictedSessionDir = sessionDir;
        return sessionDir;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no candidate paths available";
    throw new Error(`Unable to predict session storage directory. Tried: ${detail}`);
  }

  /** 预测下一个工件目录路径 */
  predictNextArtifactsDir(): string {
    return join(this.predictNextSessionDir(), "artifacts");
  }

  /** 列出当前项目的所有会话，按最后活跃时间降序排列 */
  listSessions(): Array<{ sessionId: string; path: string; created: string; lastActiveAt: string; summary: string; title?: string; turns: number }> {
    if (!existsSync(this._projectDir)) return [];

    const sessions: Array<{ sessionId: string; path: string; created: string; lastActiveAt: string; summary: string; title?: string; turns: number }> = [];
    const entries = readdirSync(this._projectDir).sort().reverse();

    for (const name of entries) {
      if (!looksLikeSessionId(name)) continue;
      const d = join(this._projectDir, name);
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
          const summary = raw.summary ?? "";
          const title = raw.title ?? undefined;
          const turns = raw.turn_count ?? 0;
          const sessionId = (raw.session_id as string | undefined) || name;
          // 跳过空会话（0 轮）和已归档的会话
          if (turns === 0) continue;
          if (raw.archived) continue;
          sessions.push({ sessionId, path: d, created, lastActiveAt, summary, title, turns });
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
        const createdUtc = (raw["created_at"] as string) ?? "";
        const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
        const lastActiveUtc = (raw["updated_at"] as string) ?? createdUtc;
        const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
        const summary = raw["summary"] ?? "";
        const title = raw["title"] ?? undefined;
        const turns = raw["turn_count"] ?? 0;
        const sessionId = (raw["session_id"] as string | undefined) || name;
        // Skip empty sessions (0 turns) and archived sessions
        if (turns === 0) continue;
        if (raw.archived) continue;
        sessions.push({ sessionId, path: d, created, lastActiveAt, summary, title, turns });
      } catch {
        continue;
      }
    }

    // 按最后活跃时间降序排列（最近活跃的排在前面）
    sessions.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return sessions;
  }

  /** 列出存储目录中的所有项目，按最后活跃时间降序排列 */
  listProjects(): Array<{
    slug: string;
    originalPath: string;
    createdAt: string;
    lastActiveAt: string;
  }> {
    const projectsDir = join(this._preferredBaseDir, "projects");
    if (!existsSync(projectsDir)) return [];

    const result: Array<{
      slug: string;
      originalPath: string;
      createdAt: string;
      lastActiveAt: string;
    }> = [];

    for (const name of readdirSync(projectsDir)) {
      const d = join(projectsDir, name);
      try {
        if (!statSync(d).isDirectory()) continue;
      } catch { continue; }

      const projectJson = join(d, "project.json");
      if (!existsSync(projectJson)) continue;

      try {
        const raw = JSON.parse(readFileSync(projectJson, "utf-8"));
        result.push({
          slug: name,
          originalPath: raw.original_path ?? "",
          createdAt: raw.created_at ?? "",
          lastActiveAt: raw.last_active_at ?? "",
        });
      } catch { continue; }
    }

    // 按 last_active_at 降序排列
    result.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return result;
  }

  /** 获取项目目录路径 */
  get projectDir(): string {
    return this._projectDir;
  }

  /** 获取工件目录路径，不存在时自动创建 */
  get artifactsDir(): string | undefined {
    if (!this._sessionDir) return undefined;
    const d = join(this._sessionDir, "artifacts");
    try {
      mkdirSync(d, { recursive: true });
    } catch (exc) {
      console.warn(`Failed to ensure artifacts directory '${d}': ${exc}`);
      return undefined;
    }
    return d;
  }

  /** 获取当前会话目录路径 */
  get sessionDir(): string | undefined {
    return this._sessionDir;
  }

  set sessionDir(value: string) {
    this._sessionDir = value;
  }

  /**
   * 扫描所有项目的每个会话的 log.json，汇总 token_update 条目。
   * 返回累计输入/输出/缓存/未缓存 token 数 + 会话数。
   * 为用量统计页设计——优雅地容忍损坏/缺失的文件。
   */
  computeGlobalTokenStats(): GlobalTokenStats {
    const projectsDir = join(this._preferredBaseDir, "projects");
    if (!existsSync(projectsDir)) return { cumulativeInput: 0, cumulativeOutput: 0, cumulativeCacheRead: 0, cumulativeUncached: 0, sessionCount: 0 };

    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCacheRead = 0;
    let cumulativeUncached = 0;
    let sessionCount = 0;

    for (const projectName of readdirSync(projectsDir)) {
      const projectDir = join(projectsDir, projectName);
      try { if (!statSync(projectDir).isDirectory()) continue; } catch { continue; }

      for (const sessionName of readdirSync(projectDir)) {
        const logFile = join(projectDir, sessionName, "log.json");
        try {
          if (!statSync(join(projectDir, sessionName)).isDirectory()) continue;
          const raw = JSON.parse(readFileSync(logFile, "utf-8"));
          const entries = raw.entries as Array<Record<string, unknown>> | undefined;
          if (!entries) continue;
          let hasTokens = false;
          for (const e of entries) {
            if (e.type !== "token_update") continue;
            const meta = e.meta as Record<string, unknown> | undefined;
            if (!meta) continue;
            const input = meta["input_tokens"] as number ?? meta["inputTokens"] as number ?? 0;
            if (!Number.isFinite(input) || input <= 0) continue;
            const total = (meta["total_tokens"] as number ?? meta["totalTokens"] as number ?? input) as number;
            const cacheRead = (meta["cache_read_tokens"] as number ?? meta["cacheReadTokens"] as number ?? 0) as number;
            cumulativeInput += input;
            cumulativeOutput += Math.max(0, total - input);
            cumulativeCacheRead += cacheRead;
            cumulativeUncached += Math.max(0, input - cacheRead);
            hasTokens = true;
          }
          if (hasTokens) sessionCount++;
        } catch { continue; }
      }
    }

    return { cumulativeInput, cumulativeOutput, cumulativeCacheRead, cumulativeUncached, sessionCount };
  }
}

/** 全局 token 统计数据 */
export interface GlobalTokenStats {
  /** 累计输入 token 数 */
  cumulativeInput: number;
  /** 累计输出 token 数 */
  cumulativeOutput: number;
  /** 累计缓存读取 token 数 */
  cumulativeCacheRead: number;
  /** 累计未缓存 token 数 */
  cumulativeUncached: number;
  /** 包含 token 数据的会话数 */
  sessionCount: number;
}
